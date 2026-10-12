import { fileURLToPath } from "node:url";
// Reference implementation copied from proseio-shared by `pnpm gen`. Never edit generated/.
import { extractInviteCode as extractInviteCodeWith, handleProblem, handleSkeleton, loadRegistries, normalizePhone as normalizePhoneWith } from "./generated/lib/registries.mjs";

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
