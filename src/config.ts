import { z } from "zod";

// Compose passes unset variables as "". Treat an empty value as unset.
const emptyAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v), schema.optional());

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
  // Clickwrap terms (ADR 0113). Anything but "false" refuses a sign-up without the current terms_version.
  // "false" only lets app builds from before ADR 0113 sign up; a given version is still checked and recorded.
  SIGNUP_TERMS_REQUIRED: z.string().default("true").transform((v) => v !== "false"),
  // App IDs (TEAMID.bundleid) whose attestations are accepted, comma separated.
  APP_ATTEST_APP_IDS: z.string().default("992N457T8D.chat.bipe.app.dev").transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  SIGNUP_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  // Personal invites each user may hold (pending plus used), before admin grants.
  INVITES_PER_USER: z.coerce.number().int().nonnegative().default(10),
  // A used invite gives its slot back this many days after the invitee joined.
  INVITE_RESPAWN_DAYS: z.coerce.number().int().positive().default(7),
  // Shared with the Synapse module bipe_messaging only. Guards /internal/*.
  BIPE_INTERNAL_SECRET: z.string().min(32),
  PUBLIC_SITE_URL: z.url().default("https://bipe.chat"),
  // CNPJ verification (ADR 0042): where Receita releases live on disk, and the public share they come from.
  RECEITA_DIR: z.string().default("/data/receita"),
  RECEITA_WEBDAV_URL: z.url().default("https://arquivos.receitafederal.gov.br/public.php/webdav"),
  RECEITA_SHARE_TOKEN: z.string().min(1).default("YggdBLfdninEJX9"),
  ICP_BRASIL_ROOTS_DIR: z.string().default("certs/icp-brasil"),
  // GeoIP city database for the web sign-in place (ADR 0118): DB-IP "IP to City Lite" in MMDB format.
  // Unset or missing file: GET /v1/web-link/place answers {}.
  GEOIP_CITY_DB: emptyAsUnset(z.string()),
  // Base of absolute URLs the API hands out (profile photos).
  PUBLIC_API_URL: z.url().default("https://api.bipe.net.br"),
  // HMAC key for stored phone numbers. Without it the phone endpoints answer "internal".
  PHONE_HMAC_SECRET: z.string().min(32).optional(),
  // Growth events (ADR 0098): HMAC key for the pseudonymous user ID. Without it no growth event is kept.
  BIPE_GROWTH_HMAC_SECRET: emptyAsUnset(z.string().min(32)),
  // Read-only role bipe_growth on the Synapse database (column grants only). Without it only API events are kept.
  SYNAPSE_DATABASE_URL: emptyAsUnset(z.string().min(1)),
  // Same role on the Umami database, for the staff visit report. Without it /v1/admin/visits answers "internal".
  UMAMI_DATABASE_URL: emptyAsUnset(z.string().min(1)),
  // The bipe.chat website in Umami. Public: the site sends it with each visit (bipe-web src/config.ts).
  UMAMI_WEBSITE_ID: z.uuid().default("4f1c2a6e-8b3d-4e57-9a0c-2d6b7e9f1a35"),
  // Device-first accounts (ADR 0057): secret key for the PIN hashes, 32 bytes as hex. Never in the database.
  // Without it the PIN routes answer "internal". A value that is not 64 hex characters stops the start.
  BIPE_PIN_PEPPER: emptyAsUnset(z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters")),
  // Outgoing email for recovery links and notices. Empty host: email is off. Port 465: implicit TLS.
  // Any other port: STARTTLS is required; the client never sends in plain text.
  BIPE_SMTP_HOST: emptyAsUnset(z.string()),
  BIPE_SMTP_PORT: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(65535).default(587)),
  BIPE_SMTP_USER: emptyAsUnset(z.string()),
  BIPE_SMTP_PASSWORD: emptyAsUnset(z.string()),
  // Inbox for partner requests from the site (bipe#177). Moves to a @bipe.chat address later (bipe#234).
  BIPE_PARTNERS_TO: z.email().default("contact@envisioning.com"),
  BIPE_MAIL_FROM: z.string().regex(/^[^\r\n<>]*<[^\s<>@]+@[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+$/, "an address, or a name and <address>").default("Bipe <nao-responda@bipe.chat>"),
});

export type Config = z.infer<typeof Env>;

const MailEnv = Env.pick({ PUBLIC_SITE_URL: true, BIPE_SMTP_HOST: true, BIPE_SMTP_PORT: true, BIPE_SMTP_USER: true, BIPE_SMTP_PASSWORD: true, BIPE_MAIL_FROM: true });
export type MailConfig = z.infer<typeof MailEnv>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Names only: never print values, some are secrets.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid environment: ${names}`);
  }
  return parsed.data;
}

/** The mail settings only, for the admin CLI (it does not need the MAS settings). */
export function loadMailConfig(): MailConfig {
  const parsed = MailEnv.safeParse(process.env);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
