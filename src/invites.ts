import { createHash, randomInt } from "node:crypto";
import type { Db } from "./db.js";

// Unambiguous uppercase alphabet: no 0/O, 1/I/L.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// Users type codes by hand: ignore case, spaces and dashes.
export function inviteHash(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");
}

export async function createInvite(db: Db, uses: number, days: number, note?: string): Promise<string> {
  const code = newInviteCode();
  await db.query(
    "INSERT INTO invites (code_hash, uses_left, expires_at, note) VALUES ($1, $2, now() + make_interval(days => $3), $4)",
    [inviteHash(code), uses, days, note ?? null],
  );
  return code;
}

/** Takes one use. Returns the invite id, or null when the code is unknown, used up, expired or revoked. */
export async function takeInviteUse(db: Db, code: string): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE invites SET uses_left = uses_left - 1
     WHERE code_hash = $1 AND uses_left > 0 AND expires_at > now() AND revoked_at IS NULL
     RETURNING id`,
    [inviteHash(code)],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function returnInviteUse(db: Db, inviteId: number): Promise<void> {
  await db.query("UPDATE invites SET uses_left = uses_left + 1 WHERE id = $1", [inviteId]);
}
