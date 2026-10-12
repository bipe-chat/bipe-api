import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { MatrixAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db.js";
import { ApiError } from "./errors.js";
import { availability, lookup, myHandle, resolve, setHandle } from "./handles.js";
import { createPersonalInvite, inviteConnections, myInvites, previewInvite, revokePersonalInvite } from "./invites.js";
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

const config = loadConfig();
const db = openDb(config.DATABASE_URL);
await migrate(db);
const mas = new Mas(config);
const auth = new MatrixAuth(config);
const phoneHasher = new PhoneHasher(config.PHONE_HMAC_SECRET);
const invitePolicy = { perUser: config.INVITES_PER_USER, respawnDays: config.INVITE_RESPAWN_DAYS };

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
  eventsGlobal: new RateLimiter(20_000, 3_600_000),
  businessClaim: new RateLimiter(10, 3_600_000),
  businessProof: new RateLimiter(20, 3_600_000),
  businessDomain: new RateLimiter(30, 3_600_000),
};

// CNPJ verification (ADR 0042): pinned ICP-Brasil roots, and a registry scan for claims waiting on it.
const icpBrasilRoots = loadIcpBrasilRoots(config.ICP_BRASIL_ROOTS_DIR);
console.log(`icp-brasil roots: ${icpBrasilRoots.length}`);
const kickScan = () => void runScan(db, config, "pending").catch((e) => console.error(`cnpj scan failed: ${(e as Error).message}`));
setInterval(kickScan, 15 * 60_000).unref();
const CnpjBody = z.object({ cnpj: z.string().max(32) });
const EcnpjBody = z.object({ signature: z.string().min(1).max(131_072) });
const DomainBody = z.object({ domain: z.string().max(253) });

const SignupBody = z.object({
  // A code, an invite link or a whole pasted message: the server finds the code in it.
  invite_code: z.string().max(2048).optional(),
  email: z.email().max(254),
  password: z.string().min(8).max(256),
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
const LookupBody = z.object({ phones: z.array(z.string().max(64)).max(LOOKUP_MAX_PER_REQUEST) });
const DiscoveryBody = z.object({ by_phone: z.boolean() });
const ResolveBody = z.object({ user_ids: z.array(z.string().max(255)).max(100) });

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
// A CMS signature with its certificate chain can pass 16 KB; that one route gets more room.
const smallBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "bad_request" }, 413) });
const signatureBody = bodyLimit({ maxSize: 160 * 1024, onError: (c) => c.json({ error: "bad_request" }, 413) });
app.use("*", (c, next) => (c.req.path === "/v1/me/business/ecnpj" ? signatureBody(c, next) : smallBody(c, next)));

app.get("/healthz", (c) => c.text("ok"));

app.post("/v1/attest/challenge", (c) => {
  limits.attestChallenge.check(clientIp(c));
  return c.json({ challenge: newChallenge() });
});

app.post("/v1/signup", async (c) => {
  limits.signup.check(clientIp(c));
  limits.signupGlobal.check("all");
  return c.json(await signup(db, mas, config, await parse(c, SignupBody)), 201);
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
  checkInternal(c.req.header("x-proseio-internal"), config.PROSEIO_INTERNAL_SECRET);
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

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(`unhandled: ${err.name}: ${err.message}`);
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`proseio-api listening on ${info.port}`));
