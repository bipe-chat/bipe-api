// Loads and validates registries. Reference normalisation lives here: every
// platform implementation must match it via test-vectors/.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadRegistries(root) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const reg = {
    reserved: read("registries/reserved-names.json"),
    family: read("registries/family-terms.json"),
    scam: read("registries/scam-patterns.json"),
    homoglyphs: read("registries/homoglyphs.json"),
    handles: read("registries/handles.json"),
    strings: read("strings/pt-BR.json"),
    stringsEn: read("strings/en.json"),
  };
  validate(reg);
  return reg;
}

function fail(msg) {
  throw new Error(`registry validation failed: ${msg}`);
}

function validate(reg) {
  for (const [name, r] of Object.entries(reg)) {
    if (r.version !== 1) fail(`${name}: version must be 1`);
  }
  for (const [cat, names] of Object.entries(reg.reserved.categories)) {
    if (!/^[a-z]+$/.test(cat)) fail(`reserved category id "${cat}"`);
    // Entries must already be in normalised form so lookups are exact.
    for (const n of names) if (normalize(n, reg.homoglyphs.map) !== n) fail(`reserved name "${n}" is not normalised`);
  }
  for (const t of reg.family.terms) if (normalize(t, reg.homoglyphs.map) !== t) fail(`family term "${t}" is not normalised`);
  for (const group of ["pixKeyPatterns", "pixCopyPastePatterns", "boletoPatterns"]) {
    for (const p of reg.scam[group]) {
      if (!/^[a-z-]+$/.test(p.id)) fail(`${group} id "${p.id}"`);
      try { new RegExp(p.regex); } catch (e) { fail(`${group}.${p.id} regex: ${e.message}`); }
    }
  }
  const s = reg.scam;
  for (const list of ["urgencyPhrases", "receiptKeywords", "pixKeyContextWords", "newNumberPhrases"]) {
    for (const t of s[list]) if (normalize(t, {}) !== t) fail(`${list} entry "${t}" is not normalised`);
  }
  for (const p of s.newNumberPhrases) if (!s.urgencyPhrases.includes(p)) fail(`newNumberPhrases entry "${p}" is not in urgencyPhrases`);
  if ([...s.warningKindPriority].sort().join() !== [...SCAM_WARNING_KINDS].sort().join()) fail(`warningKindPriority must list each of ${SCAM_WARNING_KINDS.join(", ")} once`);
  const h = reg.handles;
  if (!(Number.isInteger(h.minLength) && Number.isInteger(h.maxLength) && h.minLength >= 1 && h.maxLength >= h.minLength)) fail("handles: lengths");
  try { new RegExp(h.pattern); new RegExp(h.skeletonStrip, "g"); } catch (e) { fail(`handles regex: ${e.message}`); }
  for (const k of Object.keys(reg.homoglyphs.map)) if ([...k].length !== 1) fail(`homoglyph key "${k}" must be one character`);
  for (const key of Object.keys(reg.strings.strings)) if (!/^proseio_[a-z0-9_]+$/.test(key)) fail(`string key "${key}"`);
  const pt = Object.keys(reg.strings.strings).sort().join(), en = Object.keys(reg.stringsEn.strings).sort().join();
  if (pt !== en) fail("strings/pt-BR.json and strings/en.json must have the same keys");
  for (const [key, value] of Object.entries(reg.strings.strings)) {
    const ph = (v) => [...v.matchAll(/%(\d+)\$s/g)].map((m) => m[1]).sort().join();
    if (ph(value) !== ph(reg.stringsEn.strings[key])) fail(`placeholders differ for ${key}`);
  }
}

const SCAM_WARNING_KINDS = ["pixCode", "boleto", "pixKey", "receipt", "newNumber", "urgency"];
const SCAM_PATTERN_GROUPS = ["pixKeyPatterns", "pixCopyPastePatterns", "boletoPatterns"];

// Match IDs in reference order: `<patternGroup>:<id>` for regexes on the raw
// message, then `urgency:<phrase>`, then `receipt:<keyword>` on normalize(message)
// without homoglyph folding.
export function scamMatchIDs(message, reg) {
  const ids = [];
  for (const g of SCAM_PATTERN_GROUPS) for (const p of reg.scam[g]) if (new RegExp(p.regex).test(message)) ids.push(`${g}:${p.id}`);
  const n = normalize(message, {});
  for (const phrase of reg.scam.urgencyPhrases) if (n.includes(phrase)) ids.push(`urgency:${phrase}`);
  for (const kw of reg.scam.receiptKeywords) if (n.includes(kw)) ids.push(`receipt:${kw}`);
  return ids;
}

// The one warning to show for a message, or null: the first kind in
// warningKindPriority whose rule applies.
export function scamWarningKind(text, reg) {
  const s = reg.scam;
  const ids = scamMatchIDs(text, reg);
  const groups = new Set(ids.map((id) => id.slice(0, id.indexOf(":"))));
  const phrases = ids.filter((id) => id.startsWith("urgency:")).map((id) => id.slice("urgency:".length));
  const applies = {
    pixCode: () => groups.has("pixCopyPastePatterns"),
    boleto: () => groups.has("boletoPatterns"),
    // A phone number or e-mail alone is normal chat. Warn only when the message also talks about Pix.
    pixKey: () => groups.has("pixKeyPatterns") && s.pixKeyContextWords.some((w) => normalize(text, {}).includes(w)),
    receipt: () => groups.has("receipt"),
    newNumber: () => phrases.some((p) => s.newNumberPhrases.includes(p)),
    urgency: () => phrases.length > 0,
  };
  return s.warningKindPriority.find((kind) => applies[kind]()) ?? null;
}

// NFKD, strip combining marks, lowercase, fold homoglyphs, collapse whitespace.
export function normalize(input, homoglyphMap) {
  const stripped = input.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const folded = [...stripped].map((c) => homoglyphMap[c] ?? c).join("");
  return folded.replace(/\s+/g, " ").trim();
}

// Handle checks (docs/usernames.md). Input is the raw handle without "@".
// Returns null when valid, else a reason id shared by every platform.
export function handleProblem(handle, reg) {
  const h = reg.handles;
  if (handle.length < h.minLength) return "too_short";
  if (handle.length > h.maxLength) return "too_long";
  if (!new RegExp(h.pattern).test(handle)) return "invalid_characters";
  const skeleton = handleSkeleton(handle, reg);
  const reserved = Object.values(reg.reserved.categories).flat().map((n) => n.replace(/\s+/g, ""));
  if (reserved.includes(skeleton)) return "reserved";
  return null;
}

export function handleSkeleton(handle, reg) {
  return normalize(handle, reg.homoglyphs.map).replace(new RegExp(reg.handles.skeletonStrip, "g"), "").replace(/\s+/g, "");
}
