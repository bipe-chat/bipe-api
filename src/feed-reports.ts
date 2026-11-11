// Reports and takedown on the public feed (bipe-chat/bipe#1180; contract: bipe-shared api/openapi.yaml
// /v1/web/feed/{handle}/p/{id}/report). Anyone who reads a post page can report the post, with no account. A report keeps
// the post, the reason and the time: never the reporter, the address or a free text. Staff decide each report with the CLI.
// Every staff action goes into public_feed_actions, the source of the transparency report (bipe#288).
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { handleKey } from "./profiles.js";

export const FEED_REPORT_REASONS = ["scam", "illegal", "hate", "privacy", "other"] as const;
export type FeedReportReason = (typeof FEED_REPORT_REASONS)[number];
export const FeedReportForm = z.object({ reason: z.enum(FEED_REPORT_REASONS) });

export type FeedAction = "remove_post" | "restore_post" | "feed_off" | "feed_on" | "report_kept";

/** Reports and actions go after 2 years (bipe-shared product/data.json, public-feed-reports). */
const KEEP_DAYS = 730;

type Queryable = Db | pg.PoolClient;

const newReportId = () => randomBytes(8).toString("hex");

/** One line of the action log, in the caller's transaction when it has one. */
export async function logFeedAction(
  q: Queryable,
  action: FeedAction,
  target: { ownerId: string | null; handle: string | null; postId?: string | null; reportId?: string | null },
  note?: string,
): Promise<void> {
  await q.query(
    "INSERT INTO public_feed_actions (action, owner_id, handle, post_id, report_id, note) VALUES ($1, $2, $3, $4, $5, $6)",
    [action, target.ownerId, target.handle, target.postId ?? null, target.reportId ?? null, note?.slice(0, 500) ?? null],
  );
}

/** POST /v1/web/feed/{handle}/p/{id}/report. Only a live post of an enabled feed takes a report. */
export async function reportPost(db: Db, rawHandle: string, postId: string, reason: FeedReportReason) {
  const { rows } = await db.query<{ handle: string }>(
    `SELECT h.handle FROM public_feed_posts p
       JOIN public_feeds f ON f.user_id = p.user_id
       JOIN handles h ON h.user_id = p.user_id
      WHERE h.handle = $1 AND p.id = $2 AND p.removed_at IS NULL AND f.enabled`,
    [handleKey(rawHandle), postId],
  );
  const handle = rows[0]?.handle;
  if (!handle) throw new ApiError("not_found");
  const id = newReportId();
  await db.query("INSERT INTO public_feed_reports (id, post_id, reason) VALUES ($1, $2, $3)", [id, postId, reason]);
  const open = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public_feed_reports WHERE post_id = $1 AND state = 'open'", [postId]);
  return { id, handle, postId, reason, openOnPost: open.rows[0]?.n ?? 1 };
}

/** The text of the staff alert. It names the post and the reason, never who reported. */
export function reportAlert(siteUrl: string, r: { id: string; handle: string; postId: string; reason: string; openOnPost: number }): string {
  const url = `${siteUrl.replace(/\/$/, "")}/@${r.handle}/p/${r.postId}`;
  return `Denúncia no feed público: ${url}\nMotivo: ${r.reason}. Denúncias abertas nesta publicação: ${r.openOnPost}.\n` +
    `Decidir: node dist/cli.js feed decide ${r.id} remove|keep "<motivo>"`;
}

export async function staffListReports(db: Db, all = false) {
  const { rows } = await db.query<{ id: string; handle: string | null; post_id: string; reason: string; state: string; created_at: Date; decided_at: Date | null }>(
    `SELECT r.id, h.handle, r.post_id, r.reason, r.state, r.created_at, r.decided_at
       FROM public_feed_reports r
       LEFT JOIN public_feed_posts p ON p.id = r.post_id
       LEFT JOIN handles h ON h.user_id = p.user_id
      ${all ? "" : "WHERE r.state = 'open'"}
      ORDER BY r.created_at`,
  );
  return rows;
}

/**
 * Staff decision on a report. remove: the post leaves the page and every open report on it closes as removed.
 * keep: every open report on the post closes as kept. Both go into the action log with the reason given.
 */
export async function staffDecideReport(db: Db, reportId: string, decision: "remove" | "keep", note?: string): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ post_id: string; owner_id: string | null; handle: string | null }>(
      `SELECT r.post_id, p.user_id AS owner_id, h.handle FROM public_feed_reports r
         LEFT JOIN public_feed_posts p ON p.id = r.post_id
         LEFT JOIN handles h ON h.user_id = p.user_id
        WHERE r.id = $1 AND r.state = 'open' FOR UPDATE OF r`,
      [reportId],
    );
    const report = rows[0];
    if (!report) {
      await client.query("ROLLBACK");
      return false;
    }
    if (decision === "remove") {
      await client.query("UPDATE public_feed_posts SET removed_at = now(), removed_by = 'staff' WHERE id = $1 AND removed_at IS NULL", [report.post_id]);
    }
    await client.query(
      "UPDATE public_feed_reports SET state = $2, decided_at = now() WHERE post_id = $1 AND state = 'open'",
      [report.post_id, decision === "remove" ? "removed" : "kept"],
    );
    await logFeedAction(client, decision === "remove" ? "remove_post" : "report_kept",
      { ownerId: report.owner_id, handle: report.handle, postId: report.post_id, reportId }, note);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The action log, newest first, for the transparency report. */
export async function staffActionLog(db: Db, days = 90) {
  const { rows } = await db.query<{ at: Date; action: string; handle: string | null; post_id: string | null; report_id: string | null; note: string | null }>(
    `SELECT at, action, handle, post_id, report_id, note FROM public_feed_actions
      WHERE at > now() - make_interval(days => $1) ORDER BY at DESC`,
    [days],
  );
  return rows;
}

/** The owner of a post and its handle, for a log line of a staff action outside a report. */
export async function postOwner(q: Queryable, postId: string) {
  const { rows } = await q.query<{ owner_id: string; handle: string | null }>(
    "SELECT p.user_id AS owner_id, h.handle FROM public_feed_posts p LEFT JOIN handles h ON h.user_id = p.user_id WHERE p.id = $1",
    [postId],
  );
  return rows[0] ?? null;
}

export async function feedOwner(q: Queryable, rawHandle: string) {
  const { rows } = await q.query<{ owner_id: string; handle: string }>(
    "SELECT user_id AS owner_id, handle FROM handles WHERE handle = $1",
    [handleKey(rawHandle)],
  );
  return rows[0] ?? null;
}

/** Daily: reports and actions older than 2 years go. */
export async function pruneFeedReports(db: Db): Promise<number> {
  const reports = await db.query("DELETE FROM public_feed_reports WHERE created_at < now() - make_interval(days => $1)", [KEEP_DAYS]);
  const actions = await db.query("DELETE FROM public_feed_actions WHERE at < now() - make_interval(days => $1)", [KEEP_DAYS]);
  return (reports.rowCount ?? 0) + (actions.rowCount ?? 0);
}
