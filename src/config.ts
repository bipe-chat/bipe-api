import { z } from "zod";

// Compose passes unset variables as "". Treat an empty value as unset.
const emptyAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v), schema.optional());

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const ANDROID_PACKAGES_DEFAULT = "chat.bipe.app,chat.bipe.app.next,chat.bipe.app.next.debug";

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
  // Explicit per-deployment policy (ADR 0127). No implicit development App ID or mixed environment.
  APP_ATTEST_ENVIRONMENT: z.enum(["production", "development"]),
  APP_ATTEST_APP_IDS: z.string().transform((v) => v.split(",").map((s) => s.trim())).pipe(
    z.array(z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, "TEAMID.bundleid")).min(1),
  ),
  // Android Key Attestation (bipe#92, ADR 0043). Package names of the Bipe app: the store ID and the Bipe Next tester IDs.
  // Empty (Compose) means the default.
  ANDROID_ATTEST_PACKAGES: z.string().optional().transform((v) => list(v?.trim() ? v : ANDROID_PACKAGES_DEFAULT)).pipe(
    z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, "package name")).min(1),
  ),
  // Lower-case hex SHA-256 of the app signing certificates. Empty: not checked (the CI debug key changes every run).
  ANDROID_ATTEST_CERT_DIGESTS: z.string().default("").transform((v) => list(v.toLowerCase())).pipe(z.array(z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex"))),
  // Lower-case hex verified boot keys of custom operating systems that count as attested (GrapheneOS, ADR 0043).
  ANDROID_ATTEST_BOOT_KEYS: z.string().default("").transform((v) => list(v.toLowerCase())).pipe(z.array(z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex"))),
  SIGNUP_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  // Personal invites each user may hold (pending plus used), before admin grants.
  INVITES_PER_USER: z.coerce.number().int().nonnegative().default(10),
  // ADR 0086: personal accounts one phone may hold (max_accounts in GET /v1/me/account). Default: the shared registry.
  MAX_PERSONAL_ACCOUNTS: z.coerce.number().int().positive().optional(),
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
  // gov.br signed challenge (bipe#543): AC Raiz do Governo Federal do Brasil v1 and its intermediates. Not ICP-Brasil.
  // Without them the gov.br routes answer "internal" with reason govbr_roots_missing.
  GOVBR_ROOTS_DIR: z.string().default("certs/govbr"),
  // HMAC key for the CPF hash of a verified person (one CPF, one account). Without it the gov.br routes answer "internal".
  // Never rotate it: every stored hash stops matching.
  BIPE_CPF_HMAC_SECRET: emptyAsUnset(z.string().min(32)),
  // GeoIP city database for the web sign-in place (ADR 0118): DB-IP "IP to City Lite" in MMDB format.
  // Unset or missing file: GET /v1/web-link/place answers {}.
  GEOIP_CITY_DB: emptyAsUnset(z.string()),
  // Badge signing key (ADR 0123): a directory with key.pem and kid, mounted from Secret bipe-badge-key.
  // Unset or no files: GET /v1/badges answers 404 for everyone.
  BIPE_BADGE_KEY_DIR: emptyAsUnset(z.string()),
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
  // Linked Apple or Google account for recovery (ADR 0096). Client IDs are not secrets; the Google client secret is.
  // Every value is optional: a provider without its values is not offered (GET /v1/links/providers) and its routes
  // answer link_unavailable. APPLE_APP_IDS: bundle IDs that may send a Sign in with Apple ID token from the app.
  // APPLE_SERVICE_ID: the Services ID of the Apple web flow (Android). GOOGLE_WEB_CLIENT_ID and _SECRET: the
  // Google "Web application" OAuth client of the web flow (both platforms). Its redirect URI is
  // PUBLIC_API_URL/v1/links/callback/google; Apple's return URL is PUBLIC_API_URL/v1/links/callback/apple.
  APPLE_APP_IDS: z.string().default("").transform(list).pipe(z.array(z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, "bundle ID"))),
  APPLE_SERVICE_ID: emptyAsUnset(z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, "Services ID")),
  GOOGLE_WEB_CLIENT_ID: emptyAsUnset(z.string().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, "Google client ID")),
  GOOGLE_WEB_CLIENT_SECRET: emptyAsUnset(z.string().min(16)),
  // Outgoing email for recovery links and notices. Empty host: email is off. Port 465: implicit TLS.
  // Any other port: STARTTLS is required; the client never sends in plain text.
  BIPE_SMTP_HOST: emptyAsUnset(z.string()),
  BIPE_SMTP_PORT: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(65535).default(587)),
  BIPE_SMTP_USER: emptyAsUnset(z.string()),
  BIPE_SMTP_PASSWORD: emptyAsUnset(z.string()),
  // Strategic pages (bipe ADR 0160): one summary email per sitting goes to this operator mailbox. Empty: off.
  PROPOSTA_NOTIFY_EMAIL: emptyAsUnset(z.email()),
  // Problem reports (bipe#367): files on disk, 90 days. Starlings app intake: text and metadata only.
  // Without STARLINGS_APP_INTAKE_KEY reports are stored but not relayed.
  BUG_REPORTS_DIR: z.string().default("/data/bug-reports"),
  STARLINGS_INTAKE_URL: z.url().default("https://bipe.starlings.work/api/support/app-intake"),
  STARLINGS_APP_INTAKE_KEY: emptyAsUnset(z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters")),
  // Support DM (ADR 0114, ADR 0115). The bot is off without the token and the store passphrase.
  SUPPORT_USER_ID: z.string().regex(/^@[a-z0-9._=\/-]+:[a-z0-9.-]+$/).optional(),
  SUPPORT_ACCESS_TOKEN: emptyAsUnset(z.string().min(16)),
  SUPPORT_STORE_DIR: z.string().default("/data/support-crypto"),
  SUPPORT_STORE_PASSPHRASE: emptyAsUnset(z.string().min(32)),
  // Novidades do Bipe (ADR 0117, ADR 0119). Its own account, device and key store; off without the token and the passphrase.
  NEWS_USER_ID: z.string().regex(/^@[a-z0-9._=\/-]+:[a-z0-9.-]+$/).optional(),
  NEWS_ACCESS_TOKEN: emptyAsUnset(z.string().min(16)),
  NEWS_STORE_DIR: z.string().default("/data/news-crypto"),
  NEWS_STORE_PASSPHRASE: emptyAsUnset(z.string().min(32)),
  NEWS_SEND_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(60),
  // CVM register check (ADR 0077): the daily download from dados.cvm.gov.br. "false" turns it off (no CVM lines).
  CVM_REFRESH: z.string().default("true").transform((v) => v !== "false"),
  BIPE_MAIL_FROM: z.string().regex(/^[^\r\n<>]*<[^\s<>@]+@[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+$/, "an address, or a name and <address>").default("Bipe <nao-responda@bipe.chat>"),
});

