import { randomBytes } from "node:crypto";
import type { Growth } from "./growth.js";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { type Mailer, mailBody } from "./mailer.js";
import type { Mas } from "./mas.js";
import { accountRules, appString, type Lang, problemWithPin } from "./registry.js";
import { newSecret, PinHasher, sameSecret, SECRET_PATTERN, secretHash } from "./secrets.js";

// Device-first accounts: ADR 0057 and ADR 0059 (bipe/docs/adr), security.md rules 5 and 6.
// - The hidden MAS password is made here, set through the MAS admin API and returned once. Never stored, never logged.
// - The recovery token is returned once; only its SHA-256 is stored.
// - The PIN is stored only as a peppered scrypt hash (secrets.ts). pinMaxWrongTries wrong PINs in total block it.
//   A correct PIN sets the count to 0. Every recovery path checks the PIN only after its other factor passed.
// - Recovery by email: link, then PIN (access) or a new PIN (reset), then the delay, then the claim.
//   Old devices see waiting recoveries in GET /v1/me/account and can cancel them.

export interface AccountDeps {
  db: Db;
  mas: Mas;
  config: Config;
  pins: PinHasher;
  mailer: Mailer;
  /** Growth events (ADR 0098). Absent in the admin CLI. */
  growth?: Growth;
}

type Queryable = Db | pg.PoolClient;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A completed access recovery can be claimed again for this long, in case the response got lost.
const RECLAIM_MS = HOUR_MS;
// Ended recoveries stay visible to the old devices for this long.
const SHOWN_MS = 7 * DAY_MS;

export type Purpose = "access" | "pin_reset";

export interface Credentials {
  user_id: string;
  password: string;
  recovery_token: string;
}

function localpartOf(config: Config, userId: string): string {
  const m = /^@([^:]+):(.+)$/.exec(userId);
  if (!m || m[2] !== config.SERVER_NAME) throw new ApiError("not_found");
  return m[1]!;
}

const newRecoveryId = () => randomBytes(16).toString("base64url");

function requireSecret(value: string): void {
  if (!SECRET_PATTERN.test(value)) throw new ApiError("recovery_invalid");
}

/** Throws pin_weak with the shared reason id when the PIN breaks the rule. */
export function checkPinRule(pin: string): void {
  const problem = problemWithPin(pin);
  if (problem) throw new ApiError("pin_weak", problem);
}

