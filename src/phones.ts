import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { recordProfileChange } from "./profile-facts.js";
import { coreProvesPhone, normalizePhone, phoneRules, profileFactRules } from "./registry.js";

// Phone-number discovery, phase 0 (bipe/docs/phone-link.md). Lookup compares HMAC-SHA256 with a server secret.
// The linked number itself is stored only encrypted (number_enc, ADR 0191) and goes back only to its owner in
// GET /v1/me/phone and the data export. Numbers are never logged.
// Linking from the apps needs a proof (Pix phone key or SMS code, phases 1 and 2); until then
// only the admin CLI links numbers. A proof on a number held by another account starts a move (bipe#469).

// Yearly confirmation (bipe#470): registries/phone-numbers.json linkConfirmMonths, the same value the apps read.
const CONFIRM_MONTHS = phoneRules.linkConfirmMonths;
export const LOOKUP_MAX_PER_REQUEST = 500;
const LOOKUP_DAILY_BUDGET = 2000;
const LOOKUP_DAILY_BUDGET_NEW_ACCOUNT = 300;
const NEW_ACCOUNT_DAYS = 7;
const DAY_MS = 86_400_000;
const HOLD_DAYS = phoneRules.moveHoldDays;
const BLOCKED_RETRY_DAYS = phoneRules.moveBlockedRetryDays;

export class PhoneHasher {
  constructor(private readonly secret: string | undefined) {}

  hash(e164: string): string {
    if (!this.secret) {
      console.error("phones: PHONE_HMAC_SECRET is not set");
      throw new ApiError("internal");
    }
    return createHmac("sha256", this.secret).update(e164).digest("hex");
  }

  // ADR 0191: AES-256-GCM under HKDF-SHA256(PHONE_HMAC_SECRET, info "bipe phone number at rest v1").
  // Layout: 12-byte IV, 16-byte tag, ciphertext. A rotation of the secret must re-encrypt number_enc with the HMACs.
  private sealKey(): Buffer {
    if (!this.secret) {
      console.error("phones: PHONE_HMAC_SECRET is not set");
      throw new ApiError("internal");
    }
    return Buffer.from(hkdfSync("sha256", Buffer.from(this.secret, "utf8"), Buffer.alloc(0), "bipe phone number at rest v1", 32));
  }

  seal(e164: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey(), iv);
    const body = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /** The E.164 number, or null when there is none, no secret, or the value does not open. Never throws. */
  open(sealed: Buffer | null | undefined): string | null {
    if (!sealed || sealed.length < 29 || !this.secret) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.sealKey(), sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const e164 = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
      return /^\+[0-9]{8,15}$/.test(e164) ? e164 : null;
    } catch {
      console.error("phones: a stored number did not open");
      return null;
    }
  }
}

// Numbers looked up per account per UTC day. In memory: one API instance only, like ratelimit.ts.
const budgets = new Map<string, { used: number; resetAt: number }>();

async function dailyBudget(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ created_at: Date }>("SELECT created_at FROM signups WHERE user_id = $1", [userId]);
  const created = rows[0]?.created_at;
  const isNew = created ? Date.now() - created.getTime() < NEW_ACCOUNT_DAYS * DAY_MS : false;
  return isNew ? LOOKUP_DAILY_BUDGET_NEW_ACCOUNT : LOOKUP_DAILY_BUDGET;
}

function spend(userId: string, count: number, budget: number): void {
  const now = Date.now();
  if (budgets.size > 50_000) for (const [k, b] of budgets) if (b.resetAt <= now) budgets.delete(k);
  let b = budgets.get(userId);
  if (!b || b.resetAt <= now) {
    b = { used: 0, resetAt: (Math.floor(now / DAY_MS) + 1) * DAY_MS };
    budgets.set(userId, b);
  }
  if (b.used + count > budget) throw new ApiError("rate_limited");
  b.used += count;
}

