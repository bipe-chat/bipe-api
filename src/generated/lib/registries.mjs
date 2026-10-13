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
    owners: read("registries/reserved-name-owners.json"),
    profiles: read("registries/profiles.json"),
    inviteCodes: read("registries/invite-codes.json"),
    phones: read("registries/phone-numbers.json"),
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
  // The newAccountPhrases context check matches family terms as whole words over [0-9a-z].
  for (const t of reg.family.terms) if (!/^[0-9a-z]+( [0-9a-z]+)*$/.test(t)) fail(`family term "${t}" must be words of [0-9a-z]`);
  for (const group of SCAM_PATTERN_GROUPS) {
    for (const p of reg.scam[group]) {
      if (!/^[a-z-]+$/.test(p.id)) fail(`${group} id "${p.id}"`);
      try { new RegExp(p.regex); } catch (e) { fail(`${group}.${p.id} regex: ${e.message}`); }
    }
  }
  const s = reg.scam;
  for (const list of ["urgencyPhrases", "receiptKeywords", "pixKeyContextWords", "newNumberPhrases", "newAccountPhrases", ...DELIVERY_WORD_LISTS, ...BANK_ALERT_WORD_LISTS]) {
    for (const t of s[list]) if (normalize(t, {}) !== t) fail(`${list} entry "${t}" is not normalised`);
  }
  for (const p of s.newNumberPhrases) if (!s.urgencyPhrases.includes(p)) fail(`newNumberPhrases entry "${p}" is not in urgencyPhrases`);
  // Tokens match folded hosts without dots and hyphens, so they must be unchanged by host folding.
  const hostFold = hostHomoglyphs(reg);
  for (const t of s.lookalikeBrandTokens) if (!/^[0-9a-z]+$/.test(t) || normalize(t, hostFold) !== t) fail(`lookalikeBrandTokens entry "${t}" must be [0-9a-z] and unchanged by host folding`);
  for (const d of s.officialDomains) if (!/^[0-9a-z-]+(\.[0-9a-z-]+)+$/.test(d)) fail(`officialDomains entry "${d}"`);
  if ([...s.warningKindPriority].sort().join() !== [...SCAM_WARNING_KINDS].sort().join()) fail(`warningKindPriority must list each of ${SCAM_WARNING_KINDS.join(", ")} once`);
  const reservedAll = new Set(Object.values(reg.reserved.categories).flat());
  for (const [name, roots] of Object.entries(reg.owners.owners)) {
    if (!reservedAll.has(name)) fail(`reserved-name-owners: "${name}" is not a reserved name`);
    for (const r of roots) if (!/^[0-9A-Z]{8}$/.test(r)) fail(`reserved-name-owners: "${name}" root "${r}" is not 8 characters [0-9A-Z]`);
  }
  const h = reg.handles;
  if (!(Number.isInteger(h.minLength) && Number.isInteger(h.maxLength) && h.minLength >= 1 && h.maxLength >= h.minLength)) fail("handles: lengths");
  if (!(Number.isInteger(h.ownerMinLength) && h.ownerMinLength >= 1 && h.ownerMinLength <= h.minLength)) fail("handles: ownerMinLength");
  try { new RegExp(h.pattern); new RegExp(h.skeletonStrip, "g"); } catch (e) { fail(`handles regex: ${e.message}`); }
  for (const [handle, owner] of Object.entries(reg.owners.handles)) {
    if (handle.length < h.ownerMinLength || handle.length > h.maxLength || !new RegExp(h.pattern).test(handle)) fail(`reserved-name-owners: handle "${handle}" breaks the handle rules`);
    if (handleSkeleton(handle, reg) !== handle) fail(`reserved-name-owners: handle "${handle}" must be its own skeleton`);
    if (reservedHandleSkeletons(reg).includes(handle)) fail(`reserved-name-owners: handle "${handle}" is a reserved name`);
    if (!/^@[a-z0-9._=\/+-]+:[a-z0-9.-]+$/.test(owner)) fail(`reserved-name-owners: handle "${handle}" owner "${owner}" is not a Matrix user ID`);
  }
  const pr = reg.profiles;
  for (const k of ["nameMaxLength", "bioMaxLength", "bioMaxLines", "photoMaxBytes", "photoMaxPixels"]) {
    if (!(Number.isInteger(pr[k]) && pr[k] > 0)) fail(`profiles: ${k}`);
  }
  const ic = reg.inviteCodes;
  try { new RegExp(ic.pattern); } catch (e) { fail(`invite code pattern: ${e.message}`); }
  if (!(Number.isInteger(ic.maxInputLength) && ic.maxInputLength > 0)) fail("invite codes: maxInputLength");
  if (!/^[A-Z0-9]+$/.test(ic.alphabet)) fail("invite codes: alphabet");
  const ph = reg.phones;
  if (!/^[0-9]{1,3}$/.test(ph.countryCode)) fail("phones: countryCode");
  if (!(Array.isArray(ph.areaCodes) && ph.areaCodes.length > 0 && ph.areaCodes.every((a) => /^[1-9][0-9]$/.test(a)))) fail("phones: areaCodes");
  if (new Set(ph.areaCodes).size !== ph.areaCodes.length) fail("phones: duplicate area code");
  if (!(Number.isInteger(ph.mobileLength) && ph.mobileLength > 0)) fail("phones: mobileLength");
  if (!/^[0-9]$/.test(ph.mobilePrefix)) fail("phones: mobilePrefix");
  if (!(Number.isInteger(ph.maxInputLength) && ph.maxInputLength > 0)) fail("phones: maxInputLength");
  if (!(Number.isInteger(ph.internationalMinDigits) && ph.internationalMinDigits > 0 && ph.internationalMaxDigits >= ph.internationalMinDigits)) fail("phones: international digit range");
  for (const k of Object.keys(reg.homoglyphs.map)) if ([...k].length !== 1) fail(`homoglyph key "${k}" must be one character`);
  // Link hosts map a range of the folded message onto the plain message, so folding must keep every UTF-16 index.
  for (const [k, v] of Object.entries(reg.homoglyphs.map)) {
    if (k.length !== 1 || v.length !== 1 || /\s/.test(k) || /\s/.test(v)) fail(`homoglyph "${k}" -> "${v}" must be one UTF-16 unit each, not whitespace`);
  }
  for (const key of Object.keys(reg.strings.strings)) if (!/^bipe_[a-z0-9_]+$/.test(key)) fail(`string key "${key}"`);
  const pt = Object.keys(reg.strings.strings).sort().join(), en = Object.keys(reg.stringsEn.strings).sort().join();
  if (pt !== en) fail("strings/pt-BR.json and strings/en.json must have the same keys");
  for (const [key, value] of Object.entries(reg.strings.strings)) {
    const ph = (v) => [...v.matchAll(/%(\d+)\$s/g)].map((m) => m[1]).sort().join();
    if (ph(value) !== ph(reg.stringsEn.strings[key])) fail(`placeholders differ for ${key}`);
  }
}

