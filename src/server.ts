import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MatrixAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db.js";
import { ApiError } from "./errors.js";
import { availability, lookup, myHandle, resolve, setHandle } from "./handles.js";
import { Mas } from "./mas.js";
import { RateLimiter } from "./ratelimit.js";
import { signup } from "./signup.js";

const config = loadConfig();
const db = openDb(config.DATABASE_URL);
await migrate(db);
const mas = new Mas(config);
const auth = new MatrixAuth(config);

const limits = {
  signup: new RateLimiter(5, 3_600_000),
  signupGlobal: new RateLimiter(config.SIGNUP_MAX_PER_HOUR, 3_600_000),
  availability: new RateLimiter(60, 60_000),
  lookup: new RateLimiter(30, 60_000),
  resolve: new RateLimiter(120, 60_000),
  setHandle: new RateLimiter(10, 3_600_000),
};

const SignupBody = z.object({
  invite_code: z.string().max(64).optional(),
  email: z.email().max(254),
  password: z.string().min(8).max(256),
  handle: z.string().max(64).optional(),
  display_name: z.string().max(100).optional(),
});
const HandleBody = z.object({ handle: z.string().max(64) });
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
app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "bad_request" }, 413) }));

app.get("/healthz", (c) => c.text("ok"));

app.post("/v1/signup", async (c) => {
  limits.signup.check(clientIp(c));
  limits.signupGlobal.check("all");
  return c.json(await signup(db, mas, config, await parse(c, SignupBody)), 201);
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

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(`unhandled: ${err.name}: ${err.message}`);
  return c.json({ error: "internal" }, 500);
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`proseio-api listening on ${info.port}`));