/** Matrix IDs for the numbers whose holders allow discovery. The submitted list is never stored. */
export async function lookupContacts(db: Db, hasher: PhoneHasher, userId: string, phones: string[]) {
  const byHash = new Map<string, string>();
  for (const raw of phones) {
    const e164 = normalizePhone(raw);
    if (e164) byHash.set(hasher.hash(e164), e164);
  }
  spend(userId, byHash.size, await dailyBudget(db, userId));
  if (byHash.size === 0) return { matches: [] };

  const { rows } = await db.query<{ phone_hmac: string; user_id: string; moved_at: Date | null }>(
    `SELECT p.phone_hmac, p.user_id,
       (SELECT max(c.changed_at) FROM profile_changes c
        WHERE c.user_id = p.user_id AND c.kind = 'number_in' AND c.changed_at > now() - make_interval(days => $4)) AS moved_at
     FROM phone_links p
     LEFT JOIN discovery_settings d ON d.user_id = p.user_id
     WHERE p.phone_hmac = ANY($1) AND p.user_id <> $2
       AND p.confirmed_at > now() - make_interval(months => $3)
       AND COALESCE(d.by_phone, true)`,
    [[...byHash.keys()], userId, CONFIRM_MONTHS, profileFactRules.windowDays],
  );
  return {
    matches: rows.map((r) => ({ phone: byHash.get(r.phone_hmac)!, user_id: r.user_id, ...(r.moved_at && { moved_at: r.moved_at.toISOString() }) })),
  };
}

/** GET /v1/me/phone: the caller's own link. `number` is the caller's own number only (ADR 0191); null for older links. */
export async function myPhone(db: Db, hasher: PhoneHasher, userId: string) {
  const { rows } = await db.query<{ method: string; linked_at: Date; confirmed_at: Date; number_enc: Buffer | null }>(
    "SELECT method, linked_at, confirmed_at, number_enc FROM phone_links WHERE user_id = $1",
    [userId],
  );
  const discoverable = await discoverableByPhone(db, userId);
  const move = await myMove(db, userId);
  const link = rows[0];
  if (!link) return { linked: false, discoverable_by_phone: discoverable, ...(move && { move }) };
  const confirmBy = new Date(link.confirmed_at);
  confirmBy.setMonth(confirmBy.getMonth() + CONFIRM_MONTHS);
  return {
    linked: true,
    method: link.method,
    linked_at: link.linked_at.toISOString(),
    confirm_by: confirmBy.toISOString(),
    number: hasher.open(link.number_enc),
    discoverable_by_phone: discoverable,
    ...(move && { move }),
  };
}

/** The move that GET /v1/me/phone shows. It never names the other account. A holder who blocked sees nothing more. */
async function myMove(db: Db, userId: string) {
  const { rows } = await db.query<{ id: string; from_user: string; state: "waiting" | "blocked"; ends_at: Date }>(
    `SELECT id, from_user, state, ends_at FROM phone_moves
     WHERE (state = 'waiting' AND (from_user = $1 OR to_user = $1))
        OR (state = 'blocked' AND to_user = $1 AND ended_at > now() - make_interval(days => $2))
     ORDER BY CASE WHEN state = 'waiting' AND from_user = $1 THEN 0 WHEN state = 'waiting' THEN 1 ELSE 2 END, started_at DESC LIMIT 1`,
    [userId, BLOCKED_RETRY_DAYS],
  );
  const move = rows[0];
  if (!move) return null;
  return {
    id: move.id,
    direction: move.from_user === userId ? ("out" as const) : ("in" as const),
    state: move.state,
    ...(move.state === "waiting" && { ends: move.ends_at.toISOString() }),
  };
}

/** The holder unlinks. A waiting move out ends at once in favour of the new account; a waiting move in is withdrawn. */
export async function unlinkPhone(db: Db, userId: string): Promise<void> {
  await transaction(db, async (client) => {
    await client.query("DELETE FROM phone_moves WHERE to_user = $1 AND state = 'waiting'", [userId]);
    const { rows } = await client.query<MoveRow>("SELECT * FROM phone_moves WHERE from_user = $1 AND state = 'waiting' FOR UPDATE", [userId]);
    for (const move of rows) await finishMove(client, move);
    await client.query("DELETE FROM phone_links WHERE user_id = $1", [userId]);
  });
}

type Client = Pick<Db, "query">;
type ProofMethod = "admin" | "pix" | "sms";
type MoveRow = { id: string; phone_hmac: string; number_enc: Buffer; from_user: string; to_user: string; method: ProofMethod };

export type ProofResult =
  | { outcome: "linked" | "confirmed" }
  | { outcome: "moving"; ends_at: Date }
  | { outcome: "held"; reason: "pix_link" | "move_waiting" | "blocked" };

