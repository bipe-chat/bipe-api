import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { MatrixAuth, StaffGate } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db.js";
import { ApiError } from "./errors.js";
import { availability, handleChanges, lookup, myHandle, pruneHandleChanges, removeHandle, resolve, setHandle } from "./handles.js";
import { createPersonalInvite, inviteConnections, inviterReport, myInvites, nameInvite, previewInvite, revokePersonalInvite } from "./invites.js";
import { Mas } from "./mas.js";
import { RateLimiter } from "./ratelimit.js";
import { SignupLimits } from "./signup-limits.js";
import { newChallenge } from "./attest.js";
import { refreshKeyAttestationStatus } from "./key-attest.js";
import { checkInternal, mayInvite, POLICIES, policyOf, setPolicy } from "./messaging.js";
import { forgetSignupReplay, pruneSignupReplays, replaySignup, signup } from "./signup.js";
import { checkTermsVersion, recordTerms } from "./terms.js";
import { getDiscovery, lookupContacts, LOOKUP_MAX_PER_REQUEST, myPhone, PhoneHasher, setDiscovery, unlinkPhone } from "./phones.js";
import { joinWaitlist, pruneWaitlist, WaitlistBody } from "./waitlist.js";
import { countEvent, ExperimentEventBody } from "./experiments.js";
import { addDomain, checkDomain, createClaim, getClaim, proveWithEcnpj, runScan, withdrawClaim } from "./business.js";
import { loadPinnedCertificates } from "./cms.js";
import { loadIcpBrasilRoots } from "./ecnpj.js";
import { createGovbrChallenge, GOVBR_PDF_MAX_BYTES, pruneGovbrChallenges, submitGovbrDocument } from "./govbr.js";
import { deletePhoto, myProfile, publicPhoto, publicProfile, saveProfile, setPhoto } from "./profiles.js";
import { legalRules, profileRules } from "./registry.js";
import { accountStatus, cancelRecovery, claimRecovery, confirmRecoveryEmail, moveToDeviceFirst, redeemToken, removeEmail, requestRecoveryEmail, rotateRecoveryToken, setEmail, setPin, verifyEmail, verifyPin, type AccountDeps } from "./accounts.js";
import { Mailer } from "./mailer.js";
import { PinHasher, SECRET_PATTERN, secretHash } from "./secrets.js";
import { Growth, growthNumbers } from "./growth.js";
import { Visits } from "./visits.js";
import { researchRoutes } from "./research/routes.js";
import { finishWebLink, Geo } from "./weblink.js";
import { staffGrowth } from "./staff-report.js";
import { recordKeychainMove } from "./transfer.js";
import { cancelDeletion, DELETION_TICK_MS, pruneDeletions, requestDeletion, runDueDeletions, type DeletionDeps } from "./deletion.js";
import { SynapseAdmin } from "./synapse-admin.js";
import { businessReport, experimentsReport, StaffReports, waitlistReport } from "./staff-reports.js";
import { exportData } from "./export.js";
import { Badges } from "./badges.js";
import { BODY_MAX_BYTES, getBugReport, listBugReports, pruneBugReports, readBugReportFile, submitBugReport, type BugReportDeps } from "./bug-reports.js";
import { Intake, verifyIntakeSignature } from "./intake.js";
import { SupportBot } from "./support.js";
import { NewsBot } from "./news.js";
import { startCvmRefresh } from "./cvm.js";
import { currentBanner } from "./banner.js";
import { invitePreviewHtml } from "./invite-preview.js";
import { getWorkHours, setWorkHours } from "./work-hours.js";
import { APP_IDS, finishWebFlow, isProvider, linkAccount, Links, type LinkDeps, newNonce, pruneLinks, recoverWithLink, startWebFlow, unlinkAccount, type Provider } from "./links.js";
import { agendaHousekeeping } from "./agenda.js";
import { orderHousekeeping } from "./orders.js";
import { queueHousekeeping } from "./queue.js";
import { quoteHousekeeping } from "./quotes.js";
import { businessRoutes, CATALOG_PHOTO_PATH } from "./business-routes.js";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { login, logout, pageOf, PROPOSTA_COOKIE, PROPOSTA_COOKIE_PATH, PropostaBeaconBody, PropostaLoginBody, propostaReport, prunePropostaLog, recordVisit, referrerOrigin, sessionVisitor, SESSION_DAYS } from "./proposta.js";

const config = loadConfig();
const db = openDb(config.DATABASE_URL);
await migrate(db);
const mas = new Mas(config);
const auth = new MatrixAuth(config);
const staff = new StaffGate(auth, mas);
const phoneHasher = new PhoneHasher(config.PHONE_HMAC_SECRET);
const invitePolicy = { perUser: config.INVITES_PER_USER, respawnDays: config.INVITE_RESPAWN_DAYS };
const growth = new Growth(db, { secret: config.BIPE_GROWTH_HMAC_SECRET, synapseUrl: config.SYNAPSE_DATABASE_URL, serverName: config.SERVER_NAME, skipUsers: [config.SUPPORT_USER_ID, config.NEWS_USER_ID] });
const news = new NewsBot(db, config);
const accounts: AccountDeps = { db, mas, config, pins: new PinHasher(config.BIPE_PIN_PEPPER), mailer: new Mailer(config), growth, news };
const linkDeps: LinkDeps = { ...accounts, links: new Links(config) };
const visits = new Visits(config.UMAMI_DATABASE_URL, config.UMAMI_WEBSITE_ID);
const geo = new Geo(config.GEOIP_CITY_DB);
const staffReports = new StaffReports(db, config.SYNAPSE_DATABASE_URL, visits);
const badges = new Badges(db, { keyDir: config.BIPE_BADGE_KEY_DIR, synapseUrl: config.SYNAPSE_DATABASE_URL });
const intake = new Intake(db, config.STARLINGS_INTAKE_URL, config.STARLINGS_APP_INTAKE_KEY);
const support = new SupportBot(db, config, intake);
const bugReports: BugReportDeps = { db, intake, dir: config.BUG_REPORTS_DIR, publicApiUrl: config.PUBLIC_API_URL, support };
console.log(`badges: ${badges.state}`);
console.log(`problem reports: stored; starlings intake: ${intake.enabled ? "on" : "off (no STARLINGS_APP_INTAKE_KEY)"}`);
console.log(`visit report: ${visits.enabled ? "on" : "off (no UMAMI_DATABASE_URL)"}`);
console.log(`growth events: ${growth.enabled ? (growth.synapseEnabled ? "api and synapse" : "api only (no SYNAPSE_DATABASE_URL)") : "off (no BIPE_GROWTH_HMAC_SECRET)"}`);
console.log(`support bot: ${support.enabled ? "on" : "off (no SUPPORT_ACCESS_TOKEN or SUPPORT_STORE_PASSPHRASE)"}`);
console.log(`news bot: ${news.enabled ? "on" : "off (no NEWS_ACCESS_TOKEN or NEWS_STORE_PASSPHRASE)"}`);
console.log(`cvm register: ${config.CVM_REFRESH ? "daily refresh on" : "off (CVM_REFRESH=false)"}`);
console.log(`pin pepper: ${config.BIPE_PIN_PEPPER ? "set" : "NOT SET (PIN routes answer internal)"}; outgoing email: ${accounts.mailer.enabled ? "on" : "off"}`);
console.log(`linked recovery: ${JSON.stringify(linkDeps.links.providers().providers)}`);

