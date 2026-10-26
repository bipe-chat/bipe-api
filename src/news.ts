// Novidades do Bipe (ADR 0117, ADR 0119, bipe#383, bipe#387). The API runs the news account (NEWS_USER_ID,
// default @bipe:<SERVER_NAME>) as a bot with its own encrypted device and key store, separate from the support bot.
// Each user has one read-only, end-to-end encrypted room with it: the bot at power level 100, the user at 0,
// events_default 50. Staff queue an item with the CLI (`news send`); the server delivers it, rate-limited, once
// per room (news_deliveries). A user who leaves the room is opted out until they turn news on again in Settings.
// Never log a news text next to a Matrix ID, or a token.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { EncryptedBot, enc, type MatrixEvent } from "./matrix-bot.js";
import { appString } from "./registry.js";

const TICK_MS = 60_000;
/** Rooms made per tick for the backfill, below the send rate so a tick also delivers. */
const BACKFILL_PER_TICK = 20;
/** Sends to one room per item, then the room gets a failed delivery row and the item moves on. */
const MAX_SEND_TRIES = 3;

/** A news item file for `news send` (ADR 0117 "Sending news"). */
export const NewsItemFile = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lower-case letters, digits and dashes"),
  text: z.string().trim().min(1).max(2_000).refine((t) => !t.includes("—"), "no em dash"),
  link: z.url().refine((u) => /^https:\/\/bipe\.chat\//.test(u), "an https://bipe.chat/ page").optional(),
  importance: z.enum(["normal", "important"]),
});
export type NewsItemFile = z.infer<typeof NewsItemFile>;

/** The message body: the text, the optional link, then the line that points to Suporte Bipe. */
export function newsBody(item: { body: string; link: string | null }): string {
  return [item.body, item.link, appString("pt", "bipe_news_support_line")].filter(Boolean).join("\n\n");
}

/**
 * The room's power levels: only the bot writes (ADR 0117). The room is version 12 (NEWS_ROOM_VERSION): the bot, as the
 * creator, has the top power level without an entry, and Synapse refuses a createRoom that lists the creator in `users`.
 */
export function newsPowerLevels(userId: string) {
  return {
    users: { [userId]: 0 },
    users_default: 0,
    events_default: 50,
    state_default: 100,
    invite: 100,
    kick: 100,
    ban: 100,
    redact: 100,
  };
}

/** Fixed, so that newsPowerLevels() is correct whatever the homeserver default is. */
export const NEWS_ROOM_VERSION = "12";

