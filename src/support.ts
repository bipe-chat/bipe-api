// Support DM bridged to Starlings (ADR 0114, ADR 0115, bipe#367, envisioning/starlings#1176).
// The API runs the support account (SUPPORT_USER_ID, "Suporte Bipe") as a bot with its own encrypted device:
// Synapse encrypts every room (encryption_enabled_by_default_for_room_type: all), so the bot takes part in E2EE
// through the Matrix Rust crypto bindings. Each user has one support room. Texts from the user go to the bipe
// Starlings workspace through the intake outbox (src/intake.ts); member replies come back signed and go into the room.
// Never log a message text, a Matrix ID next to a text, or a token.
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Intake, IntakeBody } from "./intake.js";
import { EncryptedBot, enc, type MatrixEvent } from "./matrix-bot.js";
import { appString } from "./registry.js";

export { signatureUploadBody } from "./matrix-bot.js";

export class SupportBot extends EncryptedBot {
  constructor(
    db: Db,
    private readonly config: Config,
    private readonly intake: Intake,
  ) {
    super(db, {
      label: "support bot",
      userId: config.SUPPORT_USER_ID,
      token: config.SUPPORT_ACCESS_TOKEN,
      storeDir: config.SUPPORT_STORE_DIR,
      passphrase: config.SUPPORT_STORE_PASSPHRASE,
      synapseUrl: config.SYNAPSE_URL,
      syncTable: "support_sync",
    });
  }

  protected override onReady(): void {
    void this.ensureDisplayName().catch((e) => console.error(`support bot: display name failed: ${(e as Error).message}`));
  }

  /**
   * The support DM shows the account's display name (ADR 0141), so the bot sets it to "Suporte Bipe"
   * (bipe_support_room_name) at start. It writes only when the name differs: a change sends a member event into
   * every room of the account. Returns true when it wrote the name.
   */
  async ensureDisplayName(): Promise<boolean> {
    const wanted = appString("pt", "bipe_support_room_name");
    const path = `/profile/${enc(this.userId)}/displayname`;
    const current = await this.matrix<{ displayname?: string }>("GET", path).catch(() => null);
    if (current?.displayname === wanted) return false;
    await this.matrix("PUT", path, { displayname: wanted });
    console.log("support bot: display name set");
    return true;
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
    const membership = await this.membership(roomId, userId);
    if (membership === "join" || membership === "invite") return;
    await this.matrix("POST", `/rooms/${enc(roomId)}/invite`, { user_id: userId }).catch((e) =>
      console.error(`support bot: re-invite failed: ${(e as Error).message}`),
    );
  }

  /** A DM invite from a local user: it becomes their support room when they have none. */
  protected async onInvite(roomId: string, events: MatrixEvent[]): Promise<void> {
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

  protected async onTimelineEvent(roomId: string, event: MatrixEvent): Promise<void> {
    if (event.sender === this.userId) return;
    const { rows } = await this.db.query<{ user_id: string }>("SELECT user_id FROM support_rooms WHERE room_id = $1", [roomId]);
    const owner = rows[0]?.user_id;
    if (!owner || event.sender !== owner) return;

    const clear = await this.clearEvent(roomId, event);
    if (!clear) {
      console.error("support bot: could not decrypt a message");
      return;
    }
    const { type, content } = clear;
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
}

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
