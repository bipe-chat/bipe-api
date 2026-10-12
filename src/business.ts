// CNPJ verification for business accounts (ADR 0042, docs/cnpj-verification.md). One claim per account;
// one verified account per CNPJ. The registry comes from the Receita release on disk (cnpj-registry.ts).
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import type pkijs from "pkijs";
import type { Config } from "./config.js";
import { latestRelease, scanRelease } from "./cnpj-registry.js";
import type { Db } from "./db.js";
import { verifyEcnpjSignature } from "./ecnpj.js";
import { ApiError } from "./errors.js";
import { cnpjRoot, formatCnpj, reservedNameClaims, validCnpj } from "./registry.js";

const MAX_DOMAINS = 5;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type ClaimRow = {
  user_id: string;
  cnpj: string;
  status: "registry_pending" | "awaiting_proof" | "verified" | "rejected" | "revoked";
  reason: string | null;
  challenge: string;
  method: string | null;
  verified_at: Date | null;
};
type RegistryRow = { active: boolean; legal_name: string | null; trade_name: string | null; release_month: string };
type DomainRow = { domain: string; token: string; verified_at: Date | null };

const txtName = (domain: string) => `_proseio.${domain}`;
const txtValue = (token: string) => `proseio-verification=${token}`;

async function claimOf(db: Db, userId: string): Promise<ClaimRow | null> {
  const { rows } = await db.query<ClaimRow>("SELECT * FROM business_claims WHERE user_id = $1", [userId]);
  return rows[0] ?? null;
}

async function registryOf(db: Db, cnpj: string): Promise<RegistryRow | null> {
  const { rows } = await db.query<RegistryRow>("SELECT active, legal_name, trade_name, release_month FROM cnpj_registry WHERE cnpj = $1", [cnpj]);
  return rows[0] ?? null;
}

/** The claim as the contract's BusinessClaim. */
export async function getClaim(db: Db, userId: string) {
  const claim = await claimOf(db, userId);
  if (!claim) throw new ApiError("not_found");
  const reg = await registryOf(db, claim.cnpj);
  const { rows: domains } = await db.query<DomainRow>("SELECT domain, token, verified_at FROM business_domains WHERE user_id = $1 ORDER BY domain", [userId]);
  return {
    cnpj: claim.cnpj,
    status: claim.status,
    ...(claim.reason ? { reason: claim.reason } : {}),
    ...(reg && reg.legal_name
      ? { registry: { active: reg.active, legal_name: reg.legal_name, ...(reg.trade_name ? { trade_name: reg.trade_name } : {}), checked_month: reg.release_month } }
      : {}),
    ...(claim.status === "awaiting_proof" ? { challenge: claim.challenge } : {}),
    ...(claim.method ? { method: claim.method } : {}),
    ...(claim.verified_at ? { verified_at: claim.verified_at.toISOString() } : {}),
    domains: domains.map((d) => ({
      domain: d.domain,
      txt_name: txtName(d.domain),
      txt_value: txtValue(d.token),
      ...(d.verified_at ? { verified_at: d.verified_at.toISOString() } : {}),
    })),
    reserved_names: reg ? reservedNameClaims([reg.legal_name, reg.trade_name], cnpjRoot(claim.cnpj)) : [],
  };
}

/** Starts (or restarts) the caller's claim. A verified claim must be withdrawn first. */
export async function createClaim(db: Db, config: Config, userId: string, raw: string, kickScan: () => void) {
  const cnpj = validCnpj(raw);
  if (!cnpj) throw new ApiError("cnpj_invalid");
  const existing = await claimOf(db, userId);
  if (existing?.status === "verified") throw new ApiError("bad_request", "already_verified");
  const { rowCount: taken } = await db.query("SELECT 1 FROM business_claims WHERE cnpj = $1 AND status = 'verified' AND user_id <> $2", [cnpj, userId]);
  if (taken) throw new ApiError("cnpj_taken");

  const date = new Date().toISOString().slice(0, 10);
  const challenge =
    `Proseio: a empresa de CNPJ ${formatCnpj(cnpj)} autoriza a conta ${userId} a representar a empresa no Proseio. ` +
    `Código ${randomBytes(9).toString("base64url")}. ${date}.`;

  const release = latestRelease(config.RECEITA_DIR);
  const reg = await registryOf(db, cnpj);
  const fresh = reg && release && reg.release_month === release.month;
  const status = !fresh ? "registry_pending" : reg.active ? "awaiting_proof" : "rejected";
  await db.query(
    `INSERT INTO business_claims (user_id, cnpj, status, reason, challenge) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET cnpj = EXCLUDED.cnpj, status = EXCLUDED.status, reason = EXCLUDED.reason,
       challenge = EXCLUDED.challenge, method = NULL, created_at = now(), verified_at = NULL, ended_at = NULL`,
    [userId, cnpj, status, status === "rejected" ? "not_active" : null, challenge],
  );
  if (existing && existing.cnpj !== cnpj) await db.query("DELETE FROM business_domains WHERE user_id = $1", [userId]);
  if (status === "registry_pending") kickScan();
  return getClaim(db, userId);
}

