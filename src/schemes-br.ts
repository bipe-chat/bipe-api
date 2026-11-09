// Brazil, the first verification scheme (bipe ADR 0272, bipe-chat/bipe#1194). The only place outside the Brazilian
// rails themselves (cnpj-registry.ts, ecnpj.ts, govbr.ts, cvm.ts) that knows CNPJ and CPF.
// - br.cnpj: the Receita open data copy on disk (cnpj-registry.ts, ADR 0042), cached in cnpj_registry and
//   and the e-CNPJ control proof (ecnpj.ts).
// - br.govbr: the CPF from the gov.br signer certificate, kept only as a keyed hash (govbr.ts).
import { createHmac } from "node:crypto";
import type pg from "pg";
import type * as pkijs from "pkijs";
import { latestRelease, scanRelease } from "./cnpj-registry.js";
import type { Config } from "./config.js";
import { cvmField } from "./cvm.js";
import type { Db } from "./db.js";
import { verifyEcnpjSignature } from "./ecnpj.js";
import { ApiError } from "./errors.js";
import { cnpjRoot, formatCnpj, reservedNameClaims, validCnpj } from "./registry.js";
import type { ControlProof, OrgBadge, PersonProof, RegistryLookup, RegistryRecord, RegistryState } from "./schemes.js";

type CnpjRow = {
  active: boolean;
  legal_name: string | null;
  trade_name: string | null;
  release_month: string;
  cnae_main: string | null;
  cnae_secondary: string[] | null;
};

async function cnpjRow(db: Db, cnpj: string): Promise<CnpjRow | null> {
  const { rows } = await db.query<CnpjRow>(
    "SELECT active, legal_name, trade_name, release_month, cnae_main, cnae_secondary FROM cnpj_registry WHERE cnpj = $1",
    [cnpj],
  );
  return rows[0] ?? null;
}

export const brCnpj: RegistryLookup = {
  scheme: "br.cnpj",

  parseOrgId: (raw) => validCnpj(raw),

  sameOrg: (a, b) => cnpjRoot(a) === cnpjRoot(b),

  challenge: (cnpj, userId, code, date) =>
    `Bipe: a empresa de CNPJ ${formatCnpj(cnpj)} autoriza a conta ${userId} a representar a empresa no Bipe. Código ${code}. ${date}.`,

  async record(db, cnpj): Promise<RegistryRecord | null> {
    const row = await cnpjRow(db, cnpj);
    return row ? { active: row.active, legalName: row.legal_name, tradeName: row.trade_name, checkedMonth: row.release_month } : null;
  },

  latestMonth: (config) => latestRelease(config.RECEITA_DIR)?.month ?? null,

  async refresh(client: pg.PoolClient, config: Config, cnpjs: string[]) {
    const release = latestRelease(config.RECEITA_DIR);
    if (!release) return null;
    const found = await scanRelease(release, new Set(cnpjs));
    const states = new Map<string, RegistryState>();
    for (const cnpj of new Set(cnpjs)) {
      const e = found.establishments.get(cnpj);
      await client.query(
        `INSERT INTO cnpj_registry (cnpj, active, status_code, legal_name, trade_name, release_month, checked_at, cnae_main, cnae_secondary)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
         ON CONFLICT (cnpj) DO UPDATE SET active = EXCLUDED.active, status_code = EXCLUDED.status_code, legal_name = EXCLUDED.legal_name,
           trade_name = EXCLUDED.trade_name, release_month = EXCLUDED.release_month, checked_at = now(),
           cnae_main = EXCLUDED.cnae_main, cnae_secondary = EXCLUDED.cnae_secondary`,
        [cnpj, e?.active ?? false, e?.statusCode ?? null, found.legalNames.get(cnpjRoot(cnpj)) ?? null, e?.tradeName ?? null, release.month,
          e?.cnaeMain ?? null, e?.cnaeSecondary ?? []],
      );
      states.set(cnpj, !e ? "not_found" : e.active ? "active" : "not_active");
    }
    return { month: release.month, states };
  },

  reservedNames: (record, cnpj) => reservedNameClaims([record.legalName, record.tradeName], cnpjRoot(cnpj)),

  async badge(db, cnpj, nowMs): Promise<OrgBadge | null> {
    const row = await cnpjRow(db, cnpj);
    if (!row?.active || !row.legal_name || !row.release_month) return null;
    const legalName = row.legal_name;
    // CVM register line (ADR 0077): read at issue and renewal, so a changed line changes the cache key.
    const cvm = await cvmField(db, cnpj, [row.cnae_main, ...(row.cnae_secondary ?? [])], nowMs).catch(() => undefined);
    return {
      name: row.trade_name || legalName,
      cacheParts: [cnpj, legalName, row.trade_name, row.release_month, cvm ?? null],
      fields: (method) => ({
        lvl: "cnpj",
        name: row.trade_name || legalName,
        cnpj,
        legal_name: legalName,
        ...(row.trade_name ? { trade_name: row.trade_name } : {}),
        method,
        checked_month: row.release_month,
        ...(cvm ? { cvm } : {}),
      }),
    };
  },
};

/** e-CNPJ proof (ADR 0042): the certificate's company (CNPJ root) must be the claimed company. */
export function ecnpjProof(roots: pkijs.Certificate[]): ControlProof {
  return {
    scheme: "br.cnpj",
    method: "ecnpj",
    async verify(signature, challenge, cnpj) {
      const signed = await verifyEcnpjSignature(signature, challenge, roots);
      if (!brCnpj.sameOrg(signed.cnpj, cnpj)) throw new ApiError("signature_invalid", "cnpj_mismatch");
    },
  };
}

/** gov.br: one CPF, one account. The subject is the CPF from the signer certificate. */
export const brGovbr: PersonProof = {
  scheme: "br.govbr",
  level: "govbr",
  dedupeHash: (secret, cpf) => createHmac("sha256", secret).update(cpf).digest("hex"),
};

/** The org schemes this core runs, by ID. A claim row names its scheme. */
export const orgSchemes: ReadonlyMap<string, RegistryLookup> = new Map([[brCnpj.scheme, brCnpj]]);

/** The adapter of a stored claim. Fails closed on a scheme this core does not run. */
export function orgScheme(id: string): RegistryLookup {
  const scheme = orgSchemes.get(id);
  if (!scheme) throw new ApiError("internal", "unknown_scheme");
  return scheme;
}
