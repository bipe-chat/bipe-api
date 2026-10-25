// Loads and validates registries. Reference normalisation lives here: every
// platform implementation must match it via test-vectors/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateTrustFacts, validateTrustRegistry } from "./trust.mjs";
import { validateAgendaTemplates } from "./agenda-templates.mjs";
import { validateSettings } from "./gen-settings.mjs";
import { validateOnboarding } from "./gen-onboarding.mjs";
import { validateHaptics } from "./gen-haptics.mjs";

export function loadRegistries(root) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const reg = {
    reserved: read("registries/reserved-names.json"),
    family: read("registries/family-terms.json"),
    scam: read("registries/scam-patterns.json"),
    homoglyphs: read("registries/homoglyphs.json"),
    handles: read("registries/handles.json"),
    owners: read("registries/reserved-name-owners.json"),
    officialAccounts: read("registries/official-accounts.json"),
    profiles: read("registries/profiles.json"),
    inviteCodes: read("registries/invite-codes.json"),
    phones: read("registries/phone-numbers.json"),
    accounts: read("registries/accounts.json"),
    legal: read("registries/legal.json"),
    agendaTemplates: read("registries/agenda-templates.json"),
    growth: read("registries/growth-events.json"),
    trust: read("registries/trust-facts.json"),
    settings: read("registries/settings.json"),
    onboarding: read("registries/onboarding.json"),
    haptics: read("registries/haptics.json"),
    badgeKeys: read("registries/badge-keys.json"),
    clearedChats: read("registries/cleared-chats.json"),
    imageDescriptions: read("registries/image-descriptions.json"),
    pixMarks: read("registries/pix-marks.json"),
    dataUse: read("registries/data-use.json"),
    chatArchive: read("registries/chat-archive.json"),
    dmSelection: read("registries/dm-selection.json"),
    dmPowerLevels: read("registries/dm-power-levels.json"),
    relationshipNames: read("registries/relationship-names.json"),
    photoMatch: read("registries/photo-match.json"),
    strings: read("strings/pt-BR.json"),
    stringsEn: read("strings/en.json"),
  };
  validate(reg);
  return reg;
}

function fail(msg) {
  throw new Error(`registry validation failed: ${msg}`);
}

// ADR 0141: in a new DM nobody reaches a locked level, and the everyday events stay open to both people.
export function validateDmPowerLevels(pl) {
  const level = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
  const locked = [pl.stateDefault, pl.invite, pl.kick, pl.ban, pl.redact, pl.notifications?.room];
  if (![pl.createLevel, pl.usersDefault, pl.eventsDefault, ...locked].every(level)) fail("dm-power-levels: levels must be integers from 0 to 100");
  if (!locked.every((v) => v > pl.usersDefault)) fail("dm-power-levels: invite, kick, ban, redact, @room and room state must be above usersDefault");
  if (pl.createLevel < Math.max(pl.stateDefault, pl.invite)) fail("dm-power-levels: createLevel must write the first state and the invite");
  if (pl.eventsDefault > pl.usersDefault) fail("dm-power-levels: messages must stay open to both people");
  for (const [type, v] of Object.entries(pl.events ?? {})) {
    if (!level(v) || !/^[a-z0-9._]+$/.test(type)) fail(`dm-power-levels: event ${type}`);
  }
  for (const type of ["m.room.name", "m.room.avatar", "m.room.topic", "m.room.power_levels", "m.room.join_rules", "m.room.history_visibility", "m.room.encryption"]) {
    if (!(pl.events?.[type] > pl.usersDefault)) fail(`dm-power-levels: ${type} must be locked`);
  }
  for (const type of ["m.room.message", "m.reaction", "m.room.redaction", "org.matrix.msc3401.call.member"]) {
    if (pl.events?.[type] !== undefined && pl.events[type] > pl.usersDefault) fail(`dm-power-levels: ${type} must stay open`);
  }
}

