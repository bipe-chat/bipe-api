// Support DM bridged to Starlings (ADR 0114, ADR 0115, bipe#367, envisioning/starlings#1176).
// The API runs the support account (SUPPORT_USER_ID, "Suporte Bipe") as a bot with its own encrypted device:
// Synapse encrypts every room (encryption_enabled_by_default_for_room_type: all), so the bot takes part in E2EE
// through the Matrix Rust crypto bindings. Each user has one support room. Texts from the user go to the bipe
// Starlings workspace through the intake outbox (src/intake.ts); member replies come back signed and go into the room.
// Never log a message text, a Matrix ID next to a text, or a token.
import { mkdirSync } from "node:fs";
// Types only at the top: the native library loads in boot(), so a broken binary turns the bot off, not the API.
import type { OlmMachine, RequestType, UserId } from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Intake, IntakeBody } from "./intake.js";
import { appString } from "./registry.js";

type Crypto = typeof import("@matrix-org/matrix-sdk-crypto-nodejs");
let sdk: Crypto;

const SYNC_TIMEOUT_MS = 30_000;

type MatrixEvent = { type: string; sender: string; event_id: string; content: Record<string, unknown>; state_key?: string; origin_server_ts?: number };
type SyncResponse = {
  next_batch: string;
  to_device?: { events?: unknown[] };
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] }; state?: { events?: MatrixEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
};