const SCAM_WARNING_KINDS = ["pixCode", "boleto", "pixKey", "deliveryFee", "lookalikeLink", "bankAlert", "receipt", "newNumber", "urgency"];
const SCAM_PATTERN_GROUPS = ["pixKeyPatterns", "pixCopyPastePatterns", "boletoPatterns", "linkPatterns"];
const DELIVERY_WORD_LISTS = ["deliveryParcelWords", "deliveryHoldWords", "deliveryFeeWords"];
const BANK_ALERT_WORD_LISTS = ["bankAlertSubjectWords", "bankAlertThreatWords"];

// registries/homoglyphs.json without its ASCII keys outside [0-9a-z]: "@", "$" and "|" cannot be part of a
// host name, and folding "@" would join an e-mail's user and domain into one host.
export function hostHomoglyphs(reg) {
  return Object.fromEntries(Object.entries(reg.homoglyphs.map).filter(([k]) => !/^[\x00-\x7f]$/.test(k) || /^[0-9a-z]$/.test(k)));
}

// Every link host in the message: { folded, plain }. `folded` is a linkPatterns match on the host-folded
// message. `plain` is the same UTF-16 range of normalize(message) without folding, so it keeps homoglyphs.
export function linkHosts(message, reg) {
  const plain = normalize(message, {});
  const folded = normalize(message, hostHomoglyphs(reg));
  const hosts = [];
  for (const p of reg.scam.linkPatterns) {
    for (const m of folded.matchAll(new RegExp(p.regex, "g"))) {
      hosts.push({ folded: m[0], plain: plain.length === folded.length ? plain.slice(m.index, m.index + m[0].length) : "" });
    }
  }
  return hosts;
}

