// Age signals (ADR 0229, bipe-chat/bipe#994). The age comes from the OS, never from a date of birth. The apps send the
// range Apple Declared Age Range or Google Play Age Signals gave; the server maps it to one band with ageBand()
// (registries/age-signals.json) and keeps only the band, the source, the method and the time. The band is never shown
// to other users and never goes into the Matrix profile.
import type { Db } from "./db.js";
import { ageBandOf, ageRules } from "./registry.js";

type Queryable = Pick<Db, "query">;

export type AgeSource = "apple" | "play" | "none";

/** Records the caller's signal, in place of an older one. Source none, or no range, stores unknown. Returns the band. */
export async function recordAgeSignal(
  db: Queryable,
  userId: string,
  signal: { source: AgeSource; lower?: number; upper?: number; method?: string },
): Promise<string> {
  const band = signal.source === "none" ? ageRules.unknownBand : ageBandOf(signal.lower, signal.upper);
  await db.query(
    `INSERT INTO age_signals (user_id, band, source, method, checked_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET band = EXCLUDED.band, source = EXCLUDED.source, method = EXCLUDED.method, checked_at = now()`,
    [userId, band, signal.source, signal.method ?? null],
  );
  return band;
}

/** The band and the time of the last signal; unknown and null when the account never sent one. */
export async function ageSignalOf(db: Queryable, userId: string): Promise<{ band: string; checkedAt: Date | null }> {
  const { rows } = await db.query<{ band: string; checked_at: Date }>("SELECT band, checked_at FROM age_signals WHERE user_id = $1", [userId]);
  return rows[0] ? { band: rows[0].band, checkedAt: rows[0].checked_at } : { band: ageRules.unknownBand, checkedAt: null };
}

/**
 * True when the account gets the under-18 defaults (handle lookup by non-contacts off, "Who can message me" on
 * contacts only, phone discovery off): every band but the adult one, unknown included (ADR 0229 point 4).
 */
export async function treatedAsMinor(db: Queryable, userId: string): Promise<boolean> {
  return (await ageSignalOf(db, userId)).band !== ageRules.adultBand;
}