async function inTransaction<T>(db: Db, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- PIN ---------------------------------------------------------------------------------------------

/**
 * Checks the PIN and counts a wrong one. The row lock serialises parallel tries, so nobody gets more than
 * pinMaxWrongTries. The count is committed before the error goes out.
 */
export async function verifyPin({ db, pins }: AccountDeps, userId: string, pin: string): Promise<void> {
  // A PIN of the wrong shape cannot be right. It does not count.
  if (!new RegExp(`^[0-9]{${accountRules.pinLength}}$`).test(pin)) throw new ApiError("bad_request", "pin");
  const max = accountRules.pinMaxWrongTries;
  const outcome = await inTransaction(db, async (client) => {
    const { rows } = await client.query<{ pin_hash: string | null; pin_wrong_tries: number; pin_blocked_at: Date | null }>(
      "SELECT pin_hash, pin_wrong_tries, pin_blocked_at FROM account_secrets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const row = rows[0];
    if (!row?.pin_hash) return { kind: "unset" as const };
    if (row.pin_blocked_at) return { kind: "blocked" as const };
    if (await pins.verify(pin, row.pin_hash)) {
      if (row.pin_wrong_tries > 0) await client.query("UPDATE account_secrets SET pin_wrong_tries = 0 WHERE user_id = $1", [userId]);
      return { kind: "ok" as const };
    }
    const tries = row.pin_wrong_tries + 1;
    await client.query(
      `UPDATE account_secrets SET pin_wrong_tries = $2, pin_blocked_at = CASE WHEN $2 >= $3 THEN now() ELSE NULL END WHERE user_id = $1`,
      [userId, tries, max],
    );
    return tries >= max ? { kind: "blocked" as const } : { kind: "wrong" as const, left: max - tries };
  });
  if (outcome.kind === "unset") throw new ApiError("pin_not_set");
  if (outcome.kind === "blocked") throw new ApiError("pin_blocked");
  if (outcome.kind === "wrong") throw new ApiError("pin_wrong", undefined, { tries_left: outcome.left });
}

/** Signed-in device: set or change the PIN (biometric check on the device first, ADR 0057). */
export async function setPin(deps: AccountDeps, userId: string, pin: string): Promise<void> {
  checkPinRule(pin);
  const hash = await deps.pins.hash(pin);
  const hadPin = await inTransaction(deps.db, async (client) => {
    const { rows } = await client.query<{ pin_hash: string | null }>("SELECT pin_hash FROM account_secrets WHERE user_id = $1 FOR UPDATE", [userId]);
    await client.query(
      `INSERT INTO account_secrets (user_id, pin_hash, pin_set_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET pin_hash = $2, pin_set_at = now(), pin_wrong_tries = 0, pin_blocked_at = NULL`,
      [userId, hash],
    );
    // A PIN set on a signed-in device replaces any PIN reset that is still waiting.
    await client.query(
      `UPDATE recoveries SET state = 'cancelled', ended_at = now(), ended_by = 'pin_set'
       WHERE user_id = $1 AND state = 'waiting' AND purpose = 'pin_reset'`,
      [userId],
    );
    return Boolean(rows[0]?.pin_hash);
  });
  if (hadPin) await notify(deps, userId, "bipe_mail_notice_pin_changed");
}

// --- Credentials -------------------------------------------------------------------------------------

/**
 * New hidden password through the MAS admin API and a new recovery token, in one transaction. With `oldTokenHash`
 * the token must still be that one (it is used once). The password is returned once and never stored.
 */
export async function issueCredentials(
  { mas, config }: AccountDeps,
  client: pg.PoolClient,
  userId: string,
  oldTokenHash?: string,
): Promise<Credentials> {
  const token = newSecret();
  const res = await client.query(
    `INSERT INTO account_secrets (user_id, device_first, token_hash, token_set_at) VALUES ($1, true, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET device_first = true, token_hash = $2, token_set_at = now()
     WHERE $3::text IS NULL OR account_secrets.token_hash = $3`,
    [userId, secretHash(token), oldTokenHash ?? null],
  );
  if (res.rowCount !== 1) throw new ApiError("recovery_invalid");
  const masUser = await mas.userByUsername(localpartOf(config, userId));
  if (!masUser) throw new ApiError("not_found");
  const password = newSecret();
  if (!(await mas.setPassword(masUser.id, password))) {
    console.error("accounts: MAS refused a generated password");
    throw new ApiError("internal");
  }
  return { user_id: userId, password, recovery_token: token };
}

/** Beta account (own password) moves to a hidden password; also for an app that lost its stored password. */
export async function moveToDeviceFirst(deps: AccountDeps, userId: string): Promise<Credentials> {
  const { rows } = await deps.db.query("SELECT 1 FROM account_secrets WHERE user_id = $1 AND pin_hash IS NOT NULL", [userId]);
  if (rows.length === 0) throw new ApiError("pin_not_set");
  return inTransaction(deps.db, (client) => issueCredentials(deps, client, userId));
}

export async function rotateRecoveryToken({ db }: AccountDeps, userId: string): Promise<{ recovery_token: string }> {
  const token = newSecret();
  await db.query(
    `INSERT INTO account_secrets (user_id, token_hash, token_set_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET token_hash = $2, token_set_at = now()`,
    [userId, secretHash(token)],
  );
  return { recovery_token: token };
}

/** ADR 0059: synced token, then the PIN. No delay. The old token stops working. */
export async function redeemToken(deps: AccountDeps, token: string, pin: string): Promise<Credentials> {
  requireSecret(token);
  const hash = secretHash(token);
  const { rows } = await deps.db.query<{ user_id: string }>("SELECT user_id FROM account_secrets WHERE token_hash = $1", [hash]);
  const userId = rows[0]?.user_id;
  if (!userId) throw new ApiError("recovery_invalid");
  await verifyPin(deps, userId, pin);
  const creds = await inTransaction(deps.db, async (client) => {
    const issued = await issueCredentials(deps, client, userId, hash);
    await client.query(
      `INSERT INTO recoveries (id, user_id, method, purpose, state, started_at, ready_at, ended_at, ended_by)
       VALUES ($1, $2, 'token', 'access', 'completed', now(), now(), now(), 'claim')`,
      [newRecoveryId(), userId],
    );
    return issued;
  });
  await notify(deps, userId, "bipe_mail_notice_new_device");
  return creds;
}

// --- Account state -----------------------------------------------------------------------------------

interface RecoveryRow {
  id: string;
  method: string;
  purpose: Purpose;
  state: "waiting" | "completed" | "cancelled";
  created_at: Date;
  ready_at: Date | null;
  ended_at: Date | null;
}

function shownState(row: RecoveryRow, now: number): "waiting" | "completed" | "cancelled" | "expired" {
  if (row.state === "waiting" && row.ready_at && row.ready_at.getTime() + accountRules.recoveryClaimDays * DAY_MS < now) return "expired";
  return row.state;
}

export async function accountStatus({ db }: AccountDeps, userId: string) {
  const [secrets, emails, recoveries] = await Promise.all([
    db.query<{ device_first: boolean; pin_hash: string | null; pin_wrong_tries: number; pin_blocked_at: Date | null; token_hash: string | null }>(
      "SELECT device_first, pin_hash, pin_wrong_tries, pin_blocked_at, token_hash FROM account_secrets WHERE user_id = $1",
      [userId],
    ),
    db.query<{ email: string | null; pending_email: string | null; pending_expires_at: Date | null }>(
      "SELECT email, pending_email, pending_expires_at FROM recovery_emails WHERE user_id = $1",
      [userId],
    ),
    db.query<RecoveryRow>(
      `SELECT id, method, purpose, state, created_at, ready_at, ended_at FROM recoveries
       WHERE user_id = $1 AND state <> 'link_sent' AND (state = 'waiting' OR ended_at > now() - make_interval(secs => $2))
       ORDER BY created_at DESC LIMIT 20`,
      [userId, SHOWN_MS / 1000],
    ),
  ]);
  const s = secrets.rows[0];
  const e = emails.rows[0];
  const now = Date.now();
  const pending = e?.pending_email && e.pending_expires_at && e.pending_expires_at.getTime() > now ? e.pending_email : null;
  return {
    user_id: userId,
    pin_set: Boolean(s?.pin_hash),
    pin_blocked: Boolean(s?.pin_blocked_at),
    pin_tries_left: s?.pin_hash ? Math.max(0, accountRules.pinMaxWrongTries - s.pin_wrong_tries) : accountRules.pinMaxWrongTries,
    device_first: s?.device_first ?? false,
    recovery_token_set: Boolean(s?.token_hash),
    ...(e?.email ? { email: e.email } : {}),
    ...(pending ? { email_pending: pending } : {}),
    recoveries: recoveries.rows.map((r) => ({
      id: r.id,
      method: r.method,
      purpose: r.purpose,
      state: shownState(r, now),
      created_at: r.created_at.toISOString(),
      ...(r.ready_at ? { ready_at: r.ready_at.toISOString() } : {}),
      ...(r.ended_at ? { ended_at: r.ended_at.toISOString() } : {}),
    })),
  };
}

/** Any signed-in device of the account cancels a waiting recovery (ADR 0057). */
export async function cancelRecovery({ db }: AccountDeps, userId: string, recoveryId: string): Promise<void> {
  const res = await db.query(
    `UPDATE recoveries SET state = 'cancelled', ended_at = now(), ended_by = 'device'
     WHERE id = $1 AND user_id = $2 AND state = 'waiting'`,
    [recoveryId, userId],
  );
  if (res.rowCount !== 1) throw new ApiError("not_found");
}

// --- Recovery email (fallback) -----------------------------------------------------------------------

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** True when another account holds the address: a verified recovery email, or a beta login email in MAS. */
async function emailTaken({ db, mas, config }: AccountDeps, email: string, userId: string | null): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM recovery_emails WHERE email = $1 AND user_id IS DISTINCT FROM $2", [email, userId]);
  if (rows.length > 0) return true;
  const owner = await mas.emailOwner(email);
  if (!owner) return false;
  if (!userId) return true;
  const self = await mas.userByUsername(localpartOf(config, userId));
  return owner !== self?.id;
}

/** Stores the address as pending and sends the confirm link (when email is on). Used by sign-up and PUT /v1/me/email. */
export async function startEmailVerification(deps: AccountDeps, db: Queryable, userId: string, email: string, lang: Lang): Promise<() => void> {
  const token = newSecret();
  await db.query(
    `INSERT INTO recovery_emails (user_id, pending_email, pending_hash, pending_expires_at, lang)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)
     ON CONFLICT (user_id) DO UPDATE SET pending_email = $2, pending_hash = $3, pending_expires_at = now() + make_interval(hours => $4), lang = $5`,
    [userId, email, secretHash(token), accountRules.emailVerifyLinkHours, lang],
  );
  const link = `${deps.config.PUBLIC_SITE_URL.replace(/\/$/, "")}/confirmar-email/#${token}`;
  // The caller sends after its transaction commits.
  return () =>
    deps.mailer.sendLater(
      email,
      appString(lang, "bipe_mail_verify_subject"),
      mailBody(lang, appString(lang, "bipe_mail_verify_body", link, String(accountRules.emailVerifyLinkHours))),
      "verify link",
    );
}

export async function checkNewEmail(deps: AccountDeps, email: string, userId: string | null): Promise<void> {
  if (await emailTaken(deps, email, userId)) throw new ApiError("email_taken");
}

export async function setEmail(deps: AccountDeps, userId: string, raw: string, lang: Lang): Promise<void> {
  if (!deps.mailer.enabled) throw new ApiError("email_unavailable");
  const email = normalizeEmail(raw);
  const { rows } = await deps.db.query<{ email: string | null }>("SELECT email FROM recovery_emails WHERE user_id = $1", [userId]);
  if (rows[0]?.email === email) return;
  await checkNewEmail(deps, email, userId);
  const send = await startEmailVerification(deps, deps.db, userId, email, lang);
  send();
}

/** The token from the confirm link proves the inbox. The old verified address gets a notice. */
export async function verifyEmail(deps: AccountDeps, token: string): Promise<void> {
  requireSecret(token);
  let old: { email: string; lang: Lang } | null = null;
  try {
    old = await inTransaction(deps.db, async (client) => {
      const { rows } = await client.query<{ user_id: string; email: string | null; pending_email: string; lang: Lang }>(
        `SELECT user_id, email, pending_email, lang FROM recovery_emails
         WHERE pending_hash = $1 AND pending_expires_at > now() FOR UPDATE`,
        [secretHash(token)],
      );
      const row = rows[0];
      if (!row) throw new ApiError("recovery_invalid");
      await client.query(
        `UPDATE recovery_emails SET email = pending_email, verified_at = now(), pending_email = NULL, pending_hash = NULL, pending_expires_at = NULL
         WHERE user_id = $1`,
        [row.user_id],
      );
      return row.email && row.email !== row.pending_email ? { email: row.email, lang: row.lang } : null;
    });
  } catch (e) {
    // Another account confirmed the same address first.
    if ((e as { code?: string }).code === "23505") throw new ApiError("email_taken");
    throw e;
  }
  if (old) sendNotice(deps, old.email, old.lang, "bipe_mail_notice_email_removed");
}

export async function removeEmail(deps: AccountDeps, userId: string): Promise<void> {
  const { rows } = await deps.db.query<{ email: string | null; lang: Lang }>(
    "DELETE FROM recovery_emails WHERE user_id = $1 RETURNING email, lang",
    [userId],
  );
  const old = rows[0];
  if (old?.email) sendNotice(deps, old.email, old.lang, "bipe_mail_notice_email_removed");
}

// --- Recovery by email -------------------------------------------------------------------------------

/** Always quiet: the caller answers 202 whether or not the address is known. */
export async function requestRecoveryEmail(deps: AccountDeps, raw: string): Promise<void> {
  if (!deps.mailer.enabled) throw new ApiError("email_unavailable");
  const email = normalizeEmail(raw);
  const { rows } = await deps.db.query<{ user_id: string; lang: Lang }>(
    "SELECT user_id, lang FROM recovery_emails WHERE email = $1 AND verified_at IS NOT NULL",
    [email],
  );
  const row = rows[0];
  if (!row) return;
  const token = newSecret();
  // One open link per account: a new request replaces the old link.
  await deps.db.query("DELETE FROM recoveries WHERE user_id = $1 AND state = 'link_sent'", [row.user_id]);
  await deps.db.query(
    `INSERT INTO recoveries (id, user_id, method, state, link_hash, link_expires_at)
     VALUES ($1, $2, 'email', 'link_sent', $3, now() + make_interval(mins => $4))`,
    [newRecoveryId(), row.user_id, secretHash(token), accountRules.recoveryLinkMinutes],
  );
  const link = `${deps.config.PUBLIC_SITE_URL.replace(/\/$/, "")}/recuperar/#${token}`;
  const lang = row.lang;
  deps.mailer.sendLater(
    email,
    appString(lang, "bipe_mail_recovery_subject"),
    mailBody(lang, appString(lang, "bipe_mail_recovery_body", link, String(accountRules.recoveryLinkMinutes), String(accountRules.recoveryDelayHours.email))),
    "recovery link",
  );
}

/**
 * The email link first, then the PIN (access) or the new PIN (reset). Then the delay starts. The link works once.
 * Returns the claim secret once.
 */
export async function confirmRecoveryEmail(deps: AccountDeps, token: string, pin?: string, newPin?: string) {
  requireSecret(token);
  if ((pin === undefined) === (newPin === undefined)) throw new ApiError("bad_request", "pin");
  const linkHash = secretHash(token);
  const { rows } = await deps.db.query<{ id: string; user_id: string }>(
    "SELECT id, user_id FROM recoveries WHERE link_hash = $1 AND state = 'link_sent' AND link_expires_at > now()",
    [linkHash],
  );
  const found = rows[0];
  if (!found) throw new ApiError("recovery_invalid");

  let purpose: Purpose;
  let newPinHash: string | null = null;
  if (pin !== undefined) {
    purpose = "access";
    await verifyPin(deps, found.user_id, pin);
  } else {
    purpose = "pin_reset";
    checkPinRule(newPin!);
    newPinHash = await deps.pins.hash(newPin!);
  }

  const claim = newSecret();
  const delayHours = accountRules.recoveryDelayHours.email;
  const res = await deps.db.query<{ ready_at: Date }>(
    `UPDATE recoveries SET state = 'waiting', purpose = $2, claim_hash = $3, new_pin_hash = $4, link_hash = NULL,
       started_at = now(), ready_at = now() + make_interval(hours => $5)
     WHERE id = $1 AND state = 'link_sent' AND link_hash = $6
     RETURNING ready_at`,
    [found.id, purpose, secretHash(claim), newPinHash, delayHours, linkHash],
  );
  const readyAt = res.rows[0]?.ready_at;
  // A second request with the same link got here first.
  if (!readyAt) throw new ApiError("recovery_invalid");
  await notify(deps, found.user_id, purpose === "access" ? "bipe_mail_notice_recovery_started" : "bipe_mail_notice_pin_reset_started", readyAt);
  return { recovery_id: found.id, claim_secret: claim, purpose, ready_at: readyAt.toISOString() };
}

/** Poll, and collect when the delay has ended. The claim secret proves the new device. */
export async function claimRecovery(deps: AccountDeps, recoveryId: string, claimSecret: string) {
  requireSecret(claimSecret);
  return inTransaction(deps.db, async (client) => {
    const { rows } = await client.query<{
      user_id: string;
      purpose: Purpose;
      state: string;
      claim_hash: string | null;
      new_pin_hash: string | null;
      ready_at: Date | null;
      ended_at: Date | null;
    }>("SELECT user_id, purpose, state, claim_hash, new_pin_hash, ready_at, ended_at FROM recoveries WHERE id = $1 FOR UPDATE", [recoveryId]);
    const row = rows[0];
    if (!row?.claim_hash || !row.ready_at || !sameSecret(claimSecret, row.claim_hash)) throw new ApiError("recovery_invalid");
    const base = { purpose: row.purpose, ready_at: row.ready_at.toISOString() };
    const now = Date.now();

    if (row.state === "cancelled") return { state: "cancelled", ...base };
    if (row.state === "completed") {
      const reclaim = row.purpose === "access" && row.ended_at && now - row.ended_at.getTime() < RECLAIM_MS;
      if (!reclaim) return { state: "completed", ...base };
      return { state: "completed", ...base, ...(await issueCredentials(deps, client, row.user_id)) };
    }
    if (row.state !== "waiting") throw new ApiError("recovery_invalid");
    if (now < row.ready_at.getTime()) return { state: "waiting", ...base };
    if (now > row.ready_at.getTime() + accountRules.recoveryClaimDays * DAY_MS) return { state: "expired", ...base };

    await client.query("UPDATE recoveries SET state = 'completed', ended_at = now(), ended_by = 'claim' WHERE id = $1", [recoveryId]);
    if (row.purpose === "pin_reset") {
      await client.query(
        `INSERT INTO account_secrets (user_id, pin_hash, pin_set_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET pin_hash = $2, pin_set_at = now(), pin_wrong_tries = 0, pin_blocked_at = NULL`,
        [row.user_id, row.new_pin_hash],
      );
      return { state: "completed", ...base };
    }
    return { state: "completed", ...base, ...(await issueCredentials(deps, client, row.user_id)) };
  });
}

// --- Notices -----------------------------------------------------------------------------------------

function formatTime(date: Date, lang: Lang): string {
  const fmt = new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "numeric",
    month: lang === "en" ? "long" : "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${fmt.format(date)} (${lang === "en" ? "Brasília time" : "horário de Brasília"})`;
}

function sendNotice(deps: AccountDeps, email: string, lang: Lang, key: string, when?: Date): void {
  const text = when ? appString(lang, key, formatTime(when, lang)) : appString(lang, key);
  deps.mailer.sendLater(email, appString(lang, "bipe_mail_notice_subject"), mailBody(lang, text), "notice");
}

/** Security notice to the account's verified recovery email, when it has one. */
async function notify(deps: AccountDeps, userId: string, key: string, when?: Date): Promise<void> {
  if (!deps.mailer.enabled) return;
  const { rows } = await deps.db.query<{ email: string; lang: Lang }>(
    "SELECT email, lang FROM recovery_emails WHERE user_id = $1 AND email IS NOT NULL",
    [userId],
  );
  if (rows[0]) sendNotice(deps, rows[0].email, rows[0].lang, key, when);
}