export class NewsBot extends EncryptedBot {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Failed sends per item and user, in this process. */
  private readonly failures = new Map<string, number>();
  /** Users whose backfill room failed in this process (for example a deactivated account). */
  private readonly backfillSkip = new Set<string>();

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    super(db, {
      label: "news bot",
      userId: config.NEWS_USER_ID,
      token: config.NEWS_ACCESS_TOKEN,
      storeDir: config.NEWS_STORE_DIR,
      passphrase: config.NEWS_STORE_PASSPHRASE,
      synapseUrl: config.SYNAPSE_URL,
      syncTable: "news_sync",
    });
  }

  protected override onReady(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  // ---- Rooms -------------------------------------------------------------------------------------

  /** Settings switch (GET /v1/me/news): on while the user has a room and did not leave it. */
  async state(userId: string): Promise<{ subscribed: boolean; room_id?: string }> {
    if (!this.enabled) throw new ApiError("internal", "news_unavailable");
    const { rows } = await this.db.query<{ room_id: string; opted_out: boolean }>("SELECT room_id, opted_out FROM news_rooms WHERE user_id = $1", [userId]);
    const row = rows[0];
    return row && !row.opted_out ? { subscribed: true, room_id: row.room_id } : { subscribed: false };
  }

  /**
   * Settings switch on (PUT /v1/me/news). A room the user is still in or invited to stays. Otherwise the bot makes a
   * new room and leaves the old one; the user gets the next item there.
   */
  async subscribe(userId: string): Promise<{ subscribed: true; room_id: string }> {
    if (!this.enabled) throw new ApiError("internal", "news_unavailable");
    await this.ready;
    const { rows } = await this.db.query<{ room_id: string; opted_out: boolean }>("SELECT room_id, opted_out FROM news_rooms WHERE user_id = $1", [userId]);
    const old = rows[0];
    if (old && !old.opted_out) {
      const membership = await this.membership(old.room_id, userId);
      if (membership === "join" || membership === "invite") return { subscribed: true, room_id: old.room_id };
    }
    const roomId = await this.createRoom(userId);
    await this.db.query(
      `INSERT INTO news_rooms (user_id, room_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET room_id = EXCLUDED.room_id, opted_out = false, left_at = NULL, created_at = now()`,
      [userId, roomId],
    );
    if (old) await this.matrix("POST", `/rooms/${enc(old.room_id)}/leave`, {}).catch(() => {});
    return { subscribed: true, room_id: roomId };
  }

  /** Settings switch off (DELETE /v1/me/news). The app leaves the room itself; this keeps the bot from sending. */
  async unsubscribe(userId: string): Promise<void> {
    if (!this.enabled) throw new ApiError("internal", "news_unavailable");
    await this.db.query("UPDATE news_rooms SET opted_out = true, left_at = coalesce(left_at, now()) WHERE user_id = $1", [userId]);
  }

  /** At sign-up: the user's first news room with the welcome item. Runs in the background; a failure is logged. */
  welcome(userId: string): void {
    if (!this.enabled) return;
    void this.ensureRoom(userId).catch((e) => console.error(`news bot: welcome failed: ${(e as Error).message}`));
  }

  /** Makes the room once per user. A user who has a row (even opted out) is not invited again. */
  private async ensureRoom(userId: string): Promise<void> {
    await this.ready;
    const { rows } = await this.db.query("SELECT 1 FROM news_rooms WHERE user_id = $1", [userId]);
    if (rows[0]) return;
    const roomId = await this.createRoom(userId);
    const { rows: kept } = await this.db.query<{ room_id: string }>(
      `INSERT INTO news_rooms (user_id, room_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING room_id`,
      [userId, roomId],
    );
    if (kept[0]!.room_id !== roomId) {
      // A parallel call won: leave the extra room.
      await this.matrix("POST", `/rooms/${enc(roomId)}/leave`, {}).catch(() => {});
    }
  }

  private async createRoom(userId: string): Promise<string> {
    const created = await this.matrix<{ room_id: string }>("POST", "/createRoom", {
      preset: "private_chat",
      room_version: NEWS_ROOM_VERSION,
      is_direct: true,
      invite: [userId],
      name: appString("pt", "bipe_news_room_name"),
      topic: appString("pt", "bipe_news_room_topic"),
      power_level_content_override: newsPowerLevels(userId),
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await this.sendText(created.room_id, appString("pt", "bipe_news_welcome"), "m.notice");
    return created.room_id;
  }

  // ---- Sync --------------------------------------------------------------------------------------

  /** The news account takes no invites: nobody can write to it. */
  protected async onInvite(roomId: string): Promise<void> {
    await this.matrix("POST", `/rooms/${enc(roomId)}/leave`, {}).catch(() => {});
  }

  /** The user left (or was banned from) their news room: no more items until they turn news on again. */
  protected async onTimelineEvent(roomId: string, event: MatrixEvent): Promise<void> {
    if (event.type !== "m.room.member" || event.state_key === this.userId) return;
    const membership = event.content.membership;
    if (membership !== "leave" && membership !== "ban") return;
    await this.db.query(
      "UPDATE news_rooms SET opted_out = true, left_at = coalesce(left_at, now()) WHERE room_id = $1 AND user_id = $2",
      [roomId, event.state_key],
    );
  }

  // ---- Delivery ----------------------------------------------------------------------------------

  /** One tick: backfill rooms when staff asked for it, then deliver the oldest open item. One tick at a time. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let budget = this.config.NEWS_SEND_PER_MINUTE;
      budget -= await this.backfill(Math.min(BACKFILL_PER_TICK, budget));
      if (budget > 0) await this.deliver(budget);
    } catch (e) {
      console.error(`news bot: tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Rooms for users who signed up before the news bot, after `news backfill`. Returns the rooms made. */
  private async backfill(limit: number): Promise<number> {
    const { rows: state } = await this.db.query<{ backfill_requested_at: Date | null }>("SELECT backfill_requested_at FROM news_state WHERE id = 1");
    if (!state[0]?.backfill_requested_at || limit <= 0) return 0;
    const { rows } = await this.db.query<{ user_id: string }>(
      `SELECT s.user_id FROM signups s LEFT JOIN news_rooms n ON n.user_id = s.user_id
       WHERE n.user_id IS NULL AND NOT (s.user_id = ANY($2)) ORDER BY s.created_at LIMIT $1`,
      [limit, [...this.backfillSkip]],
    );
    if (!rows.length) {
      await this.db.query("UPDATE news_state SET backfill_requested_at = NULL, backfill_done_at = now() WHERE id = 1");
      console.log("news bot: backfill done");
      return 0;
    }
    let made = 0;
    for (const { user_id } of rows) {
      try {
        await this.ensureRoom(user_id);
        made++;
      } catch (e) {
        console.error(`news bot: backfill room failed: ${(e as Error).message}`);
        this.backfillSkip.add(user_id);
      }
    }
    return made;
  }

  /** Sends the oldest open item to at most `limit` rooms that existed when it was queued and do not have it. */
  private async deliver(limit: number): Promise<void> {
    const { rows: items } = await this.db.query<{ id: string; body: string; link: string | null; importance: string; created_at: Date }>(
      "SELECT id, body, link, importance, created_at FROM news_items WHERE done_at IS NULL ORDER BY created_at LIMIT 1",
    );
    const item = items[0];
    if (!item) return;
    const { rows: rooms } = await this.db.query<{ user_id: string; room_id: string }>(
      `SELECT n.user_id, n.room_id FROM news_rooms n
       WHERE NOT n.opted_out AND n.created_at <= $2
         AND NOT EXISTS (SELECT 1 FROM news_deliveries d WHERE d.item_id = $1 AND d.user_id = n.user_id)
       ORDER BY n.created_at LIMIT $3`,
      [item.id, item.created_at, limit],
    );
    if (!rooms.length) {
      await this.db.query("UPDATE news_items SET done_at = now() WHERE id = $1", [item.id]);
      console.log(`news bot: item ${item.id} delivered`);
      return;
    }
    // normal: m.notice, so the default push rule .m.rule.suppress_notices sends no push. important: m.text.
    const msgtype = item.importance === "important" ? "m.text" : "m.notice";
    const body = newsBody(item);
    for (const room of rooms) {
      const key = `${item.id}\n${room.user_id}`;
      try {
        await this.sendText(room.room_id, body, msgtype, newsTxnId(item.id, room.room_id));
        await this.db.query("INSERT INTO news_deliveries (item_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [item.id, room.user_id]);
        this.failures.delete(key);
      } catch (e) {
        // The next tick tries this room again; the transaction ID stops a second copy.
        console.error(`news bot: send failed: ${(e as Error).message}`);
        const tries = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, tries);
        if (tries >= MAX_SEND_TRIES) {
          this.failures.delete(key);
          await this.db.query("INSERT INTO news_deliveries (item_id, user_id, failed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", [item.id, room.user_id]);
        }
      }
    }
  }
}

/** One transaction ID per item and room, so a retry after a lost answer sends no second copy. */
export function newsTxnId(itemId: string, roomId: string): string {
  return `news-${itemId}-${createHash("sha256").update(roomId).digest("hex").slice(0, 16)}`;
}

// ---- Admin CLI (news send, news list, news backfill) ---------------------------------------------

/** `news send <file>`: queues an item; the server delivers it. The same id twice is refused. */
export async function queueNewsItem(db: Db, input: unknown): Promise<NewsItemFile> {
  const item = NewsItemFile.parse(input);
  const res = await db.query(
    "INSERT INTO news_items (id, body, link, importance) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    [item.id, item.text, item.link ?? null, item.importance],
  );
  if (!res.rowCount) throw new Error(`news item ${item.id} exists already`);
  return item;
}

/** `news list`: items with their delivery counts, newest first. No texts. */
export async function newsList(db: Db) {
  const { rows } = await db.query<{ id: string; importance: string; created_at: Date; done_at: Date | null; sent: number; failed: number }>(
    `SELECT i.id, i.importance, i.created_at, i.done_at,
            count(d.user_id) FILTER (WHERE NOT d.failed)::int AS sent,
            count(d.user_id) FILTER (WHERE d.failed)::int AS failed
     FROM news_items i LEFT JOIN news_deliveries d ON d.item_id = i.id
     GROUP BY i.id ORDER BY i.created_at DESC`,
  );
  const { rows: rooms } = await db.query<{ rooms: number; opted_out: number }>(
    "SELECT count(*)::int AS rooms, count(*) FILTER (WHERE opted_out)::int AS opted_out FROM news_rooms",
  );
  return { items: rows, ...rooms[0]! };
}

/** `news backfill`: the server makes a room for every user who has none, rate-limited, then clears the request. */
export async function requestNewsBackfill(db: Db): Promise<void> {
  await db.query("UPDATE news_state SET backfill_requested_at = now() WHERE id = 1");
}
