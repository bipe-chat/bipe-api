// Signed lists (bipe-chat/bipe#645, bipe-shared docs/signed-lists.md). The core serves the envelopes that the signers
// made. It never signs a list. The versions in the image come from bipe-shared through `pnpm gen`, and the generator
// checks every one. A newer version comes in through POST /v1/{typ} (bipe-chat/bipe#1242): the core checks it with the
// reference verifier against its newest version and keeps it in `signed_lists`, so a re-signed list needs no deploy.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { verifySignedList as verifyReference } from "./generated/lib/signed-lists.mjs";

export type ListType = "operators" | "issuers";
export const LIST_TYPES: readonly ListType[] = ["operators", "issuers"];

const generated = fileURLToPath(new URL("../src/generated/", import.meta.url));
export type SignerSet = { threshold: number; keys: Record<string, string> };
type StoredList = { version: number; payload: string };
// The reference is JavaScript: `stored = null` there would type the option as null only.
export const verifySignedList = verifyReference as unknown as (
  envelope: unknown,
  options: { typ: ListType; signerSet: SignerSet; now: number; stored: StoredList | null },
) => { error?: string; payload?: { version: number; operators?: { server_name: string; status: string }[] } };
export const signers: SignerSet = JSON.parse(
  readFileSync(`${generated}registries/list-signers.json`, "utf8"),
);

function load(typ: ListType): Map<number, string> {
  const dir = `${generated}signed/${typ}/`;
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (/^[1-9][0-9]*\.json$/.test(f)) out.set(Number(f.slice(0, -5)), readFileSync(`${dir}${f}`, "utf8"));
  }
  return out;
}

const lists: Record<ListType, Map<number, string>> = { operators: load("operators"), issuers: load("issuers") };

function newestVersion(typ: ListType): number | null {
  const versions = [...lists[typ].keys()];
  return versions.length ? Math.max(...versions) : null;
}

/** The envelope text exactly as signed, so a verifier can store its bytes. null: no list yet. */
export function newestList(typ: ListType): string | null {
  const version = newestVersion(typ);
  return version === null ? null : (lists[typ].get(version) ?? null);
}

/** One version of the public log, or null. */
export function listVersion(typ: ListType, version: string): string | null {
  return /^[1-9][0-9]{0,15}$/.test(version) ? (lists[typ].get(Number(version)) ?? null) : null;
}

/** Adds the versions that came in after the image was built. Safe to run again (every 5 minutes, for a second pod). */
export async function loadStoredLists(db: Db): Promise<void> {
  const { rows } = await db.query<{ typ: ListType; version: string; envelope: string }>("SELECT typ, version, envelope FROM signed_lists");
  for (const row of rows) if (LIST_TYPES.includes(row.typ)) lists[row.typ].set(Number(row.version), row.envelope);
}

/**
 * Takes a newer signed version. Anyone can send one: only the list signers can make an envelope that passes, and the
 * verifier refuses a lower version, a changed version and a broken chain against the newest one here. The same envelope
 * again answers its version. Errors: `bad_request` with the verifier's code as reason (docs/signed-lists.md).
 */
export async function publishList(db: Db, typ: ListType, text: string, now: number, signerSet: SignerSet = signers): Promise<number> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "malformed");
  }
  const newest = newestList(typ);
  const stored = newest === null ? null : { version: newestVersion(typ)!, payload: (JSON.parse(newest) as { payload: string }).payload };
  const checked = verifySignedList(envelope, { typ, signerSet, now, stored });
  if (checked.error || !checked.payload) throw new ApiError("bad_request", checked.error ?? "malformed");
  const version = checked.payload.version;
  if (stored && version === stored.version) return version;
  await db.query("INSERT INTO signed_lists (typ, version, envelope) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [typ, version, text]);
  lists[typ].set(version, text);
  return version;
}
