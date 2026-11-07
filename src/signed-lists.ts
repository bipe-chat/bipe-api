// Signed lists (bipe-chat/bipe#645, bipe-shared docs/signed-lists.md). The core serves the envelopes that the signers
// made. It never signs a list. The files come from bipe-shared through `pnpm gen`, and the generator checks every one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ListType = "operators" | "issuers";

const root = fileURLToPath(new URL("../src/generated/signed/", import.meta.url));

function load(typ: ListType): Map<number, string> {
  const dir = `${root}${typ}/`;
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (/^[1-9][0-9]*\.json$/.test(f)) out.set(Number(f.slice(0, -5)), readFileSync(`${dir}${f}`, "utf8"));
  }
  return out;
}

const lists: Record<ListType, Map<number, string>> = { operators: load("operators"), issuers: load("issuers") };

/** The envelope text exactly as signed, so a verifier can store its bytes. null: no list yet. */
export function newestList(typ: ListType): string | null {
  const versions = [...lists[typ].keys()];
  return versions.length ? (lists[typ].get(Math.max(...versions)) ?? null) : null;
}

/** One version of the public log, or null. */
export function listVersion(typ: ListType, version: string): string | null {
  return /^[1-9][0-9]{0,15}$/.test(version) ? (lists[typ].get(Number(version)) ?? null) : null;
}
