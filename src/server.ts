import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { MatrixAuth, StaffGate } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db.js";
import { ApiError } from "./errors.js";
import { availability, lookup, myHandle, resolve, setHandle } from "./handles.js";
import { createPersonalInvite, inviteConnections, inviterReport, myInvites, previewInvite, revokePersonalInvite } from "./invites.js";
import { Mas } from "./mas.js";
import { RateLimiter } from "./ratelimit.js";
import { newChallenge } from "./attest.js";
import { checkInternal, mayInvite, POLICIES, policyOf, setPolicy } from "./messaging.js";
import { signup } from "./signup.js";
import { getDiscovery, lookupContacts, LOOKUP_MAX_PER_REQUEST, myPhone, PhoneHasher, setDiscovery, unlinkPhone } from "./phones.js";
import { joinWaitlist, WaitlistBody } from "./waitlist.js";
import { countEvent, ExperimentEventBody } from "./experiments.js";
import { addDomain, checkDomain, createClaim, getClaim, proveWithEcnpj, runScan, withdrawClaim } from "./business.js";
import { loadIcpBrasilRoots } from "./ecnpj.js";
import { deletePhoto, myProfile, publicPhoto, publicProfile, saveProfile, setPhoto } from "./profiles.js";
import { profileRules } from "./registry.js";
import { accountStatus, cancelRecovery, claimRecovery, confirmRecoveryEmail, moveToDeviceFirst, redeemToken, removeEmail, requestRecoveryEmail, rotateRecoveryToken, setEmail, setPin, verifyEmail, verifyPin, type AccountDeps } from "./accounts.js";
import { Mailer } from "./mailer.js";
import { PinHasher, secretHash } from "./secrets.js";

const config = loadConfig();
const db = openDb(config.DATABASE_URL);
await migrate(db);
const mas = new Mas(config);
const auth = new MatrixAuth(config);
const staff = new StaffGate(auth, mas);
const phoneHasher = new PhoneHasher(config.PHONE_HMAC_SECRET);
const invitePolicy = { perUser: config.INVITES_PER_USER, respawnDays: config.INVITE_RESPAWN_DAYS };
const accounts: AccountDeps = { db, mas, config, pins: new PinHasher(config.BIPE_PIN_PEPPER), mailer: new Mailer(config) };
console.log(`pin pepper: ${config.BIPE_PIN_PEPPER ? "set" : "NOT SET (PIN routes answer internal)"}; outgoing email: ${accounts.mailer.enabled ? "on" : "off"}`);

const limits = {
  signup: new RateLimiter(5, 3_600_000),
  signupGlobal: new RateLimiter(config.SIGNUP_MAX_PER_HOUR, 3_600_000),
  availability: new RateLimiter(60, 60_000),
  lookup: new RateLimiter(30, 60_000),
  resolve: new RateLimiter(120, 60_000),
  setHandle: new RateLimiter(10, 3_600_000),
  invitePreview: new RateLimiter(30, 60_000),
  inviteCreate: new RateLimiter(20, 3_600_000),
  contactsLookup: new RateLimiter(30, 3_600_000),
  attestChallenge: new RateLimiter(20, 3_600_000),
  setMessaging: new RateLimiter(30, 3_600_000),
  waitlist: new RateLimiter(5, 3_600_000),
  waitlistGlobal: new RateLimiter(500, 3_600_000),
  events: new RateLimiter(30, 3_600_000),
  profile: new RateLimiter(60, 60_000),
  profilePhoto: new RateLimiter(120, 60_000),
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
};

// CNPJ verification (ADR 0042): pinned ICP-Brasil roots, and a registry scan for claims waiting on it.
const icpBrasilRoots = loadIcpBrasilRoots(config.ICP_BRASIL_ROOTS_DIR);
console.log(`icp-brasil roots: ${icpBrasilRoots.length}`);
const kickScan = () => void runScan(db, config, "pending").catch((e) => console.error(`cnpj scan failed: ${(e as Error).message}`));
setInterval(kickScan, 15 * 60_000).unref();
const CnpjBody = z.object({ cnpj: z.string().max(32) });
const EcnpjBody = z.object({ signature: z.string().min(1).max(131_072) });
const DomainBody = z.object({ domain: z.string().max(253) });

const Lang = z.enum(["pt", "en"]);
const PinField = z.string().max(64);
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
});
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
// Lengths are checked by problemWithProfile(); these caps only bound the request.
const ProfileBody = z.object({ enabled: z.boolean(), name: z.string().max(400), bio: z.string().max(2000) });
const PHOTO_PATH = "/v1/me/profile/photo";

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
const photoBody = bodyLimit({ maxSize: profileRules.photoMaxBytes, onError: (c) => c.json({ error: "photo_invalid", reason: "too_large" }, 413) });
app.use("*", (c, next) => {
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
  limits.signup.check(clientIp(c));
  limits.signupGlobal.check("all");
  const result = await signup(accounts, await parse(c, SignupBody));
  // Device-first: the body carries the hidden password and the recovery token, once.
  c.header("cache-control", "no-store");
  return c.json(result, 201);
});

// --- Device-first accounts (ADR 0057, ADR 0059) --------------------------------------------------------

app.get("/v1/me/account", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  return c.json(await accountStatus(accounts, userId));
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
  return c.json(await createPersonalInvite(db, userId, invitePolicy, config.PUBLIC_SITE_URL), 201);
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

// Called by the Synapse module before every invite. Caddy does not route /internal/*.
app.post("/internal/v1/may-invite", async (c) => {
  checkInternal(c.req.header("x-bipe-internal"), config.BIPE_INTERNAL_SECRET);
  const { inviter, invitee, shares_room } = await parse(c, MayInviteBody);
  return c.json(await mayInvite(db, inviter, invitee, shares_room));
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

app.get("/v1/handles/:handle", async (c) => {
  const userId = await auth.userId(c.req.header("authorization"));
  limits.lookup.check(userId);
  return c.json(await lookup(db, c.req.param("handle")));
});

// Public profiles (ADR 0041). The profile page on the public site reads them from the browser.
app.use("/v1/profiles/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"] }));

app.get("/v1/profiles/:handle", async (c) => {
  limits.profile.check(clientIp(c));
  const profile = await publicProfile(db, config.PUBLIC_API_URL, c.req.param("handle"));
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

// Staff report (ADR 0056) for the page bipe.chat/admin/convites/.
app.use("/v1/admin/*", cors({ origin: config.PUBLIC_SITE_URL.replace(/\/$/, ""), allowMethods: ["GET"], allowHeaders: ["authorization"] }));

app.get("/v1/admin/inviters", async (c) => {
  await staff.userId(c.req.header("authorization"));
  const limit = z.coerce.number().int().min(1).max(1000).default(200).safeParse(c.req.query("limit"));
  if (!limit.success) throw new ApiError("bad_request");
  const rows = await inviterReport(db, limit.data);
  return c.json({ inviters: rows.map((r) => ({ ...r, last_join: r.last_join?.toISOString() ?? null })) });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(`unhandled: ${err.name}: ${err.message}`);
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`bipe-api listening on ${info.port}`));
