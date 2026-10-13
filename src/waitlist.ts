import { z } from "zod";
import type { Db } from "./db.js";

// Waitlist for platforms without a build (ADR 0025). Bipe emails each address once, when the
// platform ships, then deletes it. Never log an address.

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