const limits = {
  signup: new SignupLimits(config.SIGNUP_MAX_PER_HOUR),
  signupResume: new RateLimiter(30, 3_600_000),
  terms: new RateLimiter(10, 3_600_000),
  availability: new RateLimiter(60, 60_000),
  lookup: new RateLimiter(30, 60_000),
  resolve: new RateLimiter(120, 60_000),
  handleChanges: new RateLimiter(60, 60_000),
  setHandle: new RateLimiter(10, 3_600_000),
  invitePreview: new RateLimiter(30, 60_000),
  invitePreviewHead: new RateLimiter(60, 60_000),
  inviteCreate: new RateLimiter(20, 3_600_000),
  contactsLookup: new RateLimiter(30, 3_600_000),
  attestChallenge: new RateLimiter(20, 3_600_000),
  setMessaging: new RateLimiter(30, 3_600_000),
  dataExport: new RateLimiter(3, 3_600_000),
  waitlist: new RateLimiter(5, 3_600_000),
  waitlistGlobal: new RateLimiter(500, 3_600_000),
  events: new RateLimiter(30, 3_600_000),
  profile: new RateLimiter(60, 60_000),
  profilePhoto: new RateLimiter(120, 60_000),
  badge: new RateLimiter(120, 60_000),
  accountType: new RateLimiter(300, 60_000),
  setProfile: new RateLimiter(30, 3_600_000),
  setProfilePhoto: new RateLimiter(10, 3_600_000),
  eventsGlobal: new RateLimiter(20_000, 3_600_000),
  businessClaim: new RateLimiter(10, 3_600_000),
  businessProof: new RateLimiter(20, 3_600_000),
  businessDomain: new RateLimiter(30, 3_600_000),
  // Device-first accounts (ADR 0057). The PIN limit (5 wrong in total) is in the database; these limit cost and spam.
  pinSet: new RateLimiter(10, 3_600_000),
  pinCheck: new RateLimiter(10, 3_600_000),
  credentials: new RateLimiter(5, 3_600_000),
  emailSet: new RateLimiter(5, 3_600_000),
  keychainMove: new RateLimiter(20, 3_600_000),
  deletion: new RateLimiter(3, 3_600_000),
  deletionCancel: new RateLimiter(20, 3_600_000),
  emailVerify: new RateLimiter(20, 3_600_000),
  recoveryToken: new RateLimiter(10, 3_600_000),
  recoveryTokenGlobal: new RateLimiter(300, 3_600_000),
  recoveryEmail: new RateLimiter(5, 3_600_000),
  recoveryEmailAddress: new RateLimiter(3, 3_600_000),
  recoveryConfirm: new RateLimiter(10, 3_600_000),
  recoveryClaim: new RateLimiter(120, 3_600_000),
  // Linked Apple or Google account (ADR 0096).
  linkStart: new RateLimiter(20, 3_600_000),
  linkSet: new RateLimiter(10, 3_600_000),
  recoveryLinkStart: new RateLimiter(20, 3_600_000),
  recoveryLink: new RateLimiter(10, 3_600_000),
  recoveryLinkGlobal: new RateLimiter(300, 3_600_000),
  linkCallback: new RateLimiter(60, 3_600_000),
  // Web sign-in approval (ADR 0118).
  webLinkFinish: new RateLimiter(20, 3_600_000),
  webLinkPlace: new RateLimiter(60, 3_600_000),
  // Problem reports (bipe#367).
  bugReport: new RateLimiter(10, 3_600_000),
  bugReportGlobal: new RateLimiter(500, 3_600_000),
  // Support DM (ADR 0114).
  supportRoom: new RateLimiter(30, 3_600_000),
  newsSwitch: new RateLimiter(20, 3_600_000),
  starlingsReply: new RateLimiter(600, 3_600_000),
  banner: new RateLimiter(120, 60_000),
  workHours: new RateLimiter(30, 3_600_000),
  // gov.br signed challenge (bipe#543).
  govbrChallenge: new RateLimiter(10, 3_600_000),
  govbrDocument: new RateLimiter(20, 3_600_000),
  propostaLogin: new RateLimiter(10, 15 * 60_000),
  propostaBeacon: new RateLimiter(600, 3_600_000),
};

// CNPJ verification (ADR 0042): pinned ICP-Brasil roots, and a registry scan for claims waiting on it.
const icpBrasilRoots = loadIcpBrasilRoots(config.ICP_BRASIL_ROOTS_DIR);
console.log(`icp-brasil roots: ${icpBrasilRoots.length}`);
// gov.br signed challenge (bipe#543): pinned gov.br roots, not ICP-Brasil.
const govbrRoots = loadPinnedCertificates(config.GOVBR_ROOTS_DIR);
console.log(`govbr roots: ${govbrRoots.length}`);
const pruneGovbr = () =>
  void pruneGovbrChallenges(db)
    .then((n) => n > 0 && console.log(`govbr challenges pruned: ${n}`))
    .catch((e) => console.error(`govbr prune failed: ${(e as Error).message}`));
pruneGovbr();
setInterval(pruneGovbr, 24 * 3_600_000).unref();
const pruneLinkRows = () =>
  void pruneLinks(db).catch((e) => console.error(`link prune failed: ${(e as Error).message}`));
pruneLinkRows();
setInterval(pruneLinkRows, 3_600_000).unref();
const kickScan = () => void runScan(db, config, "pending").catch((e) => console.error(`cnpj scan failed: ${(e as Error).message}`));
setInterval(kickScan, 15 * 60_000).unref();

// Android Key Attestation (bipe#92): Google's list of revoked attestation keys.
void refreshKeyAttestationStatus();
setInterval(() => void refreshKeyAttestationStatus(), 6 * 3_600_000).unref();

// Handle change history retention (ADR 0066). Logs the count only.
const pruneChanges = () =>
  void pruneHandleChanges(db)
    .then((n) => n > 0 && console.log(`handle changes pruned: ${n}`))
    .catch((e) => console.error(`handle change prune failed: ${(e as Error).message}`));
