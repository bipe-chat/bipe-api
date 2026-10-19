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
import { createPersonalInvite, inviteConnections, inviterReport, myInvites, previewInvite, revokePersonalInvite } from "./invites.js";
import { Mas } from "./mas.js";
import { RateLimiter } from "./ratelimit.js";
import { SignupLimits } from "./signup-limits.js";
import { newChallenge } from "./attest.js";
import { checkInternal, mayInvite, POLICIES, policyOf, setPolicy } from "./messaging.js";
import { forgetSignupReplay, pruneSignupReplays, replaySignup, signup } from "./signup.js";
import { checkTermsVersion, recordTerms } from "./terms.js";
import { getDiscovery, lookupContacts, LOOKUP_MAX_PER_REQUEST, myPhone, PhoneHasher, setDiscovery, unlinkPhone } from "./phones.js";
import { joinWaitlist, pruneWaitlist, WaitlistBody } from "./waitlist.js";
import { pruneOrganisationRequests } from "./organisations.js";
import { countEvent, ExperimentEventBody } from "./experiments.js";
import { addDomain, checkDomain, createClaim, getClaim, proveWithEcnpj, runScan, withdrawClaim } from "./business.js";
import { loadIcpBrasilRoots } from "./ecnpj.js";
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
import { businessReport, experimentsReport, StaffReports, waitlistReport } from "./staff-reports.js";
import { exportData } from "./export.js";
import { Badges } from "./badges.js";
import { BODY_MAX_BYTES, getBugReport, listBugReports, pruneBugReports, readBugReportFile, submitBugReport, type BugReportDeps } from "./bug-reports.js";
import { Intake, verifyIntakeSignature } from "./intake.js";
import { SupportBot } from "./support.js";
import { currentBanner } from "./banner.js";

const config = loadConfig();
const db = openDb(config.DATABASE_URL);
await migrate(db);
const mas = new Mas(config);
const auth = new MatrixAuth(config);
const staff = new StaffGate(auth, mas);
const phoneHasher = new PhoneHasher(config.PHONE_HMAC_SECRET);
const invitePolicy = { perUser: config.INVITES_PER_USER, respawnDays: config.INVITE_RESPAWN_DAYS };
const growth = new Growth(db, { secret: config.BIPE_GROWTH_HMAC_SECRET, synapseUrl: config.SYNAPSE_DATABASE_URL, serverName: config.SERVER_NAME, skipUsers: [config.SUPPORT_USER_ID] });
const accounts: AccountDeps = { db, mas, config, pins: new PinHasher(config.BIPE_PIN_PEPPER), mailer: new Mailer(config), growth };
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
console.log(`pin pepper: ${config.BIPE_PIN_PEPPER ? "set" : "NOT SET (PIN routes answer internal)"}; outgoing email: ${accounts.mailer.enabled ? "on" : "off"}`);

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
  emailVerify: new RateLimiter(20, 3_600_000),
  recoveryToken: new RateLimiter(10, 3_600_000),
  recoveryTokenGlobal: new RateLimiter(300, 3_600_000),
  recoveryEmail: new RateLimiter(5, 3_600_000),
  recoveryEmailAddress: new RateLimiter(3, 3_600_000),
  recoveryConfirm: new RateLimiter(10, 3_600_000),
  recoveryClaim: new RateLimiter(120, 3_600_000),
  // Web sign-in approval (ADR 0118).
  webLinkFinish: new RateLimiter(20, 3_600_000),
  webLinkPlace: new RateLimiter(60, 3_600_000),
  // Problem reports (bipe#367).
  bugReport: new RateLimiter(10, 3_600_000),
  bugReportGlobal: new RateLimiter(500, 3_600_000),
  // Support DM (ADR 0114).
  supportRoom: new RateLimiter(30, 3_600_000),
  starlingsReply: new RateLimiter(600, 3_600_000),
  banner: new RateLimiter(120, 60_000),
};