export function validateLinkedRecovery(accounts) {
  const linked = accounts.linkedRecovery;
  if (!linked || [...linked.providers ?? []].sort().join() !== "apple,google" || linked.providers.length !== 2) fail("accounts: linked recovery providers must be apple and google");
  if (linked.delayHours !== 24 || linked.requiresPin !== true || linked.allowsPinReset !== false || linked.maxAccountsPerProvider !== 1) {
    fail("accounts: linked recovery must preserve ADR 0096 (24 hours, existing PIN, no PIN reset, one account per provider)");
  }
  if (!Number.isInteger(linked.flowMinutes) || linked.flowMinutes < 1 || linked.flowMinutes > 15) fail("accounts: linked recovery flowMinutes must be 1 to 15");
}

export function validateOfficialAccounts(reg) {
  const accounts = reg.officialAccounts.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts) || !Object.keys(accounts).length) fail("official accounts: accounts must be a non-empty map");
  const userIds = new Set();
  const handles = new Set();
  for (const [role, account] of Object.entries(accounts)) {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) fail(`official accounts: role "${role}"`);
    if (!account || typeof account.userId !== "string" || !/^@[a-z0-9._=\/+-]+:[a-z0-9.-]+$/.test(account.userId)) fail(`official accounts: ${role} must have a Matrix user ID`);
    if (typeof account.handle !== "string" || !new RegExp(reg.handles.pattern).test(account.handle) || handleSkeleton(account.handle, reg) !== account.handle) fail(`official accounts: ${role} must have a canonical handle`);
    if (userIds.has(account.userId) || handles.has(account.handle)) fail(`official accounts: duplicate account or handle for ${role}`);
    if (reg.owners.handles[account.handle] !== account.userId) fail(`official accounts: ${role} handle owner does not match`);
    userIds.add(account.userId);
    handles.add(account.handle);
  }
}

/** Release trust list (ADR 0123): prod-YYYY-MM kids only, each a raw 32-byte Ed25519 public key in base64url. */
export function validateBadgeKeys(b) {
  if (!b.keys || typeof b.keys !== "object" || Array.isArray(b.keys)) fail("badge-keys: keys must be an object");
  for (const [kid, key] of Object.entries(b.keys)) {
    if (!/^prod-\d{4}-(0[1-9]|1[0-2])$/.test(kid)) fail(`badge-keys: kid "${kid}" must be prod-YYYY-MM (never test-only-*)`);
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").length !== 32) fail(`badge-keys: ${kid} is not a 32-byte base64url key`);
  }
  if (!(Number.isInteger(b.lifeDays) && b.lifeDays > 0)) fail("badge-keys: lifeDays");
  if (!(Number.isInteger(b.renewDaysBeforeExpiry) && b.renewDaysBeforeExpiry > 0 && b.renewDaysBeforeExpiry < b.lifeDays)) fail("badge-keys: renewDaysBeforeExpiry must be below lifeDays");
}