export class SupportBot {
  readonly enabled: boolean;
  private machine: OlmMachine | null = null;
  private ready: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly intake: Intake,
  ) {
    this.enabled = !!config.SUPPORT_ACCESS_TOKEN && !!config.SUPPORT_STORE_PASSPHRASE;
  }

  get userId(): string {
    return this.config.SUPPORT_USER_ID;
  }

  /** Starts the device and the sync loop. Safe to call once. */
  start(): void {
    if (!this.enabled || this.ready) return;
    this.ready = this.boot();
    this.ready
      .then(() => {
        console.log("support bot: ready");
        void this.syncLoop();
      })
      .catch((e) => console.error(`support bot: start failed: ${(e as Error).message}`));
  }

  private async boot(): Promise<void> {
    const who = await this.matrix<{ user_id: string; device_id?: string }>("GET", "/account/whoami");
    if (who.user_id !== this.userId) throw new Error("SUPPORT_ACCESS_TOKEN belongs to another account");
    if (!who.device_id) throw new Error("the support token has no device");
    mkdirSync(this.config.SUPPORT_STORE_DIR, { recursive: true });
    sdk = await import("@matrix-org/matrix-sdk-crypto-nodejs");
    this.machine = await sdk.OlmMachine.initialize(
      new sdk.UserId(this.userId),
      new sdk.DeviceId(who.device_id),
      this.config.SUPPORT_STORE_DIR,
      this.config.SUPPORT_STORE_PASSPHRASE,
    );
    await this.processOutgoing();
    // Element X sends room keys only to devices that their owner cross-signed. The first upload needs no
    // re-authentication because the account has no cross-signing keys yet.
    const status = await this.machine.crossSigningStatus();
    if (!status.hasMaster) {
      const boot = await this.machine.bootstrapCrossSigning(true);
      if (boot.uploadKeysReq) await this.send(boot.uploadKeysReq.id, sdk.RequestType.KeysUpload, "POST", "/keys/upload", boot.uploadKeysReq.body);
      await this.matrix("POST", "/keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysReq));
      await this.send(boot.uploadSignaturesReq.id, sdk.RequestType.SignatureUpload, "POST", "/keys/signatures/upload", boot.uploadSignaturesReq.body);
      console.log("support bot: cross-signing keys uploaded");
    }
  }

  // ---- Rooms -------------------------------------------------------------------------------------

  /** The user's support room. Makes it on first use; invites the user again when they left. */
  async roomFor(userId: string): Promise<string> {
    if (!this.enabled) throw new ApiError("support_unavailable");
    await this.ready;
    const { rows } = await this.db.query<{ room_id: string }>("SELECT room_id FROM support_rooms WHERE user_id = $1", [userId]);
    if (rows[0]) {
      await this.reinviteIfGone(rows[0].room_id, userId);
      return rows[0].room_id;
    }
    const created = await this.matrix<{ room_id: string }>("POST", "/createRoom", {
      preset: "trusted_private_chat",
      is_direct: true,
      invite: [userId],
      name: appString("pt", "bipe_support_room_name"),
      topic: appString("pt", "bipe_support_room_topic"),
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    const { rows: kept } = await this.db.query<{ room_id: string }>(
      `INSERT INTO support_rooms (user_id, room_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING room_id`,
      [userId, created.room_id],
    );
    if (kept[0]!.room_id !== created.room_id) {
      // A parallel call won: leave the extra room.
      await this.matrix("POST", `/rooms/${enc(created.room_id)}/leave`, {}).catch(() => {});
      return kept[0]!.room_id;
    }
    await this.sendText(created.room_id, appString("pt", "bipe_support_welcome"), "m.notice");
    return created.room_id;
  }

  private async reinviteIfGone(roomId: string, userId: string): Promise<void> {
    const member = await this.matrix<{ membership?: string }>("GET", `/rooms/${enc(roomId)}/state/m.room.member/${enc(userId)}`).catch(() => null);
    if (member?.membership === "join" || member?.membership === "invite") return;
    await this.matrix("POST", `/rooms/${enc(roomId)}/invite`, { user_id: userId }).catch((e) =>
      console.error(`support bot: re-invite failed: ${(e as Error).message}`),
    );
  }

  /** A DM invite from a local user: it becomes their support room when they have none. */
  private async onInvite(roomId: string, events: MatrixEvent[]): Promise<void> {
    const invite = events.find((e) => e.type === "m.room.member" && e.state_key === this.userId);
    const inviter = invite?.sender;
    const local = inviter?.endsWith(`:${this.config.SERVER_NAME}`);
    const { rows } = await this.db.query<{ user_id: string; room_id: string }>(
      "SELECT user_id, room_id FROM support_rooms WHERE room_id = $1 OR user_id = $2",
      [roomId, inviter ?? ""],
    );
    const own = rows.find((r) => r.room_id === roomId);
    if (own) {
      await this.matrix("POST", `/join/${enc(roomId)}`, {});
      return;
    }
    const existing = rows.find((r) => r.user_id === inviter);
    if (!inviter || !local || existing) {
      await this.matrix("POST", `/rooms/${enc(roomId)}/leave`, {}).catch(() => {});
      if (existing) await this.sendText(existing.room_id, appString("pt", "bipe_support_already_open"), "m.notice").catch(() => {});
      return;
    }
    await this.matrix("POST", `/join/${enc(roomId)}`, {});
    await this.db.query("INSERT INTO support_rooms (user_id, room_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [inviter, roomId]);
    await this.sendText(roomId, appString("pt", "bipe_support_welcome"), "m.notice");
  }

  // ---- Sending -----------------------------------------------------------------------------------

  /** Sends an encrypted text into a support room. txnId makes a retry idempotent. */
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

  /** A member's reply from Starlings. A repeat message_id sends nothing. */
  async reply(input: { message_id: string; reporter_ref: string; text: string; author: { name: string } }): Promise<void> {
    if (!this.enabled) throw new ApiError("support_unavailable");
    const { rows } = await this.db.query<{ room_id: string }>("SELECT room_id FROM support_rooms WHERE user_id = $1", [input.reporter_ref]);
    if (!rows[0]) throw new ApiError("not_found");
    const fresh = await this.db.query("INSERT INTO support_replies (message_id) VALUES ($1) ON CONFLICT DO NOTHING", [input.message_id]);
    if (!fresh.rowCount) return;
    try {
      await this.reinviteIfGone(rows[0].room_id, input.reporter_ref);
      const name = input.author.name.replace(/\s+/g, " ").trim().slice(0, 120) || "Bipe";
      await this.sendText(rows[0].room_id, `${name} (Bipe): ${input.text}`, "m.text", `starlings-${input.message_id}`);
    } catch (e) {
      // Let Starlings retry: forget the message_id.
      await this.db.query("DELETE FROM support_replies WHERE message_id = $1", [input.message_id]);
      throw e;
    }
  }

  /** Posts a notice into the user's support room. Used after a problem report. */
  async notice(userId: string, body: string): Promise<void> {
    const roomId = await this.roomFor(userId);
    await this.sendText(roomId, body, "m.notice");
  }

  // ---- Sync --------------------------------------------------------------------------------------

  private async syncLoop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        await this.syncOnce();
        backoff = 1_000;
      } catch (e) {
        console.error(`support bot: sync failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async syncOnce(): Promise<void> {
    const machine = this.machine!;
    const { rows } = await this.db.query<{ since: string }>("SELECT since FROM support_sync WHERE id = 1");
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
      await this.onInvite(roomId, invite.invite_state?.events ?? []).catch((e) => console.error(`support bot: invite failed: ${(e as Error).message}`));
    }
    // The first sync only sets the position: older messages are not sent again.
    if (since) {
      for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
        for (const event of room.timeline?.events ?? []) {
          await this.onTimelineEvent(roomId, event).catch((e) => console.error(`support bot: event failed: ${(e as Error).message}`));
        }
      }
    }
    await this.db.query(
      "INSERT INTO support_sync (id, since) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET since = EXCLUDED.since, updated_at = now()",
      [sync.next_batch],
    );
  }

  private async onTimelineEvent(roomId: string, event: MatrixEvent): Promise<void> {
    if (event.sender === this.userId) return;
    const { rows } = await this.db.query<{ user_id: string }>("SELECT user_id FROM support_rooms WHERE room_id = $1", [roomId]);
    const owner = rows[0]?.user_id;
    if (!owner || event.sender !== owner) return;

    let content = event.content;
    let type = event.type;
    if (type === "m.room.encrypted") {
      const decrypted = await this.machine!.decryptRoomEvent(JSON.stringify({ ...event, room_id: roomId }), new sdk.RoomId(roomId)).catch(() => null);
      if (!decrypted) {
        console.error("support bot: could not decrypt a message");
        return;
      }
      const clear = JSON.parse(decrypted.event) as { type: string; content: Record<string, unknown> };
      type = clear.type;
      content = clear.content;
    }
    if (type !== "m.room.message" || content["m.relates_to"] && (content["m.relates_to"] as { rel_type?: string }).rel_type === "m.replace") return;
    const text = lineText(content);
    if (!text) return;
    await this.intake.enqueue({ message_id: event.event_id, kind: "message", reporter: await this.reporter(owner), text });
  }

  /** The reporter's handle and display name, best effort. */
  async reporter(userId: string): Promise<IntakeBody["reporter"]> {
    const out: IntakeBody["reporter"] = { ref: userId };
    const { rows } = await this.db.query<{ handle: string }>("SELECT handle FROM handles WHERE user_id = $1", [userId]).catch(() => ({ rows: [] as { handle: string }[] }));
    if (rows[0]) out.handle = rows[0].handle.slice(0, 64);
    const profile = await this.matrix<{ displayname?: string }>("GET", `/profile/${enc(userId)}`).catch(() => null);
    if (profile?.displayname) out.name = profile.displayname.slice(0, 120);
    return out;
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
          await this.send(req.id, req.type, "POST", "/keys/signatures/upload", req.body);
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
          // Key backup is not used: the bot keeps its keys in SUPPORT_STORE_DIR.
          break;
      }
    }
  }

  private async send(id: string, type: RequestType, method: string, path: string, body: string): Promise<void> {
    const res = await this.matrix<unknown>(method, path, JSON.parse(body));
    await this.machine!.markRequestAsSent(id, type, JSON.stringify(res));
  }

  private async matrix<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`${this.config.SYNAPSE_URL.replace(/\/$/, "")}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.SUPPORT_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

const enc = encodeURIComponent;

/** The line Starlings gets for one message. Files stay on the Bipe server. */
function lineText(content: Record<string, unknown>): string {
  const msgtype = content.msgtype;
  if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
    const body = typeof content.body === "string" ? content.body.trim() : "";
    return body.slice(0, 10_000);
  }
  if (msgtype === "m.image") return "[imagem]";
  if (msgtype === "m.file" || msgtype === "m.video" || msgtype === "m.audio") return "[arquivo]";
  if (msgtype === "m.location") return "[localização]";
  return "";
}
