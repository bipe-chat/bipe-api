// One person proof of an account, for any scheme (ADR 0272, ADR 0275; bipe-chat/bipe#1195). The rail checks the proof
// (gov.br: the signed PDF, govbr.ts). This stores what it found: the dedupe hash of the subject inside its scheme, and
// the verified name bound to the master key. The CPF or any other national number is never stored.
import type pg from "pg";
import type { PersonProof } from "./schemes.js";

export type PersonProofInput = {
  proof: PersonProof;
  /** The dedupe secret of the scheme. */
  secret: string;
  /** The subject the rail read, for example the CPF. Only its keyed hash is stored. */
  subject: string;
  userId: string;
  verifiedName: string;
  masterKey: string;
  now: Date;
};

/**
 * Stores a proof inside the caller's transaction. Another subject on this account in the same scheme means another
 * person, so every older proof of the account stops counting. A subject of another account in the same scheme fails
 * on the unique index (Postgres 23505): the caller answers that the subject is in use.
 */
export async function recordPersonProof(client: pg.PoolClient, p: PersonProofInput): Promise<void> {
  const hash = p.proof.dedupeHash(p.secret, p.subject);
  // A Brazilian alias level (pix, govbr) names its scheme by itself; lvl person stores the scheme.
  const scheme = p.proof.level === "person" ? p.proof.scheme : null;
  await client.query(
    "DELETE FROM person_verifications WHERE user_id = $1 AND EXISTS (SELECT 1 FROM person_identities i WHERE i.user_id = $1 AND i.scheme = $3 AND i.dedupe_hash <> $2)",
    [p.userId, hash, p.proof.scheme],
  );
  await client.query(
    "INSERT INTO person_identities (user_id, scheme, dedupe_hash) VALUES ($1, $3, $2) ON CONFLICT (user_id, scheme) DO UPDATE SET dedupe_hash = $2",
    [p.userId, hash, p.proof.scheme],
  );
  await client.query("DELETE FROM person_verifications WHERE user_id = $1 AND level = $2 AND scheme IS NOT DISTINCT FROM $3", [p.userId, p.proof.level, scheme]);
  await client.query(
    "INSERT INTO person_verifications (user_id, level, scheme, verified_name, master_key, verified_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [p.userId, p.proof.level, scheme, p.verifiedName, p.masterKey, p.now],
  );
}