pruneChanges();
setInterval(pruneChanges, 24 * 3_600_000).unref();
const pruneReplays = () =>
  void pruneSignupReplays(db)
    .then((n) => n > 0 && console.log(`signup replays pruned: ${n}`))
    .catch((e) => console.error(`signup replay prune failed: ${(e as Error).message}`));
pruneReplays();
setInterval(pruneReplays, 24 * 3_600_000).unref();
const pruneWaitlistEntries = () =>
  void pruneWaitlist(db)
    .then((n) => n > 0 && console.log(`waitlist entries pruned: ${n}`))
    .catch((e) => console.error(`waitlist prune failed: ${(e as Error).message}`));
pruneWaitlistEntries();
setInterval(pruneWaitlistEntries, 24 * 3_600_000).unref();
support.start();
news.start();
if (config.CVM_REFRESH) startCvmRefresh(db);
const pruneReports = () =>
  void pruneBugReports(db, config.BUG_REPORTS_DIR)
    .then((n) => n > 0 && console.log(`problem reports pruned: ${n}`))
    .catch((e) => console.error(`problem report prune failed: ${(e as Error).message}`));
pruneReports();
setInterval(pruneReports, 24 * 3_600_000).unref();
// Retries for Starlings intake lines that failed. A new line is sent at once.
setInterval(() => void intake.flush(), 60_000).unref();
void intake.flush();
// Agenda (bipe#318): confirmed bookings past their end become done, expired holds end, bookings go after two years.
const agendaJob = () =>
  void agendaHousekeeping(db)
    .then((r) => r.pruned > 0 && console.log(`bookings pruned: ${r.pruned}`))
    .catch((e) => console.error(`agenda housekeeping failed: ${(e as Error).message}`));
agendaJob();
setInterval(agendaJob, 5 * 60_000).unref();
// Fila virtual, Orçamento, Pedidos: stale queue places end, records go after their retention (ADRs 0105 to 0107).
const toolsJob = () =>
  void Promise.all([queueHousekeeping(db), quoteHousekeeping(db), orderHousekeeping(db)])
    .then(([q, qt, o]) => q.pruned + qt.pruned + o.pruned > 0 && console.log(`business records pruned: ${q.pruned + qt.pruned + o.pruned}`))
    .catch((e) => console.error(`business housekeeping failed: ${(e as Error).message}`));
toolsJob();
setInterval(toolsJob, 60 * 60_000).unref();
// Strategic pages (ADR 0157, ADR 0158): visits go after 365 days, ended sessions go.
const prunePropostaJob = () =>
  void prunePropostaLog(db)
    .then((n) => n > 0 && console.log(`strategic page visits pruned: ${n}`))
    .catch((e) => console.error(`strategic page prune failed: ${(e as Error).message}`));
prunePropostaJob();
setInterval(prunePropostaJob, 24 * 3_600_000).unref();
// Account deletion (ADR 0140): due requests run every minute; the kept verification records go after their retention.
const deletions: DeletionDeps = {
  ...accounts,
  synapse: config.SYNAPSE_ADMIN_TOKEN ? new SynapseAdmin(config.SYNAPSE_URL, config.SYNAPSE_ADMIN_TOKEN) : null,
  bugReportsDir: config.BUG_REPORTS_DIR,
  serviceUsers: [config.SUPPORT_USER_ID, config.NEWS_USER_ID],
};
console.log(`account deletion job: ${deletions.synapse ? "on" : "off (no SYNAPSE_ADMIN_TOKEN): requests wait"}`);
const deletionJob = () => void runDueDeletions(deletions).catch((e) => console.error(`deletion job failed: ${(e as Error).message}`));
setInterval(deletionJob, DELETION_TICK_MS).unref();
const pruneDeletionRecords = () =>
  void pruneDeletions(db)
    .then((n) => n > 0 && console.log(`deletion records pruned: ${n}`))
    .catch((e) => console.error(`deletion prune failed: ${(e as Error).message}`));
pruneDeletionRecords();
setInterval(pruneDeletionRecords, 24 * 3_600_000).unref();
const syncGrowth = () => void growth.sync().catch((e) => console.error(`growth sync failed: ${(e as Error).message}`));
syncGrowth();
setInterval(syncGrowth, 15 * 60_000).unref();
const CnpjBody = z.object({ cnpj: z.string().max(32) });
const EcnpjBody = z.object({ signature: z.string().min(1).max(131_072) });
const DomainBody = z.object({ domain: z.string().max(253) });

const Lang = z.enum(["pt", "en"]);
const PinField = z.string().max(64);
const TERMS_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SecretField = z.string().max(128);
const SignupBody = z.object({
  // A code, an invite link or a whole pasted message: the server finds the code in it.
  invite_code: z.string().max(2048).optional(),
  // Device-first: email optional (recovery fallback), no password. Legacy: email and password (login).
  email: z.email().max(254).optional(),
  password: z.string().min(8).max(256).optional(),
  pin: PinField.optional(),
  lang: Lang.optional(),
  handle: z.string().max(64).optional(),
  display_name: z.string().max(100).optional(),
  // One form: Apple App Attest or Android Key Attestation (bipe#92). Both fields at once are a bad request.
  attestation: z
    .union([
      z.object({
        key_attestation_chain: z.array(z.string().min(1).max(8192)).min(2).max(8),
        challenge: z.string().min(1).max(128),
        key_id: z.never().optional(),
        attestation_object: z.never().optional(),
      }),
      z.object({
        key_id: z.string().min(1).max(128),
        attestation_object: z.string().min(1).max(16_384),
        challenge: z.string().min(1).max(128),
        key_attestation_chain: z.never().optional(),
      }),
    ])
    .optional(),
  signup_key: z.string().regex(SECRET_PATTERN).optional(),
  terms_version: z.string().regex(TERMS_VERSION_PATTERN).optional(),
  // ADR 0087: company accounts need an attestation and are device-first only.
  account_type: z.enum(["personal", "company"]).optional(),
});
const TermsBody = z.object({ terms_version: z.string().regex(TERMS_VERSION_PATTERN) });
const SignupResumeBody = z.object({ signup_key: z.string().regex(SECRET_PATTERN) });
const HandleBody = z.object({ handle: z.string().max(64) });
const PinBody = z.object({ pin: PinField });
const EmailBody = z.object({ email: z.email().max(254), lang: Lang.default("pt") });
const TokenBody = z.object({ token: SecretField });
const RedeemBody = z.object({ recovery_token: SecretField, pin: PinField });
const RecoveryEmailBody = z.object({ email: z.email().max(254) });
const ConfirmBody = z.object({ token: SecretField, pin: PinField.optional(), new_pin: PinField.optional() });
const ClaimBody = z.object({ claim_secret: SecretField });
const TimeField = z.string().max(5);
const WorkHoursBody = z.object({
  enabled: z.boolean(),
  time_zone: z.string().min(1).max(64),
  days: z.array(z.object({ day: z.number().int(), ranges: z.array(z.object({ start: TimeField, end: TimeField })).max(10) })).max(7),
});
const LinkProofBody = z.object({
  id_token: z.string().min(1).max(8192).optional(),
  flow_id: z.string().min(1).max(64).optional(),
  handoff: z.string().max(128).optional(),
});
const RecoveryLinkBody = LinkProofBody.extend({ provider: z.enum(["apple", "google"]), pin: PinField });
const LinkWebBody = z.object({ app_id: z.enum(APP_IDS) });
const LookupBody = z.object({ phones: z.array(z.string().max(64)).max(LOOKUP_MAX_PER_REQUEST) });
const DiscoveryBody = z.object({ by_phone: z.boolean() });
const ResolveBody = z.object({ user_ids: z.array(z.string().max(255)).max(100) });
const HandleChangesBody = z.object({ user_ids: z.array(z.string().max(255)).max(100), since: z.iso.datetime({ offset: true }).optional() });
// Lengths are checked by problemWithProfile(); these caps only bound the request.
const ProfileBody = z.object({ enabled: z.boolean(), name: z.string().max(400), bio: z.string().max(2000) });
const PHOTO_PATH = "/v1/me/profile/photo";
const BUG_REPORT_PATH = "/v1/bug-reports/submit";
const GOVBR_DOCUMENT_PATH = /^\/v1\/verifications\/govbr\/[^/]+\/document$/;

