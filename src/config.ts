import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  SERVER_NAME: z.string().min(1),
  SYNAPSE_URL: z.url(),
  // MAS web listener (token endpoint) and admin API listener. Both internal only.
  MAS_URL: z.url(),
  MAS_ADMIN_URL: z.url(),
  MAS_CLIENT_ID: z.string().min(1),
  MAS_CLIENT_SECRET: z.string().min(16),
  // Beta: sign-up without an invite code (MZ, 11 October 2026). Anything but "false" requires one.
  SIGNUP_INVITE_REQUIRED: z.string().default("true").transform((v) => v !== "false"),
  // Global ceiling on sign-ups per hour, on top of the per-IP limit.
  // App Attest on sign-up (docs/adr). Anything but "false" requires a valid attestation.
  SIGNUP_ATTEST_REQUIRED: z.string().default("true").transform((v) => v !== "false"),
  // App IDs (TEAMID.bundleid) whose attestations are accepted, comma separated.
  APP_ATTEST_APP_IDS: z.string().default("992N457T8D.br.com.proseio.app.dev").transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  SIGNUP_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  // Personal invites each user may hold (pending plus used), before admin grants.
  INVITES_PER_USER: z.coerce.number().int().nonnegative().default(10),
  // A used invite gives its slot back this many days after the invitee joined.
  INVITE_RESPAWN_DAYS: z.coerce.number().int().positive().default(7),
  PUBLIC_SITE_URL: z.url().default("https://proseio.com.br"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Names only: never print values, some are secrets.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid environment: ${names}`);
  }
  return parsed.data;
}