function validate(reg) {
  validateTrustRegistry(reg.trust);
  validateAgendaTemplates(reg);
  validateSettings(reg);
  validateOnboarding(reg);
  validateHaptics(reg.haptics);
  const archive = reg.chatArchive;
  if (archive.storage !== "device-per-account" || archive.restore !== "newer-incoming-message" || archive.timestamp !== "latest-known-event-ms" || archive.missingActivity !== 0 || archive.history !== "preserve" || archive.membership !== "preserve" || archive.badges !== "unchanged") fail("chat-archive: unsupported archive policy");
  const rn = reg.relationshipNames;
  if (rn.comparison !== "normalised-exact" || rn.fullNameMinimumWords !== 2 || rn.familyTerms !== "whole-words" || rn.confirmation !== "saved-label-and-verified-name") fail("relationship-names: unsupported ADR 0018 policy");
  if (reg.clearedChats.eventType !== "chat.bipe.cleared_chats") fail("cleared-chats: eventType must be chat.bipe.cleared_chats");
  const du = reg.dataUse;
  if (!Number.isInteger(du.budgetMegabytesPerDay) || du.budgetMegabytesPerDay < 1 || typeof du.dataSaverDefault !== "boolean") fail("data-use: budgetMegabytesPerDay must be a positive integer and dataSaverDefault a boolean");
  const pxm = reg.pixMarks;
  if (pxm.eventType !== "chat.bipe.pix_mark" || pxm.relType !== "m.reference" || JSON.stringify(pxm.marks) !== '["sent","received","not_received"]' || pxm.txidMaxLength !== 25) fail("pix-marks: unsupported ADR 0046 schema");
  try { new RegExp(pxm.e2eIdPattern); } catch { fail("pix-marks: e2eIdPattern"); }
  const desc = reg.imageDescriptions;
  if (!/^chat\.bipe\.[a-z_]+$/.test(desc.field) || !Number.isInteger(desc.maxLength) || desc.maxLength < 100 || desc.maxLength > 4000) fail("image-descriptions: field must be chat.bipe.<name> and maxLength an integer from 100 to 4000");
  const dm = reg.dmSelection;
  if (dm.order !== "latest-event-descending" || dm.missingActivity !== "last" || dm.tieBreak !== "room-id-ascending"
      || dm.eligibility !== "joined-dm-with-peer" || dm.clearedRooms !== "hide-before-selection" || dm.allClearedStartChat !== "reuse-newest-existing" || dm.filterOrder !== "select-before-unread-or-name") fail("dm-selection: unsupported ADR 0141 policy");
  validateDmPowerLevels(reg.dmPowerLevels);
  for (const [name, r] of Object.entries(reg)) {
    if (r.version !== 1) fail(`${name}: version must be 1`);
  }
  validateOfficialAccounts(reg);
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
  for (const list of ["urgencyPhrases", "receiptKeywords", "pixKeyContextWords", "newNumberPhrases", "newAccountPhrases", ...DELIVERY_WORD_LISTS, ...BANK_ALERT_WORD_LISTS, ...SUBSTRING_WORD_LISTS, ...WHOLE_WORD_LISTS]) {
    if (!Array.isArray(s[list]) || s[list].length === 0) fail(`${list} must be a non-empty list`);
    for (const t of s[list]) if (normalize(t, {}) !== t) fail(`${list} entry "${t}" is not normalised`);
  }
  // Whole-word lists match between spaces after each run outside [0-9a-z] becomes one space.
  for (const list of WHOLE_WORD_LISTS) for (const t of s[list]) if (!/^[0-9a-z]+( [0-9a-z]+)*$/.test(t)) fail(`${list} entry "${t}" must be words of [0-9a-z]`);
  for (const p of s.newNumberPhrases) if (!s.urgencyPhrases.includes(p)) fail(`newNumberPhrases entry "${p}" is not in urgencyPhrases`);
  // Tokens match folded hosts without dots and hyphens, so they must be unchanged by host folding.
  const hostFold = hostHomoglyphs(reg);
  for (const t of s.lookalikeBrandTokens) if (!/^[0-9a-z]+$/.test(t) || normalize(t, hostFold) !== t) fail(`lookalikeBrandTokens entry "${t}" must be [0-9a-z] and unchanged by host folding`);
  for (const t of s.lookalikeHostLabels) if (!/^[0-9a-z]+$/.test(t) || normalize(t, hostFold) !== t) fail(`lookalikeHostLabels entry "${t}" must be [0-9a-z] and unchanged by host folding`);
  for (const d of s.appStoreDomains) if (!/^[0-9a-z-]+(\.[0-9a-z-]+)+$/.test(d)) fail(`appStoreDomains entry "${d}"`);
  for (const d of s.officialDomains) if (!/^[0-9a-z-]+(\.[0-9a-z-]+)+$/.test(d)) fail(`officialDomains entry "${d}"`);
  if ([...s.warningKindPriority].sort().join() !== [...SCAM_WARNING_KINDS].sort().join()) fail(`warningKindPriority must list each of ${SCAM_WARNING_KINDS.join(", ")} once`);
  if (!Number.isInteger(s.moneyPauseSeconds) || s.moneyPauseSeconds < 1 || s.moneyPauseSeconds > 10) fail("moneyPauseSeconds must be an integer from 1 to 10");
  if (!Array.isArray(s.moneyPauseKinds) || s.moneyPauseKinds.length === 0 || new Set(s.moneyPauseKinds).size !== s.moneyPauseKinds.length
    || s.moneyPauseKinds.some((k) => !SCAM_WARNING_KINDS.includes(k))) fail("moneyPauseKinds must list distinct warning kinds");
  const reservedAll = new Set(Object.values(reg.reserved.categories).flat());
  for (const [name, roots] of Object.entries(reg.owners.owners)) {
    if (!reservedAll.has(name)) fail(`reserved-name-owners: "${name}" is not a reserved name`);
    for (const r of roots) if (!/^[0-9A-Z]{8}$/.test(r)) fail(`reserved-name-owners: "${name}" root "${r}" is not 8 characters [0-9A-Z]`);
  }
  const pm = reg.photoMatch;
  if (pm.method !== "dhash" || pm.width !== 9 || pm.height !== 8) fail("photo-match: only dhash on a 9 x 8 grid (64 bits) is supported");
  if (!(Number.isInteger(pm.maxDistance) && pm.maxDistance >= 0 && pm.maxDistance < 32)) fail("photo-match: maxDistance must be an integer from 0 to 31");
  const h = reg.handles;
  if (!(Number.isInteger(h.minLength) && Number.isInteger(h.maxLength) && h.minLength >= 1 && h.maxLength >= h.minLength)) fail("handles: lengths");
  if (!(Number.isInteger(h.ownerMinLength) && h.ownerMinLength >= 1 && h.ownerMinLength <= h.minLength)) fail("handles: ownerMinLength");
  try { new RegExp(h.pattern); new RegExp(h.skeletonStrip, "g"); } catch (e) { fail(`handles regex: ${e.message}`); }
  for (const [handle, owner] of Object.entries(reg.owners.handles)) {
    if (handle.length < h.ownerMinLength || handle.length > h.maxLength || !new RegExp(h.pattern).test(handle)) fail(`reserved-name-owners: handle "${handle}" breaks the handle rules`);
    if (handleSkeleton(handle, reg) !== handle) fail(`reserved-name-owners: handle "${handle}" must be its own skeleton`);
    if (reservedHandleSkeletons(reg).includes(handle) && !Object.values(reg.officialAccounts.accounts).some((a) => a.handle === handle && a.userId === owner)) fail(`reserved-name-owners: handle "${handle}" is a reserved name without an official account`);
    if (!/^@[a-z0-9._=\/+-]+:[a-z0-9.-]+$/.test(owner)) fail(`reserved-name-owners: handle "${handle}" owner "${owner}" is not a Matrix user ID`);
  }
  const pr = reg.profiles;
  for (const k of ["nameMaxLength", "bioMaxLength", "bioMaxLines", "photoMaxBytes", "photoMaxPixels"]) {
    if (!(Number.isInteger(pr[k]) && pr[k] > 0)) fail(`profiles: ${k}`);
  }
  if (!Array.isArray(pr.sealLookalikeEmoji) || pr.sealLookalikeEmoji.length === 0
    || pr.sealLookalikeEmoji.some((e) => typeof e !== "string" || e.replace(/[\uFE0E\uFE0F]/g, "").length === 0)
    || new Set(pr.sealLookalikeEmoji).size !== pr.sealLookalikeEmoji.length) fail("profiles: sealLookalikeEmoji must be distinct, non-empty strings");
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
  if (!(Number.isInteger(ph.linkConfirmMonths) && ph.linkConfirmMonths >= 1 && ph.linkConfirmMonths <= 24)) fail("phones: linkConfirmMonths");
  if (!(Number.isInteger(ph.linkConfirmWarnDays) && ph.linkConfirmWarnDays >= 1 && ph.linkConfirmWarnDays < ph.linkConfirmMonths * 28)) fail("phones: linkConfirmWarnDays");
  validateBadgeKeys(reg.badgeKeys);
  const ac = reg.accounts;
  validateLinkedRecovery(ac);
  // DDMMYYYY and YYYYMMDD need exactly 8 digits.
  if (ac.pinLength !== 8) fail("accounts: pinLength must be 8 (the date check reads DDMMYYYY and YYYYMMDD)");
  for (const k of ["pinMaxWrongTries", "pinDateYearMin", "pinDateYearMax", "guardianApprovalsMax", "recoveryLinkMinutes", "emailVerifyLinkHours", "recoveryClaimDays", "maxPersonalAccounts", "webLinkCooldownSeconds"]) {
    if (!(Number.isInteger(ac[k]) && ac[k] > 0)) fail(`accounts: ${k}`);
  }
  const rr = ac.recoveryReminder;
  if (!(rr && Number.isInteger(rr.firstAfterDays) && rr.firstAfterDays >= 0)) fail("accounts: recoveryReminder.firstAfterDays");
  // The card never stops for good while the account has no factor (bipe#531): at least one snooze, every one positive.
  if (!(Array.isArray(rr.snoozeDays) && rr.snoozeDays.length > 0 && rr.snoozeDays.every((d) => Number.isInteger(d) && d > 0))) fail("accounts: recoveryReminder.snoozeDays");
  if (!(ac.pinDateYearMin >= 1000 && ac.pinDateYearMax <= 9999 && ac.pinDateYearMin <= ac.pinDateYearMax)) fail("accounts: pin date years");
  if (Object.keys(ac.recoveryDelayHours).sort().join() !== "cpf,email,guardian,token") fail("accounts: recoveryDelayHours must have cpf, email, guardian and token");
  for (const [k, v] of Object.entries(ac.recoveryDelayHours)) if (!(Number.isInteger(v) && v >= 0)) fail(`accounts: recoveryDelayHours.${k}`);
  // Terms and privacy (ADR 0113): one version for the pair, a real date.
  const lg = reg.legal;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lg.legalVersion) || Number.isNaN(Date.parse(`${lg.legalVersion}T00:00:00Z`))) fail("legal: legalVersion must be YYYY-MM-DD");
  for (const k of ["termsPath", "privacyPath", "enTermsPath", "enPrivacyPath"]) if (!/^\/[a-z/-]+\/$/.test(lg[k] ?? "")) fail(`legal: ${k}`);
  for (const k of ["homePath", "enHomePath"]) if (!/^\/([a-z/-]+\/)?$/.test(lg[k] ?? "")) fail(`legal: ${k}`);
  // Growth events (ADR 0098): a fixed list, no content.
  const gr = reg.growth;
  const growthIds = new Set();
  for (const e of gr.events) {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(e.id) || growthIds.has(e.id)) fail(`growth: event id "${e.id}"`);
    growthIds.add(e.id);
    if (typeof e.once !== "boolean") fail(`growth: ${e.id}.once`);
    if (!["api", "synapse_db"].includes(e.source)) fail(`growth: ${e.id}.source`);
    if (e.content !== "none") fail(`growth: ${e.id} must carry no content`);
    if (!(typeof e.detail === "string" && e.detail.length > 0)) fail(`growth: ${e.id}.detail`);
  }
  for (const id of [...gr.funnel, gr.retentionEvent]) if (!growthIds.has(id)) fail(`growth: unknown event "${id}"`);
  if (gr.funnel[0] !== "signup_done" || new Set(gr.funnel).size !== gr.funnel.length) fail("growth: funnel must start with signup_done, no repeats");
  for (const d of gr.retentionDays) if (!(Number.isInteger(d) && d > 0 && d < gr.retentionDaysKept)) fail(`growth: retention day ${d}`);
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