// Caddy appends the client address last; earlier X-Forwarded-For entries come from the client.
function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

async function parse<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("bad_request", parsed.error.issues[0]?.path.join("."));
  return parsed.data;
}

const app = new Hono();
// A CMS signature with its certificate chain can pass 16 KB, and a profile photo too; those routes get more room.
const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "bad_request" }, 413) });
const signatureBody = bodyLimit({ maxSize: 160 * 1024, onError: (c) => c.json({ error: "bad_request" }, 413) });
const reportBody = bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c) => c.json({ error: "bad_request", reason: "too_large" }, 413) });
const govbrBody = bodyLimit({ maxSize: GOVBR_PDF_MAX_BYTES, onError: (c) => c.json({ error: "bad_request", reason: "too_large" }, 413) });
const photoBody = bodyLimit({ maxSize: profileRules.photoMaxBytes, onError: (c) => c.json({ error: "photo_invalid", reason: "too_large" }, 413) });
app.use("*", (c, next) => {
  if (c.req.path === BUG_REPORT_PATH) return reportBody(c, next);
  if (c.req.path === "/v1/me/business/ecnpj") return signatureBody(c, next);
  if (c.req.path === PHOTO_PATH || CATALOG_PHOTO_PATH.test(c.req.path)) return photoBody(c, next);
  if (GOVBR_DOCUMENT_PATH.test(c.req.path)) return govbrBody(c, next);
  return smallBody(c, next);
});

app.get("/healthz", (c) => c.text("ok"));

app.post("/v1/attest/challenge", (c) => {
  limits.attestChallenge.check(clientIp(c));
  return c.json({ challenge: newChallenge() });
});

app.post("/v1/signup", async (c) => {
  const body = await parse(c, SignupBody);
  // A retry of a sign-up that already made the account must not hit the limits (ADR 0094): the app would read a 429
  // as "nothing was made".
  if (body.signup_key !== undefined && body.password === undefined) {
    limits.signupResume.check(clientIp(c));
    const earlier = await replaySignup(db, body.signup_key);
    if (earlier) {
      c.header("cache-control", "no-store");
      return c.json(earlier, 201);
    }
  }
  limits.signup.attempt(clientIp(c), body.attestation !== undefined);
  const result = await signup(accounts, body, limits.signup.creation);
  // Device-first: the body carries the hidden password and the recovery token, once.
  c.header("cache-control", "no-store");
  return c.json(result, 201);
});

// ADR 0072, bipe#232: the apps follow the sign-up mode with no new build.
app.get("/v1/signup/config", (c) => {
  c.header("cache-control", "public, max-age=300");
  return c.json({ invite_required: config.SIGNUP_INVITE_REQUIRED, terms_version: legalRules.legalVersion });
});

// Remote critical banner (ADR 0117, bipe#386). No auth: the apps read it on launch and on foreground.
app.get("/v1/banner", async (c) => {
  limits.banner.check(clientIp(c));
  c.header("cache-control", "public, max-age=60");
  return c.json({ banner: await currentBanner(db) });
});

// ADR 0094: the app lost the answer of a sign-up. The key is the only proof, so no form and no attestation.
app.post("/v1/signup/resume", async (c) => {
  limits.signupResume.check(clientIp(c));
  const result = await replaySignup(db, (await parse(c, SignupResumeBody)).signup_key);
  if (!result) throw new ApiError("not_found");
  c.header("cache-control", "no-store");
  return c.json(result);
});

// --- Device-first accounts (ADR 0057, ADR 0059) --------------------------------------------------------

app.get("/v1/me/account", async (c) => {
  const { userId, deviceId } = await auth.session(c.req.header("authorization"));
  // The app signed in, so it has its credentials: the sealed sign-up copy (ADR 0094) can go.
  await forgetSignupReplay(db, userId);
  growth.onboarded(userId);
  return c.json(await accountStatus(accounts, userId, config.MAX_PERSONAL_ACCOUNTS, deviceId));
});

// ADR 0113: accounts from before the clickwrap, and everyone after a new legalVersion, accept on a re-accept screen.
app.post("/v1/me/terms", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.terms.check(userId);
  const version = checkTermsVersion((await parse(c, TermsBody)).terms_version, true)!;
  await recordTerms(db, userId, version, "app");
  return c.body(null, 204);
});

app.put("/v1/me/pin", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.pinSet.check(userId);
  await setPin(accounts, userId, (await parse(c, PinBody)).pin);
  return c.body(null, 204);
});

app.post("/v1/me/pin/check", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.pinCheck.check(userId);
  await verifyPin(accounts, userId, (await parse(c, PinBody)).pin);
  return c.body(null, 204);
});

// Web sign-in approval on the phone (ADR 0118). Never log the IP.
const WebLinkFinishBody = z.object({ since: z.iso.datetime({ offset: true }) });
app.post("/v1/web-link/finish", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.webLinkFinish.check(userId);
  const finished = await finishWebLink(mas, userId, (await parse(c, WebLinkFinishBody)).since);
  return c.json({ finished });
});

