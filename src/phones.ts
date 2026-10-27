import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { normalizePhone, phoneRules } from "./registry.js";

// Phone-number discovery, phase 0 (bipe/docs/phone-link.md). Lookup compares HMAC-SHA256 with a server secret.
// The linked number itself is stored only encrypted (number_enc, ADR 0191) and goes back only to its owner in
// GET /v1/me/phone and the data export. Numbers are never logged.
// Linking from the apps needs a proof (Pix phone key or SMS code, phases 1 and 2); until then
// only the admin CLI links numbers.

// Yearly confirmation (bipe#470): registries/phone-numbers.json linkConfirmMonths, the same value the apps read.
const CONFIRM_MONTHS = phoneRules.linkConfirmMonths;
export const LOOKUP_MAX_PER_REQUEST = 500;
const LOOKUP_DAILY_BUDGET = 2000;
const LOOKUP_DAILY_BUDGET_NEW_ACCOUNT = 300;
const NEW_ACCOUNT_DAYS = 7;
const DAY_MS = 86_400_000;

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

  const { rows } = await db.query<{ phone_hmac: string; user_id: string }>(
    `SELECT p.phone_hmac, p.user_id FROM phone_links p
     LEFT JOIN discovery_settings d ON d.user_id = p.user_id
     WHERE p.phone_hmac = ANY($1) AND p.user_id <> $2
       AND p.confirmed_at > now() - make_interval(months => $3)
       AND COALESCE(d.by_phone, true)`,
    [[...byHash.keys()], userId, CONFIRM_MONTHS],
  );
  return { matches: rows.map((r) => ({ phone: byHash.get(r.phone_hmac)!, user_id: r.user_id })) };
}

/** GET /v1/me/phone: the caller's own link. `number` is the caller's own number only (ADR 0191); null for older links. */
export async function myPhone(db: Db, hasher: PhoneHasher, userId: string) {
  const { rows } = await db.query<{ method: string; linked_at: Date; confirmed_at: Date; number_enc: Buffer | null }>(
    "SELECT method, linked_at, confirmed_at, number_enc FROM phone_links WHERE user_id = $1",
    [userId],
  );
  const discoverable = await discoverableByPhone(db, userId);
  const link = rows[0];
  if (!link) return { linked: false, discoverable_by_phone: discoverable };
  const confirmBy = new Date(link.confirmed_at);
  confirmBy.setMonth(confirmBy.getMonth() + CONFIRM_MONTHS);
  return {
    linked: true,
    method: link.method,
    linked_at: link.linked_at.toISOString(),
    confirm_by: confirmBy.toISOString(),
    number: hasher.open(link.number_enc),
    discoverable_by_phone: discoverable,
  };
}

export async function unlinkPhone(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM phone_links WHERE user_id = $1", [userId]);
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
 * Links a number to an account (admin CLI only in phase 0). A number held by another account is refused
 * unless `force`: the 7-day re-link hold with alerts comes with the proofs in phases 1 and 2.
 */
export async function linkPhone(db: Db, hasher: PhoneHasher, userId: string, raw: string, force: boolean): Promise<string> {
  const e164 = normalizePhone(raw);
  if (!e164) throw new Error("not a Brazilian mobile number");
  const hash = hasher.hash(e164);
  const sealed = hasher.seal(e164);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ user_id: string }>("SELECT user_id FROM phone_links WHERE phone_hmac = $1 FOR UPDATE", [hash]);
    const holder = rows[0]?.user_id;
    if (holder && holder !== userId) {
      if (!force) throw new Error(`number is linked to ${holder}; use --force to move it`);
      await client.query("DELETE FROM phone_links WHERE phone_hmac = $1", [hash]);
    }
    await client.query(
      `INSERT INTO phone_links (user_id, phone_hmac, method, number_enc) VALUES ($1, $2, 'admin', $3)
       ON CONFLICT (user_id) DO UPDATE SET phone_hmac = EXCLUDED.phone_hmac, method = 'admin', number_enc = EXCLUDED.number_enc,
         linked_at = now(), confirmed_at = now()`,
      [userId, hash, sealed],
    );
    await client.query("COMMIT");
    return e164;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
