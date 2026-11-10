// Organisation verification for business accounts (ADR 0042, docs/cnpj-verification.md; schemes: ADR 0272). One claim
// per account; one verified account per organisation in a scheme. The scheme adapters (schemes.ts) hold the registry
// and the control proof. The routes are Brazilian: they take and answer a CNPJ, the ID of scheme br.cnpj.
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { orgScheme, type ControlProof, type RegistryLookup } from "./schemes.js";
import { brCnpj } from "./schemes-br.js";

const MAX_DOMAINS = 5;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type ClaimRow = {
  user_id: string;
  scheme: string;
  org_id: string;
  status: "registry_pending" | "awaiting_proof" | "verified" | "rejected" | "revoked";
  reason: string | null;
  challenge: string;
  method: string | null;
  verified_at: Date | null;
};
type DomainRow = { domain: string; token: string; verified_at: Date | null };

const txtName = (domain: string) => `_bipe.${domain}`;
const txtValue = (token: string) => `bipe-verification=${token}`;

async function claimOf(db: Db, userId: string): Promise<ClaimRow | null> {
  const { rows } = await db.query<ClaimRow>("SELECT * FROM business_claims WHERE user_id = $1", [userId]);
  return rows[0] ?? null;
}

/** The claim as the contract's BusinessClaim. The contract calls the organisation ID `cnpj`. */
export async function getClaim(db: Db, userId: string) {
  const claim = await claimOf(db, userId);
  if (!claim) throw new ApiError("not_found");
  const scheme = orgScheme(claim.scheme);
  const reg = await scheme.record(db, claim.org_id);
  const { rows: domains } = await db.query<DomainRow>("SELECT domain, token, verified_at FROM business_domains WHERE user_id = $1 ORDER BY domain", [userId]);
  return {
    cnpj: claim.org_id,
    status: claim.status,
    ...(claim.reason ? { reason: claim.reason } : {}),
    ...(reg && reg.legalName
      ? { registry: { active: reg.active, legal_name: reg.legalName, ...(reg.tradeName ? { trade_name: reg.tradeName } : {}), checked_month: reg.checkedMonth } }
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
    reserved_names: reg ? scheme.reservedNames(reg, claim.org_id) : [],
  };
}

/**
 * Starts (or restarts) the caller's claim. A verified claim must be withdrawn first. The scheme defaults to br.cnpj,
 * the scheme of the Brazilian routes. Its errors keep their contract names (cnpj_invalid, cnpj_taken).
 */
export async function createClaim(db: Db, config: Config, userId: string, raw: string, kickScan: () => void, scheme: RegistryLookup = brCnpj) {
  const orgId = scheme.parseOrgId(raw);
  if (!orgId) throw new ApiError("cnpj_invalid");
  const existing = await claimOf(db, userId);
  if (existing?.status === "verified") throw new ApiError("bad_request", "already_verified");
  const { rowCount: taken } = await db.query(
    "SELECT 1 FROM business_claims WHERE scheme = $1 AND org_id = $2 AND status = 'verified' AND user_id <> $3",
    [scheme.scheme, orgId, userId],
  );
  if (taken) throw new ApiError("cnpj_taken");

  const date = new Date().toISOString().slice(0, 10);
  const challenge = scheme.challenge(orgId, userId, randomBytes(9).toString("base64url"), date);

  const month = scheme.latestMonth(config);
  const reg = await scheme.record(db, orgId);
  const fresh = reg && month && reg.checkedMonth === month;
  const status = !fresh ? "registry_pending" : reg.active ? "awaiting_proof" : "rejected";
  await db.query(
    `INSERT INTO business_claims (user_id, scheme, org_id, status, reason, challenge) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET scheme = EXCLUDED.scheme, org_id = EXCLUDED.org_id, status = EXCLUDED.status, reason = EXCLUDED.reason,
       challenge = EXCLUDED.challenge, method = NULL, created_at = now(), verified_at = NULL, ended_at = NULL`,
    [userId, scheme.scheme, orgId, status, status === "rejected" ? "not_active" : null, challenge],
  );
  if (existing && (existing.scheme !== scheme.scheme || existing.org_id !== orgId)) await db.query("DELETE FROM business_domains WHERE user_id = $1", [userId]);
  if (status === "registry_pending") kickScan();
  return getClaim(db, userId);
}

export async function withdrawClaim(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM business_claims WHERE user_id = $1", [userId]);
}

/** A control proof (e-CNPJ for br.cnpj) of the claimed organisation. The registry must show it as active. */
export async function proveControl(db: Db, userId: string, signature: string, proof: ControlProof) {
  const claim = await claimOf(db, userId);
  if (!claim) throw new ApiError("not_found");
  if (claim.status !== "awaiting_proof") throw new ApiError("bad_request", claim.status);
  if (claim.scheme !== proof.scheme) throw new ApiError("bad_request", "wrong_scheme");
  const reg = await orgScheme(claim.scheme).record(db, claim.org_id);
  if (!reg?.active) throw new ApiError("cnpj_not_active");
  await proof.verify(signature, claim.challenge, claim.org_id);
  try {
    await db.query(
      "UPDATE business_claims SET status = 'verified', method = $2, verified_at = now(), reason = NULL WHERE user_id = $1 AND status = 'awaiting_proof'",
      [userId, proof.method],
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
 * Refreshes the registry records of claimed organisations and moves claims on. mode "pending" looks only at claims
 * waiting for the registry; mode "all" also re-checks open and verified claims (run after each monthly download).
 * A verified organisation that is no longer active is revoked. One scan at a time per process; a Postgres advisory
 * lock keeps two processes (API and CLI) apart.
 */
export function runScan(db: Db, config: Config, mode: "pending" | "all", log: (s: string) => void = console.log): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const client = await db.connect();
    let locked = false;
    try {
      const { rows: lock } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(7140142) AS ok");
      locked = lock[0]!.ok;
      if (!locked) return log("registry scan: another scan is running");
      const statuses = mode === "pending" ? ["registry_pending"] : ["registry_pending", "awaiting_proof", "verified"];
      const { rows: claims } = await client.query<{ user_id: string; scheme: string; org_id: string; status: string }>(
        "SELECT user_id, scheme, org_id, status FROM business_claims WHERE status = ANY($1)",
        [statuses],
      );
      for (const id of new Set(claims.map((c) => c.scheme))) {
        const scheme = orgScheme(id);
        const mine = claims.filter((c) => c.scheme === id);
        const started = Date.now();
        const found = await scheme.refresh(client, config, mine.map((c) => c.org_id));
        if (!found) {
          log(`${id} scan: no complete registry copy`);
          continue;
        }
        for (const c of mine) {
          const state = found.states.get(c.org_id) ?? "not_found";
          if (c.status === "registry_pending") {
            await client.query("UPDATE business_claims SET status = $2, reason = $3 WHERE user_id = $1 AND status = 'registry_pending'", [
              c.user_id, state === "active" ? "awaiting_proof" : "rejected", state === "active" ? null : state,
            ]);
          } else if (state !== "active") {
            await client.query("UPDATE business_claims SET status = $2, reason = $3, ended_at = now() WHERE user_id = $1", [
              c.user_id, c.status === "verified" ? "revoked" : "rejected", state,
            ]);
          }
        }
        log(`${id} scan (${mode}, registry ${found.month}): ${mine.length} claims in ${Math.round((Date.now() - started) / 1000)} s`);
      }
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

/** Staff path (ADR 0042: cases neither proof covers). The registry must still show the organisation as active. */
export async function verifyByStaff(db: Db, userId: string): Promise<void> {
  const claim = await claimOf(db, userId);
  if (!claim) throw new Error(`no claim for ${userId}`);
  const reg = await orgScheme(claim.scheme).record(db, claim.org_id);
  if (!reg?.active) throw new Error(`registry does not show ${claim.scheme} ${claim.org_id} as active (status ${claim.status})`);
  await db.query("UPDATE business_claims SET status = 'verified', method = 'staff', verified_at = now(), reason = NULL WHERE user_id = $1", [userId]);
}

export async function revokeByStaff(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE business_claims SET status = 'revoked', reason = 'staff', ended_at = now() WHERE user_id = $1 AND status = 'verified'", [userId]);
}
