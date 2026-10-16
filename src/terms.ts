// Clickwrap terms (ADR 0113). One version names the pair of texts (registries/legal.json). The server refuses any
// version but the current one and keeps one row per account and version: the account, the version and the time.
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { legalRules } from "./registry.js";

type Queryable = Pick<Db, "query">;

/** Throws terms_required unless `version` is the current legalVersion. `required` false lets a missing one through. */
export function checkTermsVersion(version: string | undefined, required: boolean): string | null {
  if (version === undefined) {
    if (required) throw new ApiError("terms_required", "missing");
    return null;
  }
  if (version !== legalRules.legalVersion) throw new ApiError("terms_required", "outdated");
  return version;
}

/** Records the acceptance. A repeat of the same version keeps the first time. */
export async function recordTerms(db: Queryable, userId: string, version: string, source: "signup" | "app"): Promise<void> {
  await db.query(
    "INSERT INTO terms_acceptances (user_id, version, source) VALUES ($1, $2, $3) ON CONFLICT (user_id, version) DO NOTHING",
    [userId, version, source],
  );
}

/** The last version the account accepted, or null. */
export async function acceptedTermsVersion(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ version: string }>(
    "SELECT version FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1",
    [userId],
  );
  return rows[0]?.version ?? null;
}
