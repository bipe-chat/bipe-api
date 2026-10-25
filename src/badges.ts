// Signed badges (bipe#399, ADR 0123; format: bipe-shared/docs/badge-attestation.md). The server signs on
// read: a verified claim plus the account's cross-signing master key from Synapse give a lvl "cnpj" badge;
// a verified person (person_verifications, bipe#543) gives a lvl "pix" or "govbr" badge bound to a device key.
// Fail closed: no signing key, no master key or no registry record means no badge (404).
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { Db } from "./db.js";
import { cvmField } from "./cvm.js";
import { badgeRules, brandMarkRules } from "./registry.js";

const KID = /^prod-\d{4}-(0[1-9]|1[0-2])$/;
// Matrix unpadded base64 of a 32-byte Ed25519 key (master key and device key).
const MASTER_KEY = /^[A-Za-z0-9+/]{43}$/;
const DAY = 86_400;

export type BadgeEnvelope = { v: 1; kid: string; payload: string; sig: string };
/** 404: no badge. 410: the claim was revoked (contract BadgeGone). */
export type BadgeResult =
  | { status: 200; envelope: BadgeEnvelope }
  | { status: 404 }
  | { status: 410; reason: "revoked" | "not_active" | "not_found" | "staff" };

type ClaimRow = {
  cnpj: string;
  status: string;
  reason: string | null;
  method: string | null;
  verified_at: Date | null;
  active: boolean | null;
  legal_name: string | null;
  trade_name: string | null;
  release_month: string | null;
  cnae_main: string | null;
  cnae_secondary: string[] | null;
};
type Cached = { key: string; exp: number; envelope: BadgeEnvelope };

export class Badges {
  private readonly key: { kid: string; privateKey: KeyObject } | null;
  private readonly synapse: pg.Pool | null;
  private readonly cache = new Map<string, Cached>();

  /** keyDir holds key.pem (PKCS#8 Ed25519) and kid, mounted from Secret bipe-badge-key. */
  constructor(private readonly db: Db, opts: { keyDir?: string; synapseUrl?: string }) {
    this.key = opts.keyDir ? loadKey(opts.keyDir) : null;
    this.synapse = opts.synapseUrl ? new pg.Pool({ connectionString: opts.synapseUrl, max: 2 }) : null;
  }

  /** For the start log only. Never the key itself. */
  get state(): string {
    if (!this.key) return "off (no signing key)";
    if (!this.synapse) return "off (no SYNAPSE_DATABASE_URL)";
    const trusted = this.key.kid in badgeRules.keys ? "" : ", not in registries/badge-keys.json: the apps reject its badges";
    return `on (kid ${this.key.kid}${trusted})`;
  }

  async forUser(userId: string, now = Math.floor(Date.now() / 1000)): Promise<BadgeResult> {
    const { rows } = await this.db.query<ClaimRow>(
      `SELECT c.cnpj, c.status, c.reason, c.method, c.verified_at, r.active, r.legal_name, r.trade_name, r.release_month,
              r.cnae_main, r.cnae_secondary
         FROM business_claims c LEFT JOIN cnpj_registry r ON r.cnpj = c.cnpj WHERE c.user_id = $1`,
      [userId],
    );
    const claim = rows[0];
    if (claim?.status === "revoked") return { status: 410, reason: goneReason(claim.reason) };
    // No verified company: a verified person (trust step 4 or 5, bipe#543) can still have a badge.
    if (claim?.status !== "verified") return this.personBadge(userId, now);
    if (!claim.method || !claim.verified_at) return { status: 404 };
    if (!claim.active || !claim.legal_name || !claim.release_month || !this.key || !this.synapse) return { status: 404 };
    const msk = await this.masterKey(userId);
    if (!msk) return { status: 404 };

    // CVM register line (ADR 0077): read at issue and renewal; a changed line changes the cache key below.
    const cvm = await cvmField(this.db, claim.cnpj, [claim.cnae_main, ...(claim.cnae_secondary ?? [])], now * 1000).catch(() => undefined);
    // A changed claim, registry record, CVM line or master key needs a new signature at once.
    const cacheKey = JSON.stringify([claim.cnpj, claim.method, claim.verified_at.toISOString(), claim.legal_name, claim.trade_name, claim.release_month, msk, this.key.kid, cvm ?? null]);
    const cached = this.cache.get(userId);
    if (cached && cached.key === cacheKey && now < cached.exp - badgeRules.renewDaysBeforeExpiry * DAY) {
      return { status: 200, envelope: cached.envelope };
    }
    const iat = now;
    const exp = iat + badgeRules.lifeDays * DAY;
    // Field order is fixed here; verifiers check the exact bytes, so the order does not matter to them.
    const payload = {
      sub: userId,
      lvl: "cnpj",
      name: claim.trade_name || claim.legal_name,
      cnpj: claim.cnpj,
      legal_name: claim.legal_name,
      ...(claim.trade_name ? { trade_name: claim.trade_name } : {}),
      method: claim.method,
      checked_month: claim.release_month,
      ...(cvm ? { cvm } : {}),
      msk,
      iat,
      exp,
    };
    const envelope = this.signPayload(payload);
    this.cache.set(userId, { key: cacheKey, exp, envelope });
    return { status: 200, envelope };
  }