export async function withdrawClaim(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM business_claims WHERE user_id = $1", [userId]);
}

/** e-CNPJ proof: the certificate's company (CNPJ root) must be the claimed company, and the CNPJ must be active. */
export async function proveWithEcnpj(db: Db, userId: string, signature: string, roots: pkijs.Certificate[]) {
  const claim = await claimOf(db, userId);
  if (!claim) throw new ApiError("not_found");
  if (claim.status !== "awaiting_proof") throw new ApiError("bad_request", claim.status);
  const reg = await registryOf(db, claim.cnpj);
  if (!reg?.active) throw new ApiError("cnpj_not_active");
  const { cnpj } = await verifyEcnpjSignature(signature, claim.challenge, roots);
  if (cnpjRoot(cnpj) !== cnpjRoot(claim.cnpj)) throw new ApiError("signature_invalid", "cnpj_mismatch");
  try {
    await db.query(
      "UPDATE business_claims SET status = 'verified', method = 'ecnpj', verified_at = now(), reason = NULL WHERE user_id = $1 AND status = 'awaiting_proof'",
      [userId],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ApiError("cnpj_taken");
    throw e;
  }
  return getClaim(db, userId);
}

export async function addDomain(db: Db, userId: string, raw: string) {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(domain)) throw new ApiError("bad_request", "domain");
  const claim = await claimOf(db, userId);
  if (!claim || claim.status === "rejected" || claim.status === "revoked") throw new ApiError("not_found");
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM business_domains WHERE user_id = $1", [userId]);
  if (Number(rows[0]!.n) >= MAX_DOMAINS) throw new ApiError("bad_request", "too_many_domains");
  const token = randomBytes(18).toString("base64url");
  await db.query("INSERT INTO business_domains (user_id, domain, token) VALUES ($1, $2, $3) ON CONFLICT (user_id, domain) DO NOTHING", [userId, domain, token]);
  const { rows: d } = await db.query<DomainRow>("SELECT domain, token, verified_at FROM business_domains WHERE user_id = $1 AND domain = $2", [userId, domain]);
  return { domain, txt_name: txtName(domain), txt_value: txtValue(d[0]!.token), ...(d[0]!.verified_at ? { verified_at: d[0]!.verified_at.toISOString() } : {}) };
}

export async function checkDomain(db: Db, userId: string, raw: string) {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  const { rows } = await db.query<DomainRow>("SELECT domain, token, verified_at FROM business_domains WHERE user_id = $1 AND domain = $2", [userId, domain]);
  const row = rows[0];
  if (!row) throw new ApiError("not_found");
  let found = false;
  try {
    found = (await resolveTxt(txtName(domain))).some((parts) => parts.join("") === txtValue(row.token));
  } catch {
    found = false; // NXDOMAIN, no TXT, timeout: not verified (yet)
  }
  const { rows: updated } = await db.query<DomainRow>(
    `UPDATE business_domains SET last_checked_at = now(), verified_at = CASE WHEN $3 THEN coalesce(verified_at, now()) ELSE NULL END
     WHERE user_id = $1 AND domain = $2 RETURNING domain, token, verified_at`,
    [userId, domain, found],
  );
  const d = updated[0]!;
  return { domain, txt_name: txtName(domain), txt_value: txtValue(d.token), ...(d.verified_at ? { verified_at: d.verified_at.toISOString() } : {}) };
}

// --- Registry scans ------------------------------------------------------------------------------------

