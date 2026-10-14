import { z } from "zod";
import type { Db } from "./db.js";
import { createInvite, inviteUrl } from "./invites.js";
import { type Mailer, mailBody } from "./mailer.js";
import { appString, type Lang } from "./registry.js";

// Waitlist (ADR 0025, ADR 0089). An entry gets one email: a single-use invite when staff release a batch,
// or the launch notice for a platform without a build. Never log an address.

export const WaitlistBody = z.object({
  email: z.email().max(254),
  platform: z.enum(["android", "ios", "other"]),
  lang: z.enum(["pt", "en"]).default("pt"),
  source: z.string().max(64).regex(/^[a-z0-9:/_.-]*$/).optional(),
  website: z.string().max(200).optional(),
});
export type WaitlistRequest = z.infer<typeof WaitlistBody>;

/** Adds or refreshes an entry. Silent on duplicates and on the honeypot, so the answer never tells whether an address is known. */
export async function joinWaitlist(db: Db, req: WaitlistRequest): Promise<void> {
  if (req.website) return;
  await db.query(
    `INSERT INTO waitlist (email, platform, lang, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email, platform) DO UPDATE SET lang = EXCLUDED.lang`,
    [req.email.trim().toLowerCase(), req.platform, req.lang, req.source ?? null],
  );
}

// Release in batches (ADR 0089): staff give the oldest entries of a platform one single-use invite each,
// by email. An entry goes when its invite is used, expires or is revoked.

export const WAITLIST_INVITE_DAYS = 14;

export interface ReleaseResult {
  sent: number;
  failed: number;
  note: string;
}

/** Invites the oldest uninvited entries of a platform. Refuses when email is off, so it never makes an invite nobody gets. */
export async function releaseWaitlist(
  db: Db,
  mailer: Mailer,
  siteUrl: string,
  platform: WaitlistRequest["platform"],
  count: number,
  days = WAITLIST_INVITE_DAYS,
): Promise<ReleaseResult> {
  if (!mailer.enabled) throw new Error("email is off (BIPE_SMTP_HOST): no invite made");
  const note = `waitlist-${new Date().toISOString().slice(0, 10)}`;
  const { rows } = await db.query<{ email: string; lang: Lang }>(
    "SELECT email, lang FROM waitlist WHERE platform = $1 AND invite_id IS NULL ORDER BY created_at LIMIT $2",
    [platform, count],
  );
  let sent = 0, failed = 0;
  for (const row of rows) {
    // Mark the entry before the send, so a crash after the send never mails the same address twice.
    const invite = await createInvite(db, 1, days, note);
    await db.query("UPDATE waitlist SET invite_id = $1, invited_at = now() WHERE email = $2 AND platform = $3", [invite.id, row.email, platform]);
    try {
      await mailer.send(
        row.email,
        appString(row.lang, "bipe_mail_waitlist_subject"),
        mailBody(row.lang, appString(row.lang, "bipe_mail_waitlist_body", inviteUrl(siteUrl, invite.code), String(days))),
      );
      sent++;
    } catch {
      // Never log the address. The entry goes back to the list for the next batch.
      await db.query("UPDATE invites SET revoked_at = now() WHERE id = $1", [invite.id]);
      await db.query("UPDATE waitlist SET invite_id = NULL, invited_at = NULL WHERE email = $1 AND platform = $2", [row.email, platform]);
      failed++;
    }
  }
  return { sent, failed, note };
}

/** Deletes entries whose invite is used, expired or revoked. */
export async function pruneWaitlist(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM waitlist w USING invites i
      WHERE w.invite_id = i.id AND (i.uses_left = 0 OR i.expires_at <= now() OR i.revoked_at IS NOT NULL)`,
  );
  return rowCount ?? 0;
}
