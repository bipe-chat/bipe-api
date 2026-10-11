import { fileURLToPath } from "node:url";
// Reference implementation copied from proseio-shared by `pnpm gen`. Never edit generated/.
import { handleProblem, handleSkeleton, loadRegistries } from "./generated/lib/registries.mjs";

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
