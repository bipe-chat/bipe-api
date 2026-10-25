// A Matrix bot account with its own end-to-end encrypted device (ADR 0115). The support bot (ADR 0114) and the
// Novidades bot (ADR 0117, ADR 0119) each run one, with their own token, device and key store.
// Never delete a key store: the bot loses its device keys and cannot read old messages.
// Never log a message text, a Matrix ID next to a text, or a token.
import { mkdirSync } from "node:fs";
// Types only at the top: the native library loads in boot(), so a broken binary turns the bot off, not the API.
import type { OlmMachine, RequestType, UserId } from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { Db } from "./db.js";

type Crypto = typeof import("@matrix-org/matrix-sdk-crypto-nodejs");
let sdk: Crypto;

const SYNC_TIMEOUT_MS = 30_000;

export type MatrixEvent = { type: string; sender: string; event_id: string; content: Record<string, unknown>; state_key?: string; origin_server_ts?: number };
export type JoinedRoom = { timeline?: { events?: MatrixEvent[] }; state?: { events?: MatrixEvent[] } };
type SyncResponse = {
  next_batch: string;
  to_device?: { events?: unknown[] };
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  rooms?: {
    join?: Record<string, JoinedRoom>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
};

export type BotAccount = {
  /** Log prefix, for example "support bot". */
  label: string;
  userId: string;
  token?: string;
  storeDir: string;
  passphrase?: string;
  synapseUrl: string;
  /** Table with one row (id 1) that keeps the sync position. */
  syncTable: "support_sync" | "news_sync";
};

export abstract class EncryptedBot {
  readonly enabled: boolean;
  private machine: OlmMachine | null = null;
  protected ready: Promise<void> | null = null;
  private stopped = false;

  constructor(
    protected readonly db: Db,
    protected readonly account: BotAccount,
  ) {
    this.enabled = !!account.token && !!account.passphrase;
  }

  get userId(): string {
    return this.account.userId;
  }

  /** Starts the device and the sync loop. Safe to call once. */
  start(): void {
    if (!this.enabled || this.ready) return;
    this.ready = this.boot();
    this.ready
      .then(() => {
        console.log(`${this.account.label}: ready`);
        void this.syncLoop();
        this.onReady();
      })
      .catch((e) => console.error(`${this.account.label}: start failed: ${(e as Error).message}`));
  }

  /** Runs once after the device is ready and the sync loop started. */
  protected onReady(): void {}

  /** Invites in one sync. */
  protected abstract onInvite(roomId: string, events: MatrixEvent[]): Promise<void>;

  /** Timeline events of a joined room, from the second sync on (the first sync only sets the position). */
  protected abstract onTimelineEvent(roomId: string, event: MatrixEvent): Promise<void>;

  private async boot(): Promise<void> {
    const who = await this.matrix<{ user_id: string; device_id?: string }>("GET", "/account/whoami");
    if (who.user_id !== this.userId) throw new Error("the access token belongs to another account");
    if (!who.device_id) throw new Error("the access token has no device");
    mkdirSync(this.account.storeDir, { recursive: true });
    sdk = await import("@matrix-org/matrix-sdk-crypto-nodejs");
    this.machine = await sdk.OlmMachine.initialize(
      new sdk.UserId(this.userId),
      new sdk.DeviceId(who.device_id),
      this.account.storeDir,
      this.account.passphrase,
    );
    await this.processOutgoing();
    // Element X sends room keys only to devices that their owner cross-signed. The first upload needs no
    // re-authentication because the account has no cross-signing keys yet.
    const status = await this.machine.crossSigningStatus();
    if (!status.hasMaster) {
      const boot = await this.machine.bootstrapCrossSigning(true);
      if (boot.uploadKeysReq) await this.send(boot.uploadKeysReq.id, sdk.RequestType.KeysUpload, "POST", "/keys/upload", boot.uploadKeysReq.body);
      await this.matrix("POST", "/keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysReq));
      await this.send(boot.uploadSignaturesReq.id, sdk.RequestType.SignatureUpload, "POST", "/keys/signatures/upload", signatureUploadBody(boot.uploadSignaturesReq.body));
      console.log(`${this.account.label}: cross-signing keys uploaded`);
      return;
    }
    // A device that the self-signing key did not sign gets no room keys from Element X. Before the
    // signed_keys fix the first boot uploaded the keys and lost the device signature. With reset false
    // the machine keeps its keys and signs the device again; the signing keys on the server stay.
    const own = await this.machine.getDevice(new sdk.UserId(this.userId), new sdk.DeviceId(who.device_id));
    if (!own?.isCrossSignedByOwner()) {
      const boot = await this.machine.bootstrapCrossSigning(false);
      await this.send(boot.uploadSignaturesReq.id, sdk.RequestType.SignatureUpload, "POST", "/keys/signatures/upload", signatureUploadBody(boot.uploadSignaturesReq.body));
      console.log(`${this.account.label}: device signed`);
    }
  }

  // ---- Sending -----------------------------------------------------------------------------------

  /** Sends an encrypted text into a room. txnId makes a retry idempotent. */
  async sendText(roomId: string, body: string, msgtype: "m.text" | "m.notice" = "m.text", txnId = `bipe-${Date.now()}-${Math.random().toString(36).slice(2)}`): Promise<void> {
    await this.ready;
    const machine = this.machine!;
    const room = new sdk.RoomId(roomId);
    const members = await this.joinedAndInvited(roomId);
    await machine.updateTrackedUsers(members);
    // Device keys of new members must be known before the room key goes out.
    await this.processOutgoing();
    const claim = await machine.getMissingSessions(members);
    if (claim) await this.send(claim.id, sdk.RequestType.KeysClaim, "POST", "/keys/claim", claim.body);
    const settings = new sdk.EncryptionSettings();
    for (const req of await machine.shareRoomKey(room, members, settings)) {
      await this.send(req.id, sdk.RequestType.ToDevice, "PUT", `/sendToDevice/${enc(req.eventType)}/${enc(req.txnId)}`, req.body);
    }
    const encrypted = await machine.encryptRoomEvent(room, "m.room.message", JSON.stringify({ msgtype, body }));
    await this.matrix("PUT", `/rooms/${enc(roomId)}/send/m.room.encrypted/${enc(txnId)}`, JSON.parse(encrypted));
  }

  private async joinedAndInvited(roomId: string): Promise<UserId[]> {
    const res = await this.matrix<{ chunk: MatrixEvent[] }>("GET", `/rooms/${enc(roomId)}/members?not_membership=leave`);
    return res.chunk
      .filter((e) => e.content.membership === "join" || e.content.membership === "invite")
      .map((e) => new sdk.UserId(e.state_key!));
  }

  /** The clear type and content of a timeline event, or null when it does not decrypt. */
  protected async clearEvent(roomId: string, event: MatrixEvent): Promise<{ type: string; content: Record<string, unknown> } | null> {
    if (event.type !== "m.room.encrypted") return { type: event.type, content: event.content };
    const decrypted = await this.machine!.decryptRoomEvent(JSON.stringify({ ...event, room_id: roomId }), new sdk.RoomId(roomId)).catch(() => null);
    if (!decrypted) return null;
    const clear = JSON.parse(decrypted.event) as { type: string; content: Record<string, unknown> };
    return { type: clear.type, content: clear.content };
  }

  /** The membership of a user in a room, or null when the bot cannot read it. */
  protected async membership(roomId: string, userId: string): Promise<string | null> {
    const member = await this.matrix<{ membership?: string }>("GET", `/rooms/${enc(roomId)}/state/m.room.member/${enc(userId)}`).catch(() => null);
    return member?.membership ?? null;
  }

  // ---- Sync --------------------------------------------------------------------------------------

  private async syncLoop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        await this.syncOnce();
        backoff = 1_000;
      } catch (e) {
        console.error(`${this.account.label}: sync failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async syncOnce(): Promise<void> {
    const machine = this.machine!;
    const table = this.account.syncTable;
    const { rows } = await this.db.query<{ since: string }>(`SELECT since FROM ${table} WHERE id = 1`);
    const since = rows[0]?.since;
    const filter = JSON.stringify({
      presence: { types: [] },
      account_data: { types: [] },
      room: { ephemeral: { types: [] }, account_data: { types: [] }, state: { lazy_load_members: true }, timeline: { limit: since ? 50 : 0 } },
    });
    const qs = new URLSearchParams({ filter, timeout: String(since ? SYNC_TIMEOUT_MS : 0) });
    if (since) qs.set("since", since);
    const sync = await this.matrix<SyncResponse>("GET", `/sync?${qs}`, undefined, SYNC_TIMEOUT_MS + 15_000);

    const lists = new sdk.DeviceLists(
      (sync.device_lists?.changed ?? []).map((u) => new sdk.UserId(u)),
      (sync.device_lists?.left ?? []).map((u) => new sdk.UserId(u)),
    );
    await machine.receiveSyncChanges(
      JSON.stringify(sync.to_device?.events ?? []),
      lists,
      sync.device_one_time_keys_count ?? {},
      sync.device_unused_fallback_key_types ?? [],
    );
    await this.processOutgoing();

    for (const [roomId, invite] of Object.entries(sync.rooms?.invite ?? {})) {
      await this.onInvite(roomId, invite.invite_state?.events ?? []).catch((e) => console.error(`${this.account.label}: invite failed: ${(e as Error).message}`));
    }
    // The first sync only sets the position: older messages are not sent again.
    if (since) {
      for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
        for (const event of room.timeline?.events ?? []) {
          await this.onTimelineEvent(roomId, event).catch((e) => console.error(`${this.account.label}: event failed: ${(e as Error).message}`));
        }
      }
    }
    await this.db.query(
      `INSERT INTO ${table} (id, since) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET since = EXCLUDED.since, updated_at = now()`,
      [sync.next_batch],
    );
  }

  // ---- Matrix plumbing ---------------------------------------------------------------------------

  private async processOutgoing(): Promise<void> {
    for (const req of await this.machine!.outgoingRequests()) {
      switch (req.type) {
        case sdk.RequestType.KeysUpload:
          await this.send(req.id, req.type, "POST", "/keys/upload", req.body);
          break;
        case sdk.RequestType.KeysQuery:
          await this.send(req.id, req.type, "POST", "/keys/query", req.body);
          break;
        case sdk.RequestType.KeysClaim:
          await this.send(req.id, req.type, "POST", "/keys/claim", req.body);
          break;
        case sdk.RequestType.SignatureUpload:
          await this.send(req.id, req.type, "POST", "/keys/signatures/upload", signatureUploadBody(req.body));
          break;
        case sdk.RequestType.ToDevice: {
          const r = req as unknown as { eventType: string; txnId: string };
          await this.send(req.id, req.type, "PUT", `/sendToDevice/${enc(r.eventType)}/${enc(r.txnId)}`, req.body);
          break;
        }
        case sdk.RequestType.RoomMessage: {
          const r = req as unknown as { roomId: string; eventType: string; txnId: string };
          await this.send(req.id, req.type, "PUT", `/rooms/${enc(r.roomId)}/send/${enc(r.eventType)}/${enc(r.txnId)}`, req.body);
          break;
        }
        default:
          // Key backup is not used: the bot keeps its keys in its store directory.
          break;
      }
    }
  }

  private async send(id: string, type: RequestType, method: string, path: string, body: string): Promise<void> {
    const res = await this.matrix<unknown>(method, path, JSON.parse(body));
    await this.machine!.markRequestAsSent(id, type, JSON.stringify(res));
  }

  protected async matrix<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`${this.account.synapseUrl.replace(/\/$/, "")}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${this.account.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { errcode?: string };
      throw new Error(`matrix ${method} ${path.split("?")[0]!.split("/").slice(0, 3).join("/")}: HTTP ${res.status} ${err.errcode ?? ""}`.trim());
    }
    return (await res.json()) as T;
  }
}

export const enc = encodeURIComponent;

/**
 * The HTTP body of a SignatureUploadRequest. The crypto SDK wraps the user map in `signed_keys`; the
 * endpoint takes the user map itself. Synapse reads a wrapped body as a user named "signed_keys" and
 * answers a failure that the SDK cannot parse ("leading sigil is incorrect or missing").
 */
export function signatureUploadBody(body: string): string {
  const parsed = JSON.parse(body) as { signed_keys?: unknown };
  return parsed.signed_keys === undefined ? body : JSON.stringify(parsed.signed_keys);
}