const SCAM_WARNING_KINDS = ["extortion", "pixCode", "boleto", "remoteApp", "pinRequest", "pixKey", "deliveryFee", "lookalikeLink", "bankAlert", "receipt", "newNumber", "urgency"];
const SCAM_PATTERN_GROUPS = ["pixKeyPatterns", "pixCopyPastePatterns", "boletoPatterns", "linkPatterns"];
const DELIVERY_WORD_LISTS = ["deliveryParcelWords", "deliveryHoldWords", "deliveryFeeWords"];
const BANK_ALERT_WORD_LISTS = ["bankAlertSubjectWords", "bankAlertThreatWords"];
// Matched as substrings of the normalised message.
const SUBSTRING_WORD_LISTS = ["extortionThreatPhrases", "extortionDemandWords", "remoteAppBankWords", "pinRequestAskPhrases"];
// Matched as whole words (containsWord).
const WHOLE_WORD_LISTS = ["remoteAppInstallWords", "remoteAppNames", "pinRequestSecretWords", "pinRequestSupportWords"];

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
// A brand token may sit anywhere in the host without dots and hyphens; a short host label ("bcb", "gov") must be
// a whole label, so "receitas.globo.com" does not match "receita".
function isLookalikeHost(host, s) {
  const squashed = host.folded.replace(/[.-]/g, "");
  const labels = host.folded.split(/[.-]/);
  const names = s.lookalikeBrandTokens.some((t) => squashed.includes(t)) || s.lookalikeHostLabels.some((l) => labels.includes(l));
  return names && !isUnder(host.plain, s.officialDomains);
}