async function transaction<T>(db: Db, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function setLink(client: Client, userId: string, hash: string, method: ProofMethod, sealed: Buffer): Promise<void> {
  await client.query(
    `INSERT INTO phone_links (user_id, phone_hmac, method, number_enc) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET phone_hmac = EXCLUDED.phone_hmac, method = EXCLUDED.method, number_enc = EXCLUDED.number_enc,
       linked_at = now(), confirmed_at = now()`,
    [userId, hash, method, sealed],
  );
}

// bipe#161: contacts learn of a move from these facts and from moved_at in the lookup. The server keeps no list of who
// matched a number, and an old chat stays with the old account.
async function recordMoveFacts(client: Client, fromUser: string, toUser: string): Promise<void> {
  await recordProfileChange(client, fromUser, "number_out", "phone");
  await recordProfileChange(client, toUser, "number_in", "phone");
}

/** The old holder loses the number and the new account gets it. The job sends the notices. */
async function finishMove(client: Client, move: MoveRow): Promise<void> {
  await client.query("DELETE FROM phone_links WHERE phone_hmac = $1", [move.phone_hmac]);
  await setLink(client, move.to_user, move.phone_hmac, move.method, move.number_enc);
  await client.query("UPDATE phone_moves SET state = 'done', ended_at = now() WHERE id = $1", [move.id]);
  await recordMoveFacts(client, move.from_user, move.to_user);
}

/**
 * A proof of a number succeeded for `userId`. A free number links now, the holder's own number confirms, and a number
 * held by another account starts a move and never moves at once (bipe#469). The staff CLI comes here too.
 */
export async function recordProof(client: Client, userId: string, hash: string, sealed: Buffer, method: ProofMethod): Promise<ProofResult> {
  const { rows } = await client.query<{ user_id: string; method: ProofMethod }>("SELECT user_id, method FROM phone_links WHERE phone_hmac = $1 FOR UPDATE", [hash]);
  const holder = rows[0];
  if (holder?.user_id === userId) {
    // A confirmation of the same number never starts a move.
    await client.query("UPDATE phone_links SET confirmed_at = now(), number_enc = $2 WHERE user_id = $1", [userId, sealed]);
    return { outcome: "confirmed" };
  }
  const waiting = await client.query<{ to_user: string; ends_at: Date }>("SELECT to_user, ends_at FROM phone_moves WHERE phone_hmac = $1 AND state = 'waiting' FOR UPDATE", [hash]);
  if (waiting.rows[0]) {
    return waiting.rows[0].to_user === userId ? { outcome: "moving", ends_at: waiting.rows[0].ends_at } : { outcome: "held", reason: "move_waiting" };
  }
  if (!holder) {
    await setLink(client, userId, hash, method, sealed);
    return { outcome: "linked" };
  }
  // An SMS proof never takes a Pix-proved number: a SIM swap must not reach it.
  if (holder.method === "pix" && method === "sms") return { outcome: "held", reason: "pix_link" };
  const blocked = await client.query(
    "SELECT 1 FROM phone_moves WHERE phone_hmac = $1 AND to_user = $2 AND state = 'blocked' AND ended_at > now() - make_interval(days => $3)",
    [hash, userId, BLOCKED_RETRY_DAYS],
  );
  if (blocked.rowCount) return { outcome: "held", reason: "blocked" };
  const started = await client.query<{ ends_at: Date }>(
    `INSERT INTO phone_moves (id, phone_hmac, number_enc, from_user, to_user, method, ends_at, state)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), 'waiting') RETURNING ends_at`,
    [randomUUID(), hash, sealed, holder.user_id, userId, method, HOLD_DAYS],
  );
  return { outcome: "moving", ends_at: started.rows[0]!.ends_at };
}

/** POST /v1/me/phone/moves/{id}/block: only the holder of a waiting move. */
export async function blockMove(db: Db, userId: string, id: string): Promise<void> {
  const { rowCount } = await db.query("UPDATE phone_moves SET state = 'blocked', ended_at = now() WHERE id = $1 AND from_user = $2 AND state = 'waiting'", [id, userId]);
  if (!rowCount) throw new ApiError("not_found");
}

export type MoveNotify = (userId: string, key: string, ...args: string[]) => Promise<void>;

/**
 * The job of bipe#469. It alerts holders, ends due moves, sends the end notices and prunes. A move ends only after its
 * alert went out, and the hold counts from the alert: with no way to alert the holder, the number does not move.
 */
export async function runPhoneMoves(db: Db, notify: MoveNotify): Promise<void> {
  const alerts = await db.query<{ id: string; from_user: string }>("SELECT id, from_user FROM phone_moves WHERE state = 'waiting' AND alerted_at IS NULL");
  for (const move of alerts.rows) {
    try {
      await notify(move.from_user, "bipe_phone_move_alert", String(HOLD_DAYS));
      await db.query("UPDATE phone_moves SET alerted_at = now(), ends_at = now() + make_interval(days => $2) WHERE id = $1 AND state = 'waiting'", [move.id, HOLD_DAYS]);
    } catch (e) {
      console.error(`phones: alert for move ${move.id} failed: ${(e as Error).message}`);
    }
  }
  await transaction(db, async (client) => {
    const { rows } = await client.query<MoveRow>("SELECT * FROM phone_moves WHERE state = 'waiting' AND alerted_at IS NOT NULL AND ends_at <= now() FOR UPDATE SKIP LOCKED");
    for (const move of rows) await finishMove(client, move);
  });
  const ended = await db.query<{ id: string; from_user: string; to_user: string; state: string }>("SELECT id, from_user, to_user, state FROM phone_moves WHERE state <> 'waiting' AND notified_at IS NULL");
  for (const move of ended.rows) {
    try {
      if (move.state === "done") {
        await notify(move.from_user, "bipe_phone_move_done_out");
        await notify(move.to_user, "bipe_phone_move_done_in");
      } else {
        await notify(move.to_user, "bipe_phone_move_blocked");
      }
      await db.query("UPDATE phone_moves SET notified_at = now() WHERE id = $1", [move.id]);
    } catch (e) {
      console.error(`phones: notice for move ${move.id} failed: ${(e as Error).message}`);
    }
  }
  await db.query("DELETE FROM phone_moves WHERE state <> 'waiting' AND notified_at IS NOT NULL AND ended_at < now() - make_interval(days => $1)", [BLOCKED_RETRY_DAYS]);
}

async function discoverableByPhone(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ by_phone: boolean }>("SELECT by_phone FROM discovery_settings WHERE user_id = $1", [userId]);
  return rows[0]?.by_phone ?? true;
}