app.get("/v1/web-link/place", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.webLinkPlace.check(userId);
  const ip = c.req.query("ip") ?? "";
  if (ip.length > 45) throw new ApiError("bad_request", "ip");
  c.header("cache-control", "no-store");
  return c.json(geo.place(ip));
});

app.post("/v1/me/device-first", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.credentials.check(userId);
  c.header("cache-control", "no-store");
  return c.json(await moveToDeviceFirst(accounts, userId));
});

app.post("/v1/me/recovery-token", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.credentials.check(userId);
  c.header("cache-control", "no-store");
  return c.json(await rotateRecoveryToken(accounts, userId));
});

// bipe#531: an iPhone moved its keychain items into the app-group group. The device comes from the token.
app.post("/v1/me/keychain-move", async (c) => {
  const { userId, deviceId } = await auth.session(c.req.header("authorization"));
  limits.keychainMove.check(userId);
  await recordKeychainMove(db, userId, deviceId);
  return c.body(null, 204);
});

app.put("/v1/me/email", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.emailSet.check(userId);
  const { email, lang } = await parse(c, EmailBody);
  await setEmail(accounts, userId, email, lang);
  return c.body(null, 202);
});

app.delete("/v1/me/email", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await removeEmail(accounts, userId);
  return c.body(null, 204);
});

// Account deletion (ADR 0140): the owner check ran on the phone; the senha is checked here. 72 hours to cancel.
const DeletionBody = z.object({ pin: PinField, redact_messages: z.boolean() });
app.post("/v1/me/deletion", async (c) => {
  const { userId, deviceId } = await auth.session(c.req.header("authorization"));
  limits.deletion.check(userId);
  const { pin, redact_messages } = await parse(c, DeletionBody);
  return c.json(await requestDeletion(accounts, userId, deviceId, pin, redact_messages), 201);
});

app.post("/v1/me/deletions/:id/cancel", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.deletionCancel.check(userId);
  await cancelDeletion(accounts, userId, c.req.param("id").slice(0, 64));
  return c.body(null, 204);
});

app.post("/v1/me/recoveries/:id/cancel", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await cancelRecovery(accounts, userId, c.req.param("id").slice(0, 64));
  return c.body(null, 204);
});

// The confirm page on the public site posts the token from the link fragment.
app.use("/v1/email/verify", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["POST"], allowHeaders: ["content-type"] }));

app.post("/v1/email/verify", async (c) => {
  limits.emailVerify.check(clientIp(c));
  await verifyEmail(accounts, (await parse(c, TokenBody)).token);
  return c.body(null, 204);
});

app.post("/v1/recovery/token", async (c) => {
  limits.recoveryToken.check(clientIp(c));
  limits.recoveryTokenGlobal.check("all");
  const { recovery_token, pin } = await parse(c, RedeemBody);
  c.header("cache-control", "no-store");
  return c.json(await redeemToken(accounts, recovery_token, pin));
});

app.post("/v1/recovery/email", async (c) => {
  limits.recoveryEmail.check(clientIp(c));
  const { email } = await parse(c, RecoveryEmailBody);
  limits.recoveryEmailAddress.check(secretHash(email.trim().toLowerCase()));
  await requestRecoveryEmail(accounts, email);
  return c.body(null, 202);
});

app.post("/v1/recovery/email/confirm", async (c) => {
  limits.recoveryConfirm.check(clientIp(c));
  const { token, pin, new_pin } = await parse(c, ConfirmBody);
  c.header("cache-control", "no-store");
  return c.json(await confirmRecoveryEmail(accounts, token, pin, new_pin), 201);
});

app.post("/v1/recovery/:id/claim", async (c) => {
  limits.recoveryClaim.check(clientIp(c));
  const { claim_secret } = await parse(c, ClaimBody);
  c.header("cache-control", "no-store");
  return c.json(await claimRecovery(accounts, c.req.param("id").slice(0, 64), claim_secret));
});
// Linked Apple or Google account for recovery (ADR 0096, bipe#305). Never log a token, a code, a state or a handoff.
function providerParam(c: Context): Provider {
  const provider = c.req.param("provider") ?? "";
  if (!isProvider(provider)) throw new ApiError("not_found");
  return provider;
}

app.get("/v1/links/providers", (c) => c.json(linkDeps.links.providers()));

app.post("/v1/me/links/nonce", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.linkStart.check(userId);
  c.header("cache-control", "no-store");
  return c.json(await newNonce(linkDeps, "link", userId), 201);
});

app.post("/v1/me/links/:provider/web", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  const provider = providerParam(c);
  limits.linkStart.check(userId);
  const { app_id } = await parse(c, LinkWebBody);
  c.header("cache-control", "no-store");
  return c.json(await startWebFlow(linkDeps, provider, "link", userId, app_id), 201);
});

app.put("/v1/me/links/:provider", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  const provider = providerParam(c);
  limits.linkSet.check(userId);
  await linkAccount(linkDeps, userId, provider, await parse(c, LinkProofBody));
  return c.body(null, 204);
});

app.delete("/v1/me/links/:provider", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await unlinkAccount(linkDeps, userId, providerParam(c));
  return c.body(null, 204);
});

app.post("/v1/recovery/link/nonce", async (c) => {
  limits.recoveryLinkStart.check(clientIp(c));
  c.header("cache-control", "no-store");
  return c.json(await newNonce(linkDeps, "recovery", null), 201);
});

app.post("/v1/recovery/link/:provider/web", async (c) => {
  const provider = providerParam(c);
  limits.recoveryLinkStart.check(clientIp(c));
  const { app_id } = await parse(c, LinkWebBody);
  c.header("cache-control", "no-store");
  return c.json(await startWebFlow(linkDeps, provider, "recovery", null, app_id), 201);
});

app.post("/v1/recovery/link", async (c) => {
  limits.recoveryLink.check(clientIp(c));
  limits.recoveryLinkGlobal.check("all");
  const { provider, pin, ...proof } = await parse(c, RecoveryLinkBody);
  c.header("cache-control", "no-store");
  return c.json(await recoverWithLink(linkDeps, provider, proof, pin), 201);
});

// The provider sends the browser here at the end of the web flow; the answer sends it on to the app.
async function linkCallback(c: Context, provider: Provider, input: { state?: string; code?: string; idToken?: string; error?: string }) {
  limits.linkCallback.check(clientIp(c));
  const target = await finishWebFlow(linkDeps, provider, input);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  if (!target) throw new ApiError("bad_request", "state");
  return c.redirect(target, 303);
}

const field = (v: unknown) => (typeof v === "string" ? v : undefined);

app.get("/v1/links/callback/google", (c) =>
  linkCallback(c, "google", { state: c.req.query("state"), code: c.req.query("code"), error: c.req.query("error") }));