// True when the plain host is one of `domains` or a subdomain of one.
function isUnder(plain, domains) {
  return domains.some((d) => plain === d || plain.endsWith(`.${d}`));
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
// warningKindPriority whose rule applies. Kinds in `skip` are passed over.
export function scamWarningKind(text, reg, skip = []) {
  const s = reg.scam;
  const ids = scamMatchIDs(text, reg);
  const groups = new Set(ids.map((id) => id.slice(0, id.indexOf(":"))));
  const phrases = ids.filter((id) => id.startsWith("urgency:")).map((id) => id.slice("urgency:".length));
  const n = normalize(text, {});
  const hosts = linkHosts(text, reg);
  const applies = {
    // A threat with a payment demand (sextortion, "I know where you live"). A threat alone is not this kind.
    extortion: () => s.extortionThreatPhrases.some((w) => n.includes(w)) && s.extortionDemandWords.some((w) => n.includes(w)),
    pixCode: () => groups.has("pixCopyPastePatterns"),
    boleto: () => groups.has("boletoPatterns"),
    // A request to install a remote-access app: by name, or by a link that is not an official or app-store
    // address in a message about a bank, a card or Pix.
    remoteApp: () => containsWord(n, s.remoteAppInstallWords) && (containsWord(n, s.remoteAppNames)
      || (hosts.some((h) => !isUnder(h.plain, [...s.officialDomains, ...s.appStoreDomains])) && s.remoteAppBankWords.some((w) => n.includes(w)))),
    // Fake support asks for the PIN or a code. Bipe never asks for either.
    pinRequest: () => s.pinRequestAskPhrases.some((w) => n.includes(w)) && containsWord(n, s.pinRequestSecretWords) && containsWord(n, s.pinRequestSupportWords),
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
  return s.warningKindPriority.find((kind) => !skip.includes(kind) && applies[kind]()) ?? null;
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
  if (Object.hasOwn(owned, skeleton)) return claimant === undefined || owned[skeleton] === claimant ? null : "reserved";
  if (reservedHandleSkeletons(reg).includes(skeleton)) return "reserved";
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
// Security rule 8: a mark that looks like the verified seal may not sit in a display name. Returns the first
// registries/profiles.json sealLookalikeEmoji entry found in the name, or null. Variation selectors do not count.
export function sealLookalike(name, reg) {
  const strip = (s) => s.replace(/[\uFE0E\uFE0F]/g, "");
  const plain = strip(name);
  return reg.profiles.sealLookalikeEmoji.find((e) => plain.includes(strip(e))) ?? null;
}

// Security rule 8: a non-contact whose display name equals a contact's name after normalize() with the homoglyph
// map. Returns that contact name as the user saved or sees it, or null. An empty name never collides.
export function contactCollision(name, contactNames, reg) {
  const n = normalize(name, reg.homoglyphs.map);
  if (n.length === 0) return null;
  return contactNames.find((c) => normalize(c, reg.homoglyphs.map) === n) ?? null;
}

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

// ADR 0049 photo match. gray: height rows of width values 0..255 (registries/photo-match.json). Returns the dHash
// as 16 lowercase hex digits, bit 0 (the first comparison) first.
export function photoHash(gray, reg) {
  const { width, height } = reg.photoMatch;
  if (gray.length !== height || gray.some((row) => row.length !== width)) throw new Error("photoHash: wrong grid size");
  let bits = "";
  for (let y = 0; y < height; y++) for (let x = 0; x < width - 1; x++) bits += gray[y][x] < gray[y][x + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// Hamming distance of two photoHash values.
export function photoDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export function photoMatches(a, b, reg) {
  return photoDistance(a, b) <= reg.photoMatch.maxDistance;
}

// PIN check (ADR 0057, registries/accounts.json). Input is what the user typed. Returns null when the PIN is
// strong enough, else a reason id shared by every platform: not_digits, wrong_length, repeated_digit, sequence, date.
export function pinProblem(pin, reg) {
  const a = reg.accounts;
  if (!/^[0-9]*$/.test(pin)) return "not_digits";
  if (pin.length !== a.pinLength) return "wrong_length";
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return "repeated_digit";
  // Up (step 1) or down (step 9, which is minus 1 modulo 10), with wrap: 78901234 and 21098765 count.
  for (const step of [1, 9]) if (d.every((x, i) => i === 0 || x === (d[i - 1] + step) % 10)) return "sequence";
  const n = (from, to) => Number(pin.slice(from, to));
  if (isDate(n(4, 8), n(2, 4), n(0, 2), a) || isDate(n(0, 4), n(4, 6), n(6, 8), a)) return "date";
  return null;
}

function isDate(year, month, day, a) {
  if (year < a.pinDateYearMin || year > a.pinDateYearMax || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days;
}

// Proof and lifecycle inputs come from authenticated adapters; a selected warning is preserved without re-gating it.
export function trustFacts(input, reg) {
  return evaluateTrustFacts(input, reg.trust);
}

// --- Remote critical banner (ADR 0117, bipe#386) ------------------------------

/**
 * Compares dotted app versions ("26.10.2") part by part as numbers. Each part counts its leading digits only
 * ("2-dev" is 2); a missing part or a part without leading digits counts as 0.
 */
export function compareAppVersions(a, b) {
  const part = (p) => Number(/^[0-9]+/.exec(p ?? "")?.[0] ?? 0);
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = part(pa[i]);
    const y = part(pb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * What the app shows for the banner from GET /v1/banner: "hidden" (none, or past expires_at), "update" (the app
 * version is below min_app_version: the banner opens the platform's update link and cannot be dismissed) or
 * "notice" (opens link; the person can dismiss it by id). `now` is an ISO date-time.
 */
export function remoteBannerState(banner, appVersion, now) {
  if (!banner) return "hidden";
  if (Date.parse(banner.expires_at) <= Date.parse(now)) return "hidden";
  if (banner.min_app_version && compareAppVersions(appVersion, banner.min_app_version) < 0) return "update";
  return "notice";
}

const BANNER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP_VERSION = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const httpsUrl = (v) => {
  try {
    return typeof v === "string" && v.length <= 500 && new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** The first problem with a banner a staff member sets (CLI `banner set`), or null. */
export function remoteBannerProblem(banner, now) {
  if (!banner || typeof banner !== "object" || Array.isArray(banner)) return "not_an_object";
  const keys = ["id", "title", "text", "link", "min_app_version", "update_links", "expires_at"];
  if (Object.keys(banner).some((k) => !keys.includes(k))) return "unknown_field";
  if (typeof banner.id !== "string" || !BANNER_ID.test(banner.id)) return "id";
  for (const [k, max] of [["title", 60], ["text", 240]]) {
    const v = banner[k];
    if (typeof v !== "string" || v.trim() !== v || v.length < 1 || v.length > max) return k;
    // Rendered copy has no em dash (humanizer rule). Write the text through the humanizer before `banner set`.
    if (v.includes("—")) return `${k}_em_dash`;
  }
  if (!httpsUrl(banner.link)) return "link";
  if (banner.min_app_version !== undefined) {
    if (typeof banner.min_app_version !== "string" || !APP_VERSION.test(banner.min_app_version)) return "min_app_version";
    const u = banner.update_links;
    if (!u || typeof u !== "object" || !httpsUrl(u.ios) || !httpsUrl(u.android) || Object.keys(u).length !== 2) return "update_links";
  } else if (banner.update_links !== undefined) return "update_links";
  if (typeof banner.expires_at !== "string" || Number.isNaN(Date.parse(banner.expires_at))) return "expires_at";
  if (Date.parse(banner.expires_at) <= Date.parse(now)) return "expires_at";
  return null;
}

// --- Cleared DMs (bipe-chat/bipe#464; registries/cleared-chats.json) ---------

const clearedTs = (entry) => (entry && typeof entry === "object" && !Array.isArray(entry) && Number.isSafeInteger(entry.ts) && entry.ts >= 0 ? entry.ts : null);
const clearedRooms = (content) => (content && typeof content === "object" && !Array.isArray(content) && content.rooms && typeof content.rooms === "object" && !Array.isArray(content.rooms) ? content.rooms : null);

/** The marker (ms) of a room in the chat.bipe.cleared_chats content, or null. A malformed event or entry counts as not cleared. */
/** One eligible DM per peer, independent of SDK iteration order. Adapters apply filters afterward. */
export function newestDmRooms(candidates, { includingCleared = false } = {}) {
  const chosen = new Map();
  for (const candidate of candidates) {
    if (!candidate.eligible || (!includingCleared && candidate.cleared) || !candidate.roomId || !candidate.peerUserId) continue;
    const previous = chosen.get(candidate.peerUserId);
    const time = candidate.latestActivityMs ?? -Infinity;
    const oldTime = previous?.latestActivityMs ?? -Infinity;
    if (previous && (time < oldTime || (time === oldTime && candidate.roomId >= previous.roomId))) continue;
    chosen.set(candidate.peerUserId, candidate);
  }
  return Object.fromEntries([...chosen].map(([peer, room]) => [peer, room.roomId]));
}

export function clearedChatMarker(content, roomId) {
  const rooms = clearedRooms(content);
  return rooms && Object.hasOwn(rooms, roomId) ? clearedTs(rooms[roomId]) : null;
}

/** True when the chat list hides the room: it has a marker and no event after it. latestTs is null when the room has no latest event. */
export function clearedChatHidden(marker, latestTs) {
  return marker !== null && (latestTs === null || latestTs <= marker);
}

/** True when the timeline and search keep an event with this origin_server_ts. */
export function clearedChatKeepsEvent(marker, eventTs) {
  return marker === null || eventTs > marker;
}

/** The content to write when the user clears roomId at ts. Keeps every other key and entry as it is. The marker never moves back. */
export function clearedChatsWithClear(content, roomId, ts) {
  const base = content && typeof content === "object" && !Array.isArray(content) ? content : {};
  const rooms = clearedRooms(base) ?? {};
  const old = Object.hasOwn(rooms, roomId) ? clearedTs(rooms[roomId]) : null;
  return { ...base, rooms: { ...rooms, [roomId]: { ts: old !== null && old > ts ? old : ts } } };
}

// ADR 0018. Adapters supply an authenticated verified name and an already-known, permitted contact match.
export function relationshipNameWarning(savedName, verifiedName, nicknameConfirmed, reg) {
  if (typeof savedName !== 'string' || typeof verifiedName !== 'string') return null;
  const saved = normalize(savedName, reg.homoglyphs.map);
  const verified = normalize(verifiedName, reg.homoglyphs.map);
  if (!saved || !verified || saved === verified) return null;
  const words = saved.split(' ').filter(word => /\p{L}/u.test(word));
  const padded = ` ${saved.replace(/[^0-9a-z]+/g, " ")} `;
  const family = reg.family.terms.some(term => padded.includes(` ${term} `));
  if (words.length >= reg.relationshipNames.fullNameMinimumWords && !family) return 'mismatch';
  return nicknameConfirmed === true ? null : 'confirm';
}

/** Archive is separate from cleared history. Only a strictly newer incoming message restores it. */
export function chatArchived(marker, incoming) {
  return Number.isSafeInteger(marker) && marker >= 0 && !(Number.isSafeInteger(incoming) && incoming > marker);
}