  /**
   * The brand behind a mark (ADR 0162): a verified claim with an active registry record, as for its own badge.
   * Its name is the name of the brand's CNPJ badge. null: the account may not grant marks.
   */
  async verifiedBrand(userId: string): Promise<{ name: string; cnpj: string } | null> {
    const { rows } = await this.db.query<{ cnpj: string; legal_name: string | null; trade_name: string | null }>(
      `SELECT c.cnpj, r.legal_name, r.trade_name FROM business_claims c JOIN cnpj_registry r ON r.cnpj = c.cnpj
        WHERE c.user_id = $1 AND c.status = 'verified' AND c.method IS NOT NULL AND c.verified_at IS NOT NULL
          AND r.active AND r.legal_name IS NOT NULL AND r.release_month IS NOT NULL`,
      [userId],
    );
    const row = rows[0];
    return row?.legal_name ? { name: row.trade_name || row.legal_name, cnpj: row.cnpj } : null;
  }

  /**
   * The active brand marks of a reseller's work account as lvl "brand-mark" envelopes (ADR 0162 point 7), oldest
   * grant first. A mark whose brand lost its seal is left out. No signing key or no master key: no marks.
   */
  async brandMarks(userId: string, now = Math.floor(Date.now() / 1000)): Promise<BadgeEnvelope[]> {
    if (!this.key || !this.synapse) return [];
    const { rows } = await this.db.query<{ id: string; brand_user_id: string; label: string }>(
      `SELECT id, brand_user_id, label FROM brand_marks WHERE reseller_user_id = $1 AND ended_at IS NULL
        ORDER BY granted_at, id LIMIT $2`,
      [userId, brandMarkRules.maxPerAccount],
    );
    if (rows.length === 0) return [];
    const msk = await this.masterKey(userId);
    if (!msk) return [];
    const envelopes: BadgeEnvelope[] = [];
    for (const mark of rows) {
      const brand = await this.verifiedBrand(mark.brand_user_id);
      if (!brand || !brandMarkRules.labels.includes(mark.label)) continue;
      const cacheKey = JSON.stringify([mark.id, mark.brand_user_id, mark.label, brand.name, brand.cnpj, msk, this.key.kid]);
      const cached = this.cache.get(`mark:${mark.id}`);
      if (cached && cached.key === cacheKey && now < cached.exp - badgeRules.renewDaysBeforeExpiry * DAY) {
        envelopes.push(cached.envelope);
        continue;
      }
      const exp = now + badgeRules.lifeDays * DAY;
      const payload = {
        sub: userId,
        lvl: "brand-mark",
        name: brand.name,
        mark: mark.id,
        brand: mark.brand_user_id,
        cnpj: brand.cnpj,
        label: mark.label,
        msk,
        iat: now,
        exp,
      };
      const envelope = this.signPayload(payload);
      this.cache.set(`mark:${mark.id}`, { key: cacheKey, exp, envelope });
      envelopes.push(envelope);
    }
    return envelopes;
  }