// True when the host copies a brand: its folded form names a brand and its plain form is not that brand's domain.
function isLookalikeHost(host, s) {
  const squashed = host.folded.replace(/[.-]/g, "");
  if (!s.lookalikeBrandTokens.some((t) => squashed.includes(t))) return false;
  return !s.officialDomains.some((d) => host.plain === d || host.plain.endsWith(`.${d}`));
}

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
  const n = normalize(text, {});
  const hosts = linkHosts(text, reg);
  const applies = {
    pixCode: () => groups.has("pixCopyPastePatterns"),
    boleto: () => groups.has("boletoPatterns"),
    // A phone number or e-mail alone is normal chat. Warn only when the message also talks about Pix.
    pixKey: () => groups.has("pixKeyPatterns") && s.pixKeyContextWords.some((w) => n.includes(w)),
    // The fake-delivery fee scam: a link, and the message talks about a held parcel and a fee.
    deliveryFee: () => hosts.length > 0 && DELIVERY_WORD_LISTS.every((list) => s[list].some((w) => n.includes(w))),
    // A link that copies a bank, government or company address, also when spelled with homoglyphs.
    lookalikeLink: () => hosts.some((h) => isLookalikeHost(h, s)),
    // The fake bank alert: a link, and the message says the account, card or Pix is blocked or needs an update.
    bankAlert: () => hosts.length > 0 && BANK_ALERT_WORD_LISTS.every((list) => s[list].some((w) => n.includes(w))),
    receipt: () => groups.has("receipt"),
    // The falso parente opener. On Bipe it says new account, which is normal chat without a family term or urgency.
    newNumber: () => phrases.some((p) => s.newNumberPhrases.includes(p))
      || (s.newAccountPhrases.some((p) => n.includes(p)) && (phrases.length > 0 || containsWord(n, reg.family.terms))),
    urgency: () => phrases.length > 0,
  };
  return s.warningKindPriority.find((kind) => applies[kind]()) ?? null;
}

// True when the normalised text has one of `terms` as a whole word: each run of characters outside
// [0-9a-z] becomes one space, then the term must have a space on each side.
function containsWord(normalized, terms) {
  const words = ` ${normalized.replace(/[^0-9a-z]+/g, " ")} `;
  return terms.some((t) => words.includes(` ${t} `));
}