app.post("/v1/links/callback/apple", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return linkCallback(c, "apple", { state: field(form.state), code: field(form.code), idToken: field(form.id_token), error: field(form.error) });
});


// The invite page on the public site reads the preview from the browser.
app.use("/v1/invites/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"] }));

// The waitlist form on the public site posts from the browser.
app.use("/v1/waitlist", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["POST"], allowHeaders: ["content-type"] }));

app.post("/v1/waitlist", async (c) => {
  limits.waitlist.check(clientIp(c));
  limits.waitlistGlobal.check("all");
  await joinWaitlist(db, await parse(c, WaitlistBody));
  return c.body(null, 202);
});

// sendBeacon from the public site: text/plain JSON, no preflight, the browser reads no response.
app.post("/v1/events", async (c) => {
  limits.events.check(clientIp(c));
  limits.eventsGlobal.check("all");
  await countEvent(db, await parse(c, ExperimentEventBody));
  return c.body(null, 204);
});

app.get("/v1/invites/:code", async (c) => {
  limits.invitePreview.check(clientIp(c));
  return c.json(await previewInvite(db, c.req.param("code")));
});

// Link-preview crawlers only: the site edge routes them here for bipe.chat/convite/<code> (bipe#459).
app.get("/v1/web/convite/:code", async (c) => {
  limits.invitePreviewHead.check(clientIp(c));
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex");
  return c.html(await invitePreviewHtml(db, config.PUBLIC_SITE_URL, config.PUBLIC_API_URL, c.req.param("code")));
});

app.get("/v1/me/invites", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await myInvites(db, userId, invitePolicy));
});

app.post("/v1/me/invites", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.inviteCreate.check(userId);
  const invite = await createPersonalInvite(db, userId, invitePolicy, config.PUBLIC_SITE_URL);
  growth.record(userId, "invite_sent");
  return c.json(invite, 201);
});

const MessagingBody = z.object({ who_can_message: z.enum(POLICIES) });
const MayInviteBody = z.object({
  inviter: z.string().max(255),
  invitee: z.string().max(255),
  shares_room: z.boolean(),
});

app.get("/v1/me/messaging", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json({ who_can_message: await policyOf(db, userId) });
});

app.put("/v1/me/messaging", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.setMessaging.check(userId);
  const { who_can_message } = await parse(c, MessagingBody);
  await setPolicy(db, userId, who_can_message);
  return c.json({ who_can_message });
});

// Data export (LGPD art. 18, ADR 0112). The app asks for a biometric check first.
app.get("/v1/me/export", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.dataExport.check(userId);
  const now = new Date();
  const body = await exportData(db, growth, userId, now);
  c.header("cache-control", "no-store");
  c.header("content-disposition", `attachment; filename="bipe-dados-${now.toISOString().slice(0, 10)}.json"`);
  return c.json(body);
});

// Problem reports (bipe#367): the rageshake form from both apps. Signed-in users only; the files stay in Brazil.
app.post(BUG_REPORT_PATH, async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.bugReport.check(userId);
  limits.bugReportGlobal.check("all");
  if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) throw new ApiError("bad_request", "content-type");
  const form = await c.req.parseBody({ all: true }).catch(() => {
    throw new ApiError("bad_request");
  });
  return c.json(await submitBugReport(bugReports, userId, form));
});

// Called by the Synapse module before every invite. Caddy does not route /internal/*.
app.post("/internal/v1/may-invite", async (c) => {
  checkInternal(c.req.header("x-bipe-internal"), config.BIPE_INTERNAL_SECRET);
  const { inviter, invitee, shares_room } = await parse(c, MayInviteBody);
  // The support account (ADR 0114) opens one support room per user, whatever their policy.
  // So does the news account (ADR 0117): one read-only room per user.
  if (inviter === config.SUPPORT_USER_ID || inviter === config.NEWS_USER_ID) return c.json({ allow: true, policy: await policyOf(db, invitee) });
  return c.json(await mayInvite(db, inviter, invitee, shares_room));
});

// Support DM (ADR 0114): the caller's room with the support account.
app.post("/v1/me/support", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.supportRoom.check(userId);
  return c.json({ room_id: await support.roomFor(userId) });
});

// Novidades do Bipe (ADR 0117, bipe#387): the Settings switch. GET reads it, PUT turns news on (a new room when the
// user left the old one), DELETE turns it off (the app also leaves the room).
// Work side opening hours (ADR 0138 rule 4, bipe#511). Company accounts only.
app.get("/v1/me/work-hours", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await getWorkHours(db, userId));
});

app.put("/v1/me/work-hours", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.workHours.check(userId);
  return c.json(await setWorkHours(db, userId, await parse(c, WorkHoursBody)));
});

app.get("/v1/me/news", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await news.state(userId));
});
app.put("/v1/me/news", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.newsSwitch.check(userId);
  return c.json(await news.subscribe(userId));
});
app.delete("/v1/me/news", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.newsSwitch.check(userId);
  await news.unsubscribe(userId);
  return c.json({ subscribed: false });
});

// A Starlings member's reply (envisioning/starlings#1176), signed with STARLINGS_APP_INTAKE_KEY.
const StarlingsReplyBody = z.object({
  message_id: z.string().min(1).max(255),
  reporter_ref: z.string().min(3).max(255).startsWith("@"),
  text: z.string().trim().min(1).max(10_000),
  author: z.object({ name: z.string().max(120) }),
});
app.post("/v1/support/starlings", async (c) => {
  limits.starlingsReply.check("all");
  if (!config.STARLINGS_APP_INTAKE_KEY) throw new ApiError("support_unavailable");
  const raw = await c.req.text();
  if (!verifyIntakeSignature(config.STARLINGS_APP_INTAKE_KEY, "reply", c.req.header("x-starlings-timestamp"), c.req.header("x-starlings-signature"), raw)) {
    throw new ApiError("unauthorized");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError("bad_request");
  }
  const parsed = StarlingsReplyBody.safeParse(json);
  if (!parsed.success) throw new ApiError("bad_request", parsed.error.issues[0]?.path.join("."));
  await support.reply(parsed.data);
  return c.body(null, 204);
});

app.get("/v1/me/invite-connections", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await inviteConnections(db, userId));
});

const InviteNameBody = z.object({ name: z.string().max(80) });
app.put("/v1/me/invites/:id", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await nameInvite(db, userId, c.req.param("id"), (await parse(c, InviteNameBody)).name);
  return c.body(null, 204);
});

app.delete("/v1/me/invites/:id", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await revokePersonalInvite(db, userId, c.req.param("id"));
  return c.body(null, 204);
});