  /** A person badge (lvl pix or govbr), bound to the device key the user verified from. */
  private async personBadge(userId: string, now: number): Promise<BadgeResult> {
    if (!this.key) return { status: 404 };
    const { rows } = await this.db.query<{ level: string; verified_name: string; device_key: string; verified_at: Date }>(
      "SELECT level, verified_name, device_key, verified_at FROM person_verifications WHERE user_id = $1",
      [userId],
    );
    const person = rows[0];
    if (!person) return { status: 404 };
    const cacheKey = JSON.stringify([person.level, person.verified_name, person.device_key, person.verified_at.toISOString(), this.key.kid]);
    const cached = this.cache.get(userId);
    if (cached && cached.key === cacheKey && now < cached.exp - badgeRules.renewDaysBeforeExpiry * DAY) {
      return { status: 200, envelope: cached.envelope };
    }
    const exp = now + badgeRules.lifeDays * DAY;
    const payload = { sub: userId, lvl: person.level, name: person.verified_name, dev: person.device_key, iat: now, exp };
    const envelope = this.signPayload(payload);
    this.cache.set(userId, { key: cacheKey, exp, envelope });
    return { status: 200, envelope };
  }

  private signPayload(payload: Record<string, unknown>): BadgeEnvelope {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    return {
      v: 1,
      kid: this.key!.kid,
      payload: bytes.toString("base64url"),
      sig: sign(null, bytes, this.key!.privateKey).toString("base64url"),
    };
  }

  /**
   * The Ed25519 key of one Matrix device (unpadded base64), from Synapse e2e_device_keys_json, or null.
   * Needs the column grant in bipe-infra scripts/setup-growth.sh.
   */
  async deviceKey(userId: string, deviceId: string): Promise<string | null> {
    if (!this.synapse) return null;
    const { rows } = await this.synapse.query<{ key_json: string }>(
      "SELECT key_json FROM e2e_device_keys_json WHERE user_id = $1 AND device_id = $2",
      [userId, deviceId],
    );
    if (!rows[0]) return null;
    try {
      const data = JSON.parse(rows[0].key_json) as { user_id?: unknown; device_id?: unknown; keys?: Record<string, unknown> };
      if (data.user_id !== userId || data.device_id !== deviceId) return null;
      const key = data.keys?.[`ed25519:${deviceId}`];
      return typeof key === "string" && MASTER_KEY.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  /** The newest master key Synapse holds for the user, or null. Public key JSON; anything unexpected is null. */
  private async masterKey(userId: string): Promise<string | null> {
    const { rows } = await this.synapse!.query<{ keydata: string }>(
      "SELECT keydata FROM e2e_cross_signing_keys WHERE user_id = $1 AND keytype = 'master' ORDER BY stream_id DESC LIMIT 1",
      [userId],
    );
    if (!rows[0]) return null;
    try {
      const data = JSON.parse(rows[0].keydata) as { user_id?: unknown; usage?: unknown; keys?: Record<string, unknown> };
      if (data.user_id !== userId || !Array.isArray(data.usage) || !data.usage.includes("master")) return null;
      const entries = Object.entries(data.keys ?? {});
      if (entries.length !== 1) return null;
      const [id, key] = entries[0]!;
      return typeof key === "string" && id === `ed25519:${key}` && MASTER_KEY.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.synapse?.end();
  }
}

function goneReason(reason: string | null): "revoked" | "not_active" | "not_found" | "staff" {
  return reason === "not_active" || reason === "not_found" || reason === "staff" ? reason : "revoked";
}

/** Missing files: badges off. A present but bad key stops the start, so a broken secret does not go unseen. */
function loadKey(dir: string): { kid: string; privateKey: KeyObject } | null {
  let pem: string, kid: string;
  try {
    pem = readFileSync(join(dir, "key.pem"), "utf8");
    kid = readFileSync(join(dir, "kid"), "utf8").trim();
  } catch {
    return null;
  }
  if (!KID.test(kid)) throw new Error("badge key: kid must be prod-YYYY-MM");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("badge key: not an Ed25519 key");
  return { kid, privateKey };
}