let scanning: Promise<void> | null = null;

/**
 * Scans the newest release on disk for claimed CNPJs and moves claims on. mode "pending" looks only at claims
 * waiting for the registry; mode "all" also re-checks open and verified claims (run after each monthly
 * download). A verified CNPJ that is no longer active is revoked. One scan at a time per process; a Postgres
 * advisory lock keeps two processes (API and CLI) apart.
 */
export function runScan(db: Db, config: Config, mode: "pending" | "all", log: (s: string) => void = console.log): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const release = latestRelease(config.RECEITA_DIR);
    if (!release) return log("cnpj scan: no complete Receita release on disk");
    const client = await db.connect();
    let locked = false;
    try {
      const { rows: lock } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(7140142) AS ok");
      locked = lock[0]!.ok;
      if (!locked) return log("cnpj scan: another scan is running");
      const statuses = mode === "pending" ? ["registry_pending"] : ["registry_pending", "awaiting_proof", "verified"];
      const { rows: claims } = await client.query<{ user_id: string; cnpj: string; status: string }>(
        "SELECT user_id, cnpj, status FROM business_claims WHERE status = ANY($1)",
        [statuses],
      );
      if (claims.length === 0) return;
      const started = Date.now();
      const found = await scanRelease(release, new Set(claims.map((c) => c.cnpj)));
      for (const cnpj of new Set(claims.map((c) => c.cnpj))) {
        const e = found.establishments.get(cnpj);
        await client.query(
          `INSERT INTO cnpj_registry (cnpj, active, status_code, legal_name, trade_name, release_month, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (cnpj) DO UPDATE SET active = EXCLUDED.active, status_code = EXCLUDED.status_code, legal_name = EXCLUDED.legal_name,
             trade_name = EXCLUDED.trade_name, release_month = EXCLUDED.release_month, checked_at = now()`,
          [cnpj, e?.active ?? false, e?.statusCode ?? null, found.legalNames.get(cnpjRoot(cnpj)) ?? null, e?.tradeName ?? null, release.month],
        );
      }
      for (const [root, partners] of found.partners) {
        await client.query("DELETE FROM cnpj_partners WHERE root = $1", [root]);
        for (const p of partners) {
          await client.query("INSERT INTO cnpj_partners (root, kind, name, doc, qualification, release_month) VALUES ($1, $2, $3, $4, $5, $6)", [root, p.kind, p.name, p.doc, p.qualification, release.month]);
        }
      }
      for (const c of claims) {
        const active = found.establishments.get(c.cnpj)?.active ?? false;
        const notFound = !found.establishments.has(c.cnpj);
        if (c.status === "registry_pending") {
          await client.query("UPDATE business_claims SET status = $2, reason = $3 WHERE user_id = $1 AND status = 'registry_pending'", [
            c.user_id, active ? "awaiting_proof" : "rejected", active ? null : notFound ? "not_found" : "not_active",
          ]);
        } else if (!active) {
          await client.query("UPDATE business_claims SET status = $2, reason = $3, ended_at = now() WHERE user_id = $1", [
            c.user_id, c.status === "verified" ? "revoked" : "rejected", notFound ? "not_found" : "not_active",
          ]);
        }
      }
      log(`cnpj scan (${mode}, release ${release.month}): ${claims.length} claims in ${Math.round((Date.now() - started) / 1000)} s`);
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(7140142)").catch(() => {});
      client.release();
    }
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

// --- Staff ---------------------------------------------------------------------------------------------

/** Staff path (ADR 0042: cases neither proof covers). The registry must still show the CNPJ as active. */
export async function verifyByStaff(db: Db, userId: string): Promise<void> {
  const claim = await claimOf(db, userId);
  if (!claim) throw new Error(`no claim for ${userId}`);
  const reg = await registryOf(db, claim.cnpj);
  if (!reg?.active) throw new Error(`registry does not show ${claim.cnpj} as active (status ${claim.status})`);
  await db.query("UPDATE business_claims SET status = 'verified', method = 'staff', verified_at = now(), reason = NULL WHERE user_id = $1", [userId]);
}

export async function revokeByStaff(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE business_claims SET status = 'revoked', reason = 'staff', ended_at = now() WHERE user_id = $1 AND status = 'verified'", [userId]);
}