app.post("/v1/contacts/lookup", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.contactsLookup.check(userId);
  return c.json(await lookupContacts(db, phoneHasher, userId, (await parse(c, LookupBody)).phones));
});

app.get("/v1/me/phone", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await myPhone(db, userId));
});

app.delete("/v1/me/phone", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await unlinkPhone(db, userId);
  return c.body(null, 204);
});

app.get("/v1/me/discovery", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await getDiscovery(db, userId));
});

app.put("/v1/me/discovery", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await setDiscovery(db, userId, (await parse(c, DiscoveryBody)).by_phone));
});

app.get("/v1/handles/:handle/availability", async (c) => {
  limits.availability.check(clientIp(c));
  return c.json(await availability(db, c.req.param("handle")));
});

app.post("/v1/handles/resolve", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.resolve.check(userId);
  return c.json(await resolve(db, (await parse(c, ResolveBody)).user_ids));
});

// ADR 0066: the app sends the Matrix IDs it shares rooms with. No membership check here, like resolve.
app.post("/v1/handle-changes", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.handleChanges.check(userId);
  const body = await parse(c, HandleChangesBody);
  return c.json(await handleChanges(db, body.user_ids, body.since ? new Date(body.since) : undefined));
});

app.get("/v1/handles/:handle", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.lookup.check(userId);
  return c.json(await lookup(db, c.req.param("handle")));
});

// Public profiles (ADR 0041). The profile page on the public site reads them from the browser.
app.use("/v1/profiles/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"] }));

app.get("/v1/profiles/:handle", async (c) => {
  limits.profile.check(clientIp(c));
  const profile = await publicProfile(db, config.PUBLIC_API_URL, c.req.param("handle"), badges);
  // Turning a profile off must hide it at once.
  c.header("cache-control", "no-store");
  return c.json(profile);
});

app.get("/v1/profiles/:handle/photo", async (c) => {
  limits.profilePhoto.check(clientIp(c));
  const photo = await publicPhoto(db, c.req.param("handle"));
  return c.body(new Uint8Array(photo), 200, {
    "content-type": "image/jpeg",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
});

// Badges (bipe#399, ADR 0123). Public: anyone who sees a message may check the sender's seal. Apps verify the
// envelope locally and never trust the status alone.
app.use("/v1/badges/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"] }));

app.get("/v1/badges/:userId", async (c) => {
  limits.badge.check(clientIp(c));
  const userId = c.req.param("userId");
  if (!/^@[^:\s]{1,255}:[^\s]{1,255}$/.test(userId)) throw new ApiError("not_found");
  const result = await badges.forUser(userId);
  // A revoke must show within minutes; the badge itself expires within lifeDays anyway.
  c.header("cache-control", "public, max-age=300");
  if (result.status === 410) return c.json({ reason: result.reason }, 410);
  if (result.status === 404) throw new ApiError("not_found");
  return c.json(result.envelope);
});

// Account type (ADR 0132): the apps draw a company avatar as a rounded square. Public, like the badge.
app.get("/v1/accounts/:userId/type", async (c) => {
  limits.accountType.check(clientIp(c));
  const userId = c.req.param("userId");
  if (!/^@[^:\s]{1,255}:[^\s]{1,255}$/.test(userId)) throw new ApiError("not_found");
  const { rows } = await db.query<{ account_type: string }>("SELECT account_type FROM signups WHERE user_id = $1", [userId]);
  if (!rows[0]) throw new ApiError("not_found");
  // The type never changes after sign-up.
  c.header("cache-control", "public, max-age=86400");
  return c.json({ account_type: rows[0].account_type === "company" ? "company" : "personal" });
});

app.get("/v1/me/profile", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await myProfile(db, config.PUBLIC_API_URL, userId));
});

app.put("/v1/me/profile", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.setProfile.check(userId);
  return c.json(await saveProfile(db, config.PUBLIC_API_URL, userId, await parse(c, ProfileBody)));
});

app.put(PHOTO_PATH, async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.setProfilePhoto.check(userId);
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "image/jpeg") throw new ApiError("photo_invalid", "not_jpeg");
  const body = new Uint8Array(await c.req.arrayBuffer());
  return c.json(await setPhoto(db, config.PUBLIC_API_URL, userId, body));
});

app.delete(PHOTO_PATH, async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await deletePhoto(db, config.PUBLIC_API_URL, userId));
});

app.get("/v1/me/handle", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await myHandle(db, userId));
});

app.put("/v1/me/handle", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.setHandle.check(userId);
  return c.json(await setHandle(db, userId, (await parse(c, HandleBody)).handle));
});

app.delete("/v1/me/handle", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.setHandle.check(userId);
  return c.json(await removeHandle(db, userId));
});

app.get("/v1/me/business", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await getClaim(db, userId));
});

app.post("/v1/me/business", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.businessClaim.check(userId);
  return c.json(await createClaim(db, config, userId, (await parse(c, CnpjBody)).cnpj, kickScan), 201);
});

app.delete("/v1/me/business", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  await withdrawClaim(db, userId);
  return c.body(null, 204);
});

app.post("/v1/me/business/ecnpj", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.businessProof.check(userId);
  return c.json(await proveWithEcnpj(db, userId, (await parse(c, EcnpjBody)).signature, icpBrasilRoots));
});

app.post("/v1/me/business/domains", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.businessDomain.check(userId);
  return c.json(await addDomain(db, userId, (await parse(c, DomainBody)).domain), 201);
});

app.post("/v1/me/business/domains/:domain/check", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.businessDomain.check(userId);
  return c.json(await checkDomain(db, userId, c.req.param("domain")));
});

// gov.br signed challenge, trust step 5 (bipe#543). The badge binds to the device that starts the challenge.
app.post("/v1/verifications/govbr", async (c) => {
  const { userId, deviceId } = await auth.session(c.req.header("authorization"));
  limits.govbrChallenge.check(userId);
  if (govbrRoots.length === 0) throw new ApiError("internal", "govbr_roots_missing");
  if (!deviceId) throw new ApiError("bad_request", "no_device");
  const deviceKey = await badges.deviceKey(userId, deviceId);
  if (!deviceKey) throw new ApiError("internal", "device_key_unavailable");
  return c.json(await createGovbrChallenge(db, userId, deviceKey), 201);
});

app.put("/v1/verifications/govbr/:id/document", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.govbrDocument.check(userId);
  const pdf = Buffer.from(await c.req.arrayBuffer());
  const status = await submitGovbrDocument(
    db,
    {
      roots: govbrRoots,
      cpfSecret: config.BIPE_CPF_HMAC_SECRET,
      badgeOf: async (id) => {
        const r = await badges.forUser(id);
        return r.status === 200 ? r.envelope : null;
      },
    },
    userId,
    c.req.param("id"),
    pdf,
  );
  return c.json(status);
});