// The invite code in anything a user pasted or typed (a code, an invite link, a whole message), or null.
export function extractInviteCode(text, reg) {
  const ic = reg.inviteCodes;
  const m = new RegExp(ic.pattern).exec(text.slice(0, ic.maxInputLength).toUpperCase());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// A phone number in E.164 from an address-book entry, or null: Brazilian mobiles in any local format,
// other countries only when written with "+" or "00".
// Rule in registries/phone-numbers.json.
export function normalizePhone(text, reg) {
  const ph = reg.phones;
  const head = text.slice(0, ph.maxInputLength).replace(/\(0\)/g, "").trim();
  let plus = head.replace(/[^0-9+]/g, "").startsWith("+");
  let digits = head.replace(/[^0-9]/g, "");
  if (!plus && digits.startsWith("00")) {
    plus = true;
    digits = digits.slice(2);
  }
  const national = ph.mobileLength + 2;
  if (plus) {
    if (!digits.startsWith(ph.countryCode)) {
      // Another country: E.164 as written, length checked only.
      const ok = digits.length >= ph.internationalMinDigits && digits.length <= ph.internationalMaxDigits && !digits.startsWith("0");
      return ok ? `+${digits}` : null;
    }
    digits = digits.slice(ph.countryCode.length);
  } else if (digits.length === national + 3 && digits.startsWith("0")) {
    digits = digits.slice(3); // trunk 0 + carrier code
  } else if (digits.length === national + 1 && digits.startsWith("0")) {
    digits = digits.slice(1); // trunk 0
  } else if (digits.length === national + ph.countryCode.length && digits.startsWith(ph.countryCode)) {
    digits = digits.slice(ph.countryCode.length);
  }
  if (digits.length !== national) return null;
  const area = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  if (!ph.areaCodes.includes(area) || !subscriber.startsWith(ph.mobilePrefix)) return null;
  return `+${ph.countryCode}${area}${subscriber}`;
}

// NFKD, strip combining marks, lowercase, fold homoglyphs, collapse whitespace.
export function normalize(input, homoglyphMap) {
  const stripped = input.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const folded = [...stripped].map((c) => homoglyphMap[c] ?? c).join("");
  return folded.replace(/\s+/g, " ").trim();
}

// Handle checks (docs/usernames.md). Input is the raw handle without "@".
// Returns null when valid, else a reason id shared by every platform.
// Without `claimant` it checks the shape only, as lookup, search and profile links do: a handle in
// reserved-name-owners.json handles may be shorter than minLength (ADR 0065).
// With `claimant` (the Matrix user ID that wants the handle; "" for a new account) a handle whose skeleton
// is an owned handle is "reserved" for everyone except its owner.
export function handleProblem(handle, reg, claimant) {
  const h = reg.handles;
  const owned = reg.owners.handles;
  if (handle.length < h.ownerMinLength) return "too_short";
  if (handle.length > h.maxLength) return "too_long";
  if (handle.length < h.minLength && !Object.hasOwn(owned, handle)) return "too_short";
  if (!new RegExp(h.pattern).test(handle)) return "invalid_characters";
  const skeleton = handleSkeleton(handle, reg);
  if (reservedHandleSkeletons(reg).includes(skeleton)) return "reserved";
  if (claimant !== undefined && Object.hasOwn(owned, skeleton) && owned[skeleton] !== claimant) return "reserved";
  return null;
}

function reservedHandleSkeletons(reg) {
  return Object.values(reg.reserved.categories).flat().map((n) => n.replace(/\s+/g, ""));
}

export function handleSkeleton(handle, reg) {
  return normalize(handle, reg.homoglyphs.map).replace(new RegExp(reg.handles.skeletonStrip, "g"), "").replace(/\s+/g, "");
}

// CNPJ (ADR 0042). Numeric CNPJs and the alphanumeric format in use since July 2026 share one rule:
// 12 characters [0-9A-Z], then 2 numeric check digits. A character's value is its ASCII code minus 48
// ("0" = 0, "A" = 17). Check digits are mod 11 with weights 5..2,9..2 and 6..2,9..2; a remainder below 2
// gives 0. Input may carry the usual separators (". / -" and spaces) and lowercase letters.
const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function cnpjCheckDigit(chars, weights) {
  const r = [...chars].reduce((sum, c, i) => sum + (c.charCodeAt(0) - 48) * weights[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
}

/** The CNPJ as 14 uppercase characters, or null when the format or a check digit is wrong. */
export function normalizeCnpj(input) {
  const s = String(input).replace(/[.\/\-\s]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(s)) return null;
  if (/^(.)\1{13}$/.test(s)) return null; // 00000000000000 and similar pass the digits but are not issued
  const d1 = cnpjCheckDigit(s.slice(0, 12), CNPJ_W1);
  const d2 = cnpjCheckDigit(s.slice(0, 12) + d1, CNPJ_W2);
  return s.endsWith(`${d1}${d2}`) ? s : null;
}

/** First 8 characters: the company (raiz). All establishments of one company share it. */
export function cnpjRoot(cnpj) {
  return cnpj.slice(0, 8);
}

/** 12.ABC.345/01DE-35 */
export function formatCnpj(cnpj) {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

// Public profile checks (bipe/docs/adr ADR 0041). Lengths count code points, like the API.
// Returns null when valid, else a reason id shared by every platform.
export function profileProblem({ name, bio }, reg) {
  const p = reg.profiles;
  const trimmed = name.trim();
  if (trimmed.length === 0) return "name_empty";
  if ([...trimmed].length > p.nameMaxLength) return "name_too_long";
  if (Object.values(reg.reserved.categories).flat().includes(normalize(trimmed, reg.homoglyphs.map))) return "name_reserved";
  const b = bio.trim();
  if ([...b].length > p.bioMaxLength) return "bio_too_long";
  if (b.split("\n").length > p.bioMaxLines) return "bio_too_many_lines";
  return null;
}
