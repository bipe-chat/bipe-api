// Verification schemes (bipe ADR 0272, bipe-chat/bipe#1194). A scheme is one proof rail or one registry in one country,
// with an ID from bipe-shared registries/schemes.json. The claim flow, the tables and the badge code are the same for
// every scheme. Each scheme brings its own adapters. Brazil is the first scheme (schemes-br.ts). The API routes stay
// Brazilian (POST /v1/me/business takes a CNPJ), so the API answers do not change.
import type pg from "pg";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { brCnpj, brGovbr } from "./schemes-br.js";

/** What a registry says about one organisation. */
export type RegistryRecord = {
  active: boolean;
  legalName: string | null;
  tradeName: string | null;
  /** The registry copy that the record comes from, YYYY-MM. */
  checkedMonth: string;
};

/** The registry answer for one organisation ID after a refresh. */
export type RegistryState = "active" | "not_active" | "not_found";

/** The fields that an org badge of this scheme adds to its payload, between `lvl` and `msk`. */
export type OrgBadge = {
  name: string;
  /** Everything that must give a new signature when it changes. */
  cacheParts: unknown[];
  /** The payload fields in their fixed order. `method` is how the claim was verified. */
  fields: (method: string) => Record<string, unknown>;
};

/** An organisation registry (ADR 0272 "RegistryLookup"): Receita for br.cnpj, KVK or Zefix for later schemes. */
export interface RegistryLookup {
  readonly scheme: string;
  /** The organisation ID in its stored form, or null when the format or a check digit is wrong. */
  parseOrgId(raw: string): string | null;
  /** Two IDs name the same organisation, for example two branches of one company. */
  sameOrg(a: string, b: string): boolean;
  /** The text that the organisation signs to prove control of the claim. */
  challenge(orgId: string, userId: string, code: string, date: string): string;
  /** The stored record, or null when no refresh found it yet. */
  record(db: Db, orgId: string): Promise<RegistryRecord | null>;
  /** The month of the newest complete registry copy, or null when there is none. */
  latestMonth(config: Config): string | null;
  /** Reads the newest copy for these IDs and stores what it found. null: no complete copy. */
  refresh(client: pg.PoolClient, config: Config, orgIds: string[]): Promise<{ month: string; states: Map<string, RegistryState> } | null>;
  /** Reserved names that the registered names match, and whether staff approved them for this organisation. */
  reservedNames(record: RegistryRecord, orgId: string): { name: string; approved: boolean }[];
  /** The badge fields of a verified claim, or null when the record does not allow a badge. */
  badge(db: Db, orgId: string, nowMs: number): Promise<OrgBadge | null>;
}

/** A proof that the claimant controls the organisation (ADR 0272 "ControlProof"): e-CNPJ for br.cnpj. */
export interface ControlProof {
  readonly scheme: string;
  /** The value of `business_claims.method` after this proof. */
  readonly method: string;
  /** Checks the signed challenge. Throws an ApiError when it fails. */
  verify(signature: string, challenge: string, orgId: string): Promise<void>;
}

/** A person rail (ADR 0272 "PersonProof"): gov.br and Pix for Brazil. */
export interface PersonProof {
  readonly scheme: string;
  /** The level that person_verifications and the badge use: the alias in registries/schemes.json, else `person`. */
  readonly level: string;
  /** ISO 3166-1 alpha-2 country of the scheme. A `person` badge carries it. */
  readonly country: string;
  /** `bank` or `state` (registries/schemes.json). A `person` badge carries it. */
  readonly assurance: string;
  /** The keyed hash that keeps one person on one account inside this scheme (ADR 0272 decisions 5 and 8). */
  dedupeHash(secret: string, subject: string): string;
}

// --- The schemes this core runs -------------------------------------------------------------------------------------

const orgs = new Map<string, RegistryLookup>([[brCnpj.scheme, brCnpj]]);
const persons = new Map<string, PersonProof>([[brGovbr.scheme, brGovbr]]);

/** The adapter of a stored claim. Fails closed on a scheme this core does not run. */
export function orgScheme(id: string): RegistryLookup {
  const scheme = orgs.get(id);
  if (!scheme) throw new ApiError("internal", "unknown_scheme");
  return scheme;
}

/** The adapter of a stored person proof, or null when this core does not run the scheme (no badge, fail closed). */
export function personScheme(id: string): PersonProof | null {
  return persons.get(id) ?? null;
}

/**
 * Tests only (bipe-chat/bipe#1195): adds an adapter of the test-only region zz, to run a person and a company through
 * the generic flow. Any other scheme throws, so no code path can add a fake adapter for a real country.
 */
export function registerTestScheme(adapter: RegistryLookup | PersonProof): void {
  if (!adapter.scheme.startsWith("zz.")) throw new Error(`registerTestScheme: ${adapter.scheme} is not a zz test scheme`);
  if ("dedupeHash" in adapter) persons.set(adapter.scheme, adapter);
  else orgs.set(adapter.scheme, adapter);
}
