import { fileURLToPath } from "node:url";
// Reference implementation copied from bipe-shared by `pnpm gen`. Never edit generated/.
import { cnpjRoot, extractInviteCode as extractInviteCodeWith, formatCnpj, handleProblem, handleSkeleton, loadRegistries, normalize, normalizeCnpj, normalizePhone as normalizePhoneWith, pinProblem, profileProblem } from "./generated/lib/registries.mjs";

// The JSON registries are read from src/generated at runtime (tsc does not copy JSON).
const root = fileURLToPath(new URL("../src/generated/", import.meta.url));
const reg = loadRegistries(root);

/** Server-side growth events (ADR 0098, registries/growth-events.json). */
export const growthRules = reg.growth as {
  retentionDaysKept: number;
  funnel: string[];
  retentionEvent: string;
  retentionDays: number[];
  events: { id: string; once: boolean; source: "api" | "synapse_db"; detail: string }[];
};

/** Badge trust list and life (ADR 0123, registries/badge-keys.json). */
export const badgeRules = reg.badgeKeys as { keys: Record<string, string>; lifeDays: number; renewDaysBeforeExpiry: number };

export type HandleProblem = "too_short" | "too_long" | "invalid_characters" | "reserved";

export const handleRules = reg.handles as {
  minLength: number;
  maxLength: number;
  changeCooldownDays: number;
  releaseHoldDays: number;
};

/**
 * Without `claimant`: the shape check for lookups. With `claimant` (the Matrix user ID that wants the handle,
 * "" for a new account): also refuses a handle owned by another user (reserved-name-owners.json, ADR 0065).
 */
export function problemWithHandle(handle: string, claimant?: string): HandleProblem | null {
  return handleProblem(handle, reg, claimant) as HandleProblem | null;
}

export function skeletonOf(handle: string): string {
  return handleSkeleton(handle, reg);
}

/** The invite code in anything a user pasted or typed: a code, an invite link or a whole message. Null when none. */
export function extractInviteCode(text: string): string | null {
  return extractInviteCodeWith(text, reg) as string | null;
}

/** A Brazilian mobile number in E.164 from an address-book entry, or null (registries/phone-numbers.json). */
export function normalizePhone(text: string): string | null {
  return normalizePhoneWith(text, reg) as string | null;
}

// --- CNPJ (ADR 0042) -----------------------------------------------------------------------------------

/** 14 uppercase characters, or null when the format or a check digit is wrong (test-vectors/cnpj.json). */
export function validCnpj(input: string): string | null {
  return normalizeCnpj(input) as string | null;
}

export { cnpjRoot, formatCnpj };

const reservedNames = new Set(Object.values(reg.reserved.categories as Record<string, string[]>).flat());
const reservedOwners = reg.owners.owners as Record<string, string[]>;

/**
 * Reserved names that a registered name matches after normalisation (lowercase, no accents, homoglyphs
 * folded), and whether staff approved the name for this CNPJ root (registries/reserved-name-owners.json).
 */
export function reservedNameClaims(names: (string | null)[], root: string): { name: string; approved: boolean }[] {
  const found = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const norm = normalize(n, reg.homoglyphs.map) as string;
    if (reservedNames.has(norm)) found.add(norm);
  }
  return [...found].map((name) => ({ name, approved: (reservedOwners[name] ?? []).includes(root) }));
}

export type ProfileProblem = "name_empty" | "name_too_long" | "name_reserved" | "bio_too_long" | "bio_too_many_lines";

export const profileRules = reg.profiles as {
  nameMaxLength: number;
  bioMaxLength: number;
  bioMaxLines: number;
  photoMaxBytes: number;
  photoMaxPixels: number;
};

/** Public profile name and bio check (registries/profiles.json and the reserved names). */
export function problemWithProfile(name: string, bio: string): ProfileProblem | null {
  return profileProblem({ name, bio }, reg) as ProfileProblem | null;
}

// --- Device-first accounts (ADR 0057, ADR 0059) ------------------------------------------------------

export type PinProblem = "not_digits" | "wrong_length" | "repeated_digit" | "sequence" | "date";

export type RecoveryMethod = "token" | "email" | "guardian" | "cpf";

export const accountRules = reg.accounts as {
  pinLength: number;
  pinMaxWrongTries: number;
  recoveryDelayHours: Record<RecoveryMethod, number>;
  guardianApprovalsMax: number;
  recoveryLinkMinutes: number;
  emailVerifyLinkHours: number;
  recoveryClaimDays: number;
  maxPersonalAccounts: number;
};

/** Phone link rules (registries/phone-numbers.json): the yearly confirmation of a linked number (bipe#470). */
export const phoneRules = reg.phones as { linkConfirmMonths: number; linkConfirmWarnDays: number };

/** Terms and privacy accepted at sign-up (ADR 0113, registries/legal.json). */
export const legalRules = reg.legal as {
  legalVersion: string;
  termsPath: string;
  privacyPath: string;
  enTermsPath: string;
  enPrivacyPath: string;
};

/** The shared PIN rule (registries/accounts.json, test-vectors/pins.json). Null when the PIN is strong enough. */
export function problemWithPin(pin: string): PinProblem | null {
  return pinProblem(pin, reg) as PinProblem | null;
}

export type Lang = "pt" | "en";

/** A string from bipe-shared/strings with %N$s placeholders filled. */
export function appString(lang: Lang, key: string, ...args: string[]): string {
  const table = (lang === "en" ? reg.stringsEn.strings : reg.strings.strings) as Record<string, string>;
  const value = table[key];
  if (value === undefined) throw new Error(`missing string ${key}`);
  return value.replace(/%(\d+)\$s/g, (_, n: string) => args[Number(n) - 1] ?? "");
}
