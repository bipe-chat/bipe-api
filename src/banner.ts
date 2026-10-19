// Remote critical banner (ADR 0117, bipe#386): one banner above the chat list for an outage, a forced update or a
// change of terms. Nothing else uses it. Staff set it with the CLI; the apps read GET /v1/banner.
import type { Db } from "./db.js";
import { remoteBannerProblem } from "./generated/lib/registries.mjs";

export type RemoteBanner = {
  id: string;
  title: string;
  text: string;
  link: string;
  min_app_version?: string;
  update_links?: { ios: string; android: string };
  expires_at: string;
};

/** The current banner, or null when there is none or it is past expires_at. */
export async function currentBanner(db: Db): Promise<RemoteBanner | null> {
  const { rows } = await db.query<{ body: RemoteBanner }>(
    "SELECT body FROM remote_banner WHERE (body->>'expires_at')::timestamptz > now()",
  );
  return rows[0]?.body ?? null;
}

/** Replaces the banner. Throws with the field name when remoteBannerProblem() refuses it. */
export async function setBanner(db: Db, banner: unknown, now = new Date()): Promise<RemoteBanner> {
  const problem = remoteBannerProblem(banner, now.toISOString()) as string | null;
  if (problem) throw new Error(`banner refused: ${problem}`);
  const b = banner as RemoteBanner;
  // Store a normal ISO time, so the expiry query and the apps read the same value.
  const body = { ...b, expires_at: new Date(b.expires_at).toISOString() };
  await db.query(
    `INSERT INTO remote_banner (singleton, body) VALUES (true, $1)
     ON CONFLICT (singleton) DO UPDATE SET body = EXCLUDED.body, set_at = now()`,
    [JSON.stringify(body)],
  );
  return body;
}

export async function clearBanner(db: Db): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM remote_banner");
  return (rowCount ?? 0) > 0;
}