export async function setDiscovery(db: Db, userId: string, byPhone: boolean) {
  await db.query(
    `INSERT INTO discovery_settings (user_id, by_phone) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET by_phone = EXCLUDED.by_phone`,
    [userId, byPhone],
  );
  return { by_phone: byPhone };
}

export async function getDiscovery(db: Db, userId: string) {
  return { by_phone: await discoverableByPhone(db, userId) };
}

/**
 * Links a number to an account (admin CLI only in phase 0). A number held by another account is refused unless `force`,
 * which starts the same move as a proof. `now` is for staff fixes: the number moves at once, and the log says so.
 */
export async function linkPhone(db: Db, hasher: PhoneHasher, userId: string, raw: string, force: boolean, now = false): Promise<ProofResult> {
  const e164 = normalizePhone(raw);
  if (!e164) throw new Error("not a valid mobile number");
  // ADR 0197: a number is proved or absent. A person with another number is found by handle, QR or invite.
  if (!coreProvesPhone(e164)) throw new Error("this region does not prove numbers of this country");
  const hash = hasher.hash(e164);
  const sealed = hasher.seal(e164);
  return transaction<ProofResult>(db, async (client) => {
    const { rows } = await client.query<{ user_id: string }>("SELECT user_id FROM phone_links WHERE phone_hmac = $1 FOR UPDATE", [hash]);
    const holder = rows[0]?.user_id;
    if (holder && holder !== userId) {
      if (now) {
        await client.query("DELETE FROM phone_moves WHERE phone_hmac = $1 AND state = 'waiting'", [hash]);
        await client.query("DELETE FROM phone_links WHERE phone_hmac = $1", [hash]);
        await setLink(client, userId, hash, "admin", sealed);
        await recordMoveFacts(client, holder, userId);
        console.log(`phones: staff moved a number from ${holder} to ${userId}`);
        return { outcome: "linked" };
      }
      if (!force) throw new Error(`number is linked to ${holder}; use --force to start a move or --now to move it at once`);
    }
    return recordProof(client, userId, hash, sealed, "admin");
  });
}
