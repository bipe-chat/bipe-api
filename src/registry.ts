import { fileURLToPath } from "node:url";
// Reference implementation copied from proseio-shared by `pnpm gen`. Never edit generated/.
import { cnpjRoot, extractInviteCode as extractInviteCodeWith, formatCnpj, handleProblem, handleSkeleton, loadRegistries, normalize, normalizeCnpj, normalizePhone as normalizePhoneWith } from "./generated/lib/registries.mjs";

// The JSON registries are read from src/generated at runtime (tsc does not copy JSON).
const root = fileURLToPath(new URL("../src/generated/", import.meta.url));
const reg = loadRegistries(root);

export type HandleProblem = "too_short" | "too_long" | "invalid_characters" | "reserved";

export const handleRules = reg.handles as {
  minLength: number;
  maxLength: number;
  changeCooldownDays: number;
  releaseHoldDays: number;
};

export function problemWithHandle(handle: string): HandleProblem | null {
  return handleProblem(handle, reg) as HandleProblem | null;
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