// CNPJ verification (ADR 0042): pinned ICP-Brasil roots, and a registry scan for claims waiting on it.
const icpBrasilRoots = loadIcpBrasilRoots(config.ICP_BRASIL_ROOTS_DIR);
console.log(`icp-brasil roots: ${icpBrasilRoots.length}`);
const kickScan = () => void runScan(db, config, "pending").catch((e) => console.error(`cnpj scan failed: ${(e as Error).message}`));
setInterval(kickScan, 15 * 60_000).unref();

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
const pruneOrganisations = () =>
  void pruneOrganisationRequests(db)
    .then((n) => n > 0 && console.log(`organisation requests pruned: ${n}`))
    .catch((e) => console.error(`organisation request prune failed: ${(e as Error).message}`));
pruneOrganisations();
setInterval(pruneOrganisations, 24 * 3_600_000).unref();
const pruneWaitlistEntries = () =>
  void pruneWaitlist(db)
    .then((n) => n > 0 && console.log(`waitlist entries pruned: ${n}`))
    .catch((e) => console.error(`waitlist prune failed: ${(e as Error).message}`));
pruneWaitlistEntries();
setInterval(pruneWaitlistEntries, 24 * 3_600_000).unref();
support.start();
const pruneReports = () =>
  void pruneBugReports(db, config.BUG_REPORTS_DIR)
    .then((n) => n > 0 && console.log(`problem reports pruned: ${n}`))
    .catch((e) => console.error(`problem report prune failed: ${(e as Error).message}`));
pruneReports();
setInterval(pruneReports, 24 * 3_600_000).unref();
// Retries for Starlings intake lines that failed. A new line is sent at once.
setInterval(() => void intake.flush(), 60_000).unref();
void intake.flush();
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
  attestation: z
    .object({
      key_id: z.string().min(1).max(128),
      attestation_object: z.string().min(1).max(16_384),
      challenge: z.string().min(1).max(128),
    })
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
const LookupBody = z.object({ phones: z.array(z.string().max(64)).max(LOOKUP_MAX_PER_REQUEST) });
const DiscoveryBody = z.object({ by_phone: z.boolean() });
const ResolveBody = z.object({ user_ids: z.array(z.string().max(255)).max(100) });
const HandleChangesBody = z.object({ user_ids: z.array(z.string().max(255)).max(100), since: z.iso.datetime({ offset: true }).optional() });
// Lengths are checked by problemWithProfile(); these caps only bound the request.
const ProfileBody = z.object({ enabled: z.boolean(), name: z.string().max(400), bio: z.string().max(2000) });
const PHOTO_PATH = "/v1/me/profile/photo";
const BUG_REPORT_PATH = "/v1/bug-reports/submit";

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
const photoBody = bodyLimit({ maxSize: profileRules.photoMaxBytes, onError: (c) => c.json({ error: "photo_invalid", reason: "too_large" }, 413) });
app.use("*", (c, next) => {
  if (c.req.path === BUG_REPORT_PATH) return reportBody(c, next);
  if (c.req.path === "/v1/me/business/ecnpj") return signatureBody(c, next);
  if (c.req.path === PHOTO_PATH) return photoBody(c, next);
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
  const userId = await auth.userId(c.req.header("authorization"));
  // The app signed in, so it has its credentials: the sealed sign-up copy (ADR 0094) can go.
  await forgetSignupReplay(db, userId);
  growth.onboarded(userId);
  return c.json(await accountStatus(accounts, userId, config.MAX_PERSONAL_ACCOUNTS));
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
  if (inviter === config.SUPPORT_USER_ID) return c.json({ allow: true, policy: await policyOf(db, invitee) });
  return c.json(await mayInvite(db, inviter, invitee, shares_room));
});

// Support DM (ADR 0114): the caller's room with the support account.
app.post("/v1/me/support", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.supportRoom.check(userId);
  return c.json({ room_id: await support.roomFor(userId) });
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
staffGet("/v1/admin/reports", (c) => {
  const days = z.coerce.number().int().min(1).max(400).default(90).safeParse(c.req.query("days"));
  if (!days.success) throw new ApiError("bad_request");
  return staffReports.reports(days.data);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(`unhandled: ${err.name}: ${err.message}`);
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`bipe-api listening on ${info.port}`));