export type Config = Omit<z.infer<typeof Env>, "SUPPORT_USER_ID" | "NEWS_USER_ID"> & { SUPPORT_USER_ID: string; NEWS_USER_ID: string };

const MailEnv = Env.pick({ PUBLIC_SITE_URL: true, BIPE_SMTP_HOST: true, BIPE_SMTP_PORT: true, BIPE_SMTP_USER: true, BIPE_SMTP_PASSWORD: true, BIPE_MAIL_FROM: true });
export type MailConfig = z.infer<typeof MailEnv>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Names only: never print values, some are secrets.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`invalid environment: ${names}`);
  }
  if (env.NODE_ENV === "production" && parsed.data.APP_ATTEST_ENVIRONMENT !== "production") {
    throw new Error("invalid environment: APP_ATTEST_ENVIRONMENT");
  }
  return {
    ...parsed.data,
    SUPPORT_USER_ID: parsed.data.SUPPORT_USER_ID ?? `@suporte:${parsed.data.SERVER_NAME}`,
    NEWS_USER_ID: parsed.data.NEWS_USER_ID ?? `@bipe:${parsed.data.SERVER_NAME}`,
  };
}

/** The mail settings only, for the admin CLI (it does not need the MAS settings). */
export function loadMailConfig(): MailConfig {
  const parsed = MailEnv.safeParse(process.env);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}
