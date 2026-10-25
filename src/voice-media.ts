import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { voiceMediaRules } from "./registry.js";

// Voice message audio expiry (ADR 0164, bipe-chat/bipe#622). The sending app registers the media ID of each voice
// message it sends. The server deletes the file transcriptDays (with a transcript) or noTranscriptDays (without) after
// the upload, through the Synapse admin API, unless an account keeps it. The event and the transcript stay: messages
// are end-to-end encrypted and the server never sees them. Media that nobody registered never expires.
// Logs carry counts only, never a user ID next to a media ID.

export type KeepReason = "kept" | "scam";

/** What the purge needs from Synapse. Tests give a fake. */
export interface MediaDeleter {
  /** Deletes one local media file. A file that is already gone counts as deleted. */
  deleteMedia(serverName: string, mediaId: string): Promise<void>;
}

export const MEDIA_ID = /^[A-Za-z0-9_-]{1,255}$/;
const PURGE_BATCH = 500;

export class VoiceMedia {
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly opts: { serverName: string; synapse: Pick<pg.Pool, "query"> | null; deleter: MediaDeleter | null },
  ) {}

  /** The purge needs the Synapse admin token. Registration needs the Synapse database. */
  get state(): string {
    if (!this.opts.synapse) return "off (no SYNAPSE_DATABASE_URL): registrations refused";
    return this.opts.deleter ? "on" : "registrations on, purge off (no SYNAPSE_ADMIN_TOKEN)";
  }

  /**
   * PUT /v1/me/voice-media/{server}/{mediaId}. Only the caller's own upload on this server: Synapse
   * local_media_repository (media_id, user_id, created_ts) through SYNAPSE_DATABASE_URL. Idempotent.
   */
  async register(userId: string, server: string, mediaId: string, transcript: boolean): Promise<void> {
    if (!MEDIA_ID.test(mediaId)) throw new ApiError("bad_request", "media_id");
    if (server !== this.opts.serverName) throw new ApiError("not_found");
    if (!this.opts.synapse) throw new ApiError("internal", "voice_media_unavailable");
    const { rows } = await this.opts.synapse.query<{ created_ts: string }>(
      "SELECT created_ts FROM local_media_repository WHERE media_id = $1 AND user_id = $2",
      [mediaId, userId],
    );
    if (!rows[0]) throw new ApiError("not_found");
    const days = transcript ? voiceMediaRules.transcriptDays : voiceMediaRules.noTranscriptDays;
    const uploadedAt = new Date(Number(rows[0].created_ts));
    await this.db.query(
      `INSERT INTO voice_media (media_id, user_id, transcript, uploaded_at, expires_at)
       VALUES ($1, $2, $3, $4, $4 + make_interval(days => $5))
       ON CONFLICT (media_id) DO NOTHING`,
      [mediaId, userId, transcript, uploadedAt, days],
    );
  }

  /** GET /v1/me/kept-media, newest first. */
  async kept(userId: string) {
    const { rows } = await this.db.query<{ media_id: string; reason: KeepReason; kept_at: Date }>(
      "SELECT media_id, reason, kept_at FROM kept_media WHERE user_id = $1 ORDER BY kept_at DESC, media_id LIMIT $2",
      [userId, voiceMediaRules.maxKeptPerAccount],
    );
    return {
      media: rows.map((r) => ({ media_id: `mxc://${this.opts.serverName}/${r.media_id}`, reason: r.reason, kept_at: r.kept_at.toISOString() })),
    };
  }

  /**
   * PUT /v1/me/kept-media/{server}/{mediaId}. No membership check: the server cannot read encrypted rooms, and a keep
   * gives no access. Media of another server cannot expire here, so it is accepted and not stored.
   */
  async keep(userId: string, server: string, mediaId: string, reason: KeepReason): Promise<void> {
    if (!MEDIA_ID.test(mediaId)) throw new ApiError("bad_request", "media_id");
    if (server !== this.opts.serverName) return;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // One account's keeps take one lock, so two requests cannot pass the cap together.
      await client.query("SELECT pg_advisory_xact_lock(7140164, hashtext($1))", [userId]);
      const updated = await client.query("UPDATE kept_media SET reason = $3 WHERE user_id = $1 AND media_id = $2", [userId, mediaId, reason]);
      if (updated.rowCount === 0) {
        const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM kept_media WHERE user_id = $1", [userId]);
        if ((rows[0]?.n ?? 0) >= voiceMediaRules.maxKeptPerAccount) throw new ApiError("keep_limit");
        await client.query("INSERT INTO kept_media (user_id, media_id, reason) VALUES ($1, $2, $3)", [userId, mediaId, reason]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** DELETE /v1/me/kept-media/{server}/{mediaId}. Idempotent. */
  async unkeep(userId: string, server: string, mediaId: string): Promise<void> {
    if (server !== this.opts.serverName || !MEDIA_ID.test(mediaId)) return;
    await this.db.query("DELETE FROM kept_media WHERE user_id = $1 AND media_id = $2", [userId, mediaId]);
  }

  /** Deletes due media that no account keeps, in batches. Returns the number of files deleted. */
  async purge(): Promise<number> {
    if (!this.opts.deleter || this.running) return 0;
    this.running = true;
    let deleted = 0;
    try {
      for (;;) {
        const { rows } = await this.db.query<{ media_id: string }>(
          `SELECT v.media_id FROM voice_media v
           WHERE v.expires_at <= now() AND NOT EXISTS (SELECT 1 FROM kept_media k WHERE k.media_id = v.media_id)
           ORDER BY v.expires_at LIMIT $1`,
          [PURGE_BATCH],
        );
        for (const { media_id } of rows) {
          await this.opts.deleter.deleteMedia(this.opts.serverName, media_id);
          await this.db.query("DELETE FROM voice_media WHERE media_id = $1", [media_id]);
          deleted++;
        }
        if (rows.length < PURGE_BATCH) return deleted;
      }
    } finally {
      this.running = false;
    }
  }
}