// Staff reports (ADR 0056): bipe.chat/admin/convites/ and /admin/visitas/.
app.use("/v1/admin/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"], allowHeaders: ["authorization"] }));
app.route("/v1/admin/research", researchRoutes(staff));

app.get("/v1/admin/inviters", async (c) => {
  await staff.userId(c.req.header("authorization"));
  const limit = z.coerce.number().int().min(1).max(1000).default(200).safeParse(c.req.query("limit"));
  if (!limit.success) throw new ApiError("bad_request");
  const rows = await inviterReport(db, limit.data, config.SERVER_NAME);
  return c.json({ inviters: rows.map((r) => ({ ...r, last_join: r.last_join?.toISOString() ?? null })) });
});

app.get("/v1/admin/visits", async (c) => {
  await staff.userId(c.req.header("authorization"));
  const days = z.coerce.number().int().min(1).max(400).default(30).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return c.json(await visits.report(days.data));
});

app.get("/v1/admin/growth", async (c) => {
  await staff.userId(c.req.header("authorization"));
  const since = z.iso.date().optional().safeParse(c.req.query("since"));
  if (!since.success) throw new ApiError("bad_request");
  // Default: the last 90 days. The sync stays on its 15-minute job; the page reads stored rows.
  const from = since.data ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  return c.json(staffGrowth(await growthNumbers(db, from), from));
});

// Strategic pages at bipe.chat/proposta/ (ADR 0157, ADR 0158): any email with one shared password. The edge sends /proposta/_auth/* here, so the cookie belongs
// to bipe.chat, and asks /v1/proposta/check before each request (Caddy forward_auth).
const placeOf = (ip: string) => {
  try {
    return geo.place(ip);
  } catch {
    return {};
  }
};
app.post("/v1/proposta/login", async (c) => {
  limits.propostaLogin.check(clientIp(c));
  const body = await parse(c, PropostaLoginBody);
  const secret = await login(db, body.email, body.password);
  setCookie(c, PROPOSTA_COOKIE, secret, { path: PROPOSTA_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "Lax", maxAge: SESSION_DAYS * 86_400 });
  c.header("cache-control", "no-store");
  return c.body(null, 204);
});
app.post("/v1/proposta/logout", async (c) => {
  await logout(db, getCookie(c, PROPOSTA_COOKIE));
  deleteCookie(c, PROPOSTA_COOKIE, { path: PROPOSTA_COOKIE_PATH, secure: true });
  return c.body(null, 204);
});
app.get("/v1/proposta/check", async (c) => {
  const visitor = await sessionVisitor(db, getCookie(c, PROPOSTA_COOKIE));
  if (visitor === null) throw new ApiError("unauthorized");
  const page = (c.req.header("x-forwarded-method") ?? "GET") === "GET" ? pageOf(c.req.header("x-forwarded-uri")) : null;
  if (page) {
    // A failed log write must not lock the visitor out.
    await recordVisit(db, visitor, { kind: "page", path: page.path, utm: page.utm, referrer: referrerOrigin(c.req.header("referer"), config.PUBLIC_SITE_URL), place: placeOf(clientIp(c)) })
      .catch((e) => console.error(`strategic page visit not logged: ${(e as Error).message}`));
  }
  return c.body(null, 204);
});
// The deck sends the slide on screen with sendBeacon (text/plain JSON).
app.post("/v1/proposta/beacon", async (c) => {
  limits.propostaBeacon.check(clientIp(c));
  const visitor = await sessionVisitor(db, getCookie(c, PROPOSTA_COOKIE));
  if (visitor === null) throw new ApiError("unauthorized");
  let json: unknown;
  try {
    json = JSON.parse(await c.req.text());
  } catch {
    throw new ApiError("bad_request");
  }
  const body = PropostaBeaconBody.safeParse(json);
  if (!body.success) throw new ApiError("bad_request", body.error.issues[0]?.path.join("."));
  await recordVisit(db, visitor, { kind: "slide", path: body.data.path, slide: body.data.slide, place: placeOf(clientIp(c)) });
  return c.body(null, 204);
});

// Read-only staff reports (bipe#368). Each route: staff gate first, then one report.
const staffGet = (path: string, report: (c: Context) => Promise<unknown>) =>
  app.get(path, async (c) => {
    await staff.userId(c.req.header("authorization"));
    return c.json(await report(c));
  });
staffGet("/v1/admin/summary", () => staffReports.summary());
staffGet("/v1/admin/metrics", (c) => {
  const days = z.coerce.number().int().min(14).max(365).default(90).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return staffReports.metrics(days.data);
});
staffGet("/v1/admin/experiments", () => experimentsReport(db));
staffGet("/v1/admin/waitlist", () => waitlistReport(db));
staffGet("/v1/admin/business", () => businessReport(db));
staffGet("/v1/admin/retention", () => staffReports.retention());
// bipe#531: share of active iOS accounts with a way back that survives the App Store transfer.
staffGet("/v1/admin/transfer-readiness", (c) => {
  const days = z.coerce.number().int().min(1).max(90).default(30).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return staffReports.transferReadiness(days.data);
});
// Problem reports (bipe#367). The Starlings intake line links to the single report.
staffGet("/v1/admin/bug-reports", () => listBugReports(db));
staffGet("/v1/admin/bug-reports/:id", (c) => getBugReport(db, c.req.param("id")!));
app.get("/v1/admin/bug-reports/:id/files/:name", async (c) => {
  await staff.userId(c.req.header("authorization"));
  const name = c.req.param("name");
  const body = await readBugReportFile(db, config.BUG_REPORTS_DIR, c.req.param("id"), name);
  c.header("cache-control", "no-store");
  c.header("content-type", "application/octet-stream");
  c.header("x-content-type-options", "nosniff");
  c.header("content-disposition", `attachment; filename="${name}"`);
  return c.body(new Uint8Array(body));
});
// Strategic pages (ADR 0158): visitors by the email they typed, and their visits.
staffGet("/v1/admin/proposta", (c) => {
  const days = z.coerce.number().int().min(1).max(365).default(30).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return propostaReport(db, days.data);
});
staffGet("/v1/admin/reports", (c) => {
  const days = z.coerce.number().int().min(1).max(400).default(90).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return staffReports.reports(days.data);
});

// Business tools: Catálogo, Agenda, Fila virtual, Orçamento, Pedidos (ADRs 0099 to 0107).
app.route("/", businessRoutes({ db, auth, apiUrl: config.PUBLIC_API_URL, siteUrl: config.PUBLIC_SITE_URL, clientIp }));

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(`unhandled: ${err.name}: ${err.message}`);
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`bipe-api listening on ${info.port}`));
