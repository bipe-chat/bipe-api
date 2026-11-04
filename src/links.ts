import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type pg from "pg";
import { type AccountDeps, inTransaction, newRecoveryId, notify, verifyPin } from "./accounts.js";
import { pushToDevices } from "./device-push.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { linkedRecoveryRules } from "./registry.js";
import { newSecret, SECRET_PATTERN, secretHash } from "./secrets.js";

// A linked Apple or Google account as a recovery factor (ADR 0096, bipe/docs/adr; bipe#305).
// - Recovery only: a linked account never signs in alone and never resets the PIN. The PIN comes last (ADR 0059).
// - The API checks every ID token itself: signature against the provider's published keys, issuer, audience,
//   expiry and a nonce the API issued. It keeps only HMAC-SHA256(BIPE_PIN_PEPPER, issuer + "\n" + sub).
//   No email, no name, no provider token. The Apple code is never exchanged, so the API holds no Apple token.
// - Native path: Sign in with Apple on iOS sends the ID token with a nonce from /nonce. Web path (Google on both
//   platforms, Apple on Android): the API keeps the flow (state, nonce, PKCE verifier), the provider calls back,
//   and the app gets a single-use handoff on its own URL scheme. The handoff works only with the flow ID.
// - Fail closed: a provider without its configuration is not offered and its routes answer link_unavailable.
// Never log an ID token, a code, a nonce, a state, a handoff or a provider account ID.

export type Provider = "apple" | "google";
export type LinkPurpose = "link" | "recovery";
export const PROVIDERS: readonly Provider[] = ["apple", "google"];
export const APP_IDS = ["chat.bipe.app", "chat.bipe.app.next", "chat.bipe.app.next.debug"] as const;
export type AppId = (typeof APP_IDS)[number];

const ISSUERS: Record<Provider, string[]> = {
  apple: ["https://appleid.apple.com"],
  google: ["https://accounts.google.com", "accounts.google.com"],
};
const JWKS_URLS: Record<Provider, string> = {
  apple: "https://appleid.apple.com/auth/keys",
  google: "https://www.googleapis.com/oauth2/v3/certs",
};
const AUTHORIZE_URLS: Record<Provider, string> = {
  apple: "https://appleid.apple.com/auth/authorize",
  google: "https://accounts.google.com/o/oauth2/v2/auth",
};
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SKEW_S = 60;

export type LinkConfig = Pick<Config, "PUBLIC_API_URL" | "BIPE_PIN_PEPPER" | "APPLE_APP_IDS" | "APPLE_SERVICE_ID" | "GOOGLE_WEB_CLIENT_ID" | "GOOGLE_WEB_CLIENT_SECRET">;

/** Fetches a JSON document. Tests inject a stub; production uses fetch with a time limit. */
export type FetchJson = (url: string, init?: { method: "POST"; form: Record<string, string> }) => Promise<unknown>;

const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init ? { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } : { accept: "application/json" },
    body: init ? new URLSearchParams(init.form).toString() : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`links: ${new URL(url).host} answered ${res.status}`);
  return res.json();
};

export interface LinkDeps extends AccountDeps {
  links: Links;
}

interface VerifiedToken {
  issuer: string;
  subject: string;
  nonce: string;
}

/** The provider keys and the token checks. One instance per process: it caches the keys. */
export class Links {
  private readonly keys = new Map<Provider, { at: number; keys: JsonWebKey[] }>();

  constructor(
    readonly config: LinkConfig,
    private readonly fetcher: FetchJson = fetchJson,
    private readonly now: () => number = Date.now,
  ) {}

  /** Audiences of the platform's own sign-in (Sign in with Apple on iOS: the bundle IDs). */
  nativeAudiences(provider: Provider): string[] {
    return provider === "apple" ? this.config.APPLE_APP_IDS : [];
  }

  /** The web flow needs the client ID, and for Google the client secret for the code exchange. */
  webClientId(provider: Provider): string | undefined {
    if (provider === "apple") return this.config.APPLE_SERVICE_ID;
    return this.config.GOOGLE_WEB_CLIENT_ID && this.config.GOOGLE_WEB_CLIENT_SECRET ? this.config.GOOGLE_WEB_CLIENT_ID : undefined;
  }

  /** GET /v1/links/providers. Without the pepper nothing is offered: the subject hash needs it. */
  providers() {
    if (!this.config.BIPE_PIN_PEPPER) return { providers: [] };
    return {
      providers: PROVIDERS.map((provider) => ({ provider, native: this.nativeAudiences(provider).length > 0, web: Boolean(this.webClientId(provider)) }))
        .filter((p) => p.native || p.web),
    };
  }

  callbackUrl(provider: Provider): string {
    return `${this.config.PUBLIC_API_URL.replace(/\/$/, "")}/v1/links/callback/${provider}`;
  }

  /** HMAC-SHA256(pepper, issuer + "\n" + sub), hex. The issuer is normalised, so both Google spellings match. */
  subjectHash(provider: Provider, subject: string): string {
    const pepper = this.config.BIPE_PIN_PEPPER;
    if (!pepper) {
      console.error("links: BIPE_PIN_PEPPER is not set");
      throw new ApiError("internal");
    }
    return createHmac("sha256", Buffer.from(pepper, "hex")).update(`${ISSUERS[provider][0]}\n${subject}`, "utf8").digest("hex");
  }

  /** Checks an ID token. Throws recovery_invalid for anything wrong; never says which check failed. */
  async verifyIdToken(provider: Provider, token: string, audiences: string[]): Promise<VerifiedToken> {
    const invalid = () => new ApiError("recovery_invalid");
    if (audiences.length === 0) throw invalid();
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 8192) throw invalid();
    let header: { alg?: string; kid?: string };
    let claims: { iss?: unknown; aud?: unknown; azp?: unknown; sub?: unknown; exp?: unknown; iat?: unknown; nonce?: unknown };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch {
      throw invalid();
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid();
    const jwk = await this.key(provider, header.kid);
    if (!jwk) throw invalid();
    let ok = false;
    try {
      ok = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
    } catch {
      ok = false;
    }
    if (!ok) throw invalid();
    const nowS = this.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== "string" || !ISSUERS[provider].includes(claims.iss)) throw invalid();
    if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) throw invalid();
    // A token with several audiences must name Bipe as the party it was issued to.
    if (aud.length > 1 && !(typeof claims.azp === "string" && audiences.includes(claims.azp))) throw invalid();
    if (typeof claims.exp !== "number" || claims.exp < nowS - SKEW_S) throw invalid();
    if (typeof claims.iat !== "number" || claims.iat > nowS + SKEW_S || claims.iat < nowS - linkedRecoveryRules.flowMinutes * 60 - SKEW_S) throw invalid();
    if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw invalid();
    if (typeof claims.nonce !== "string" || claims.nonce.length === 0) throw invalid();
    return { issuer: claims.iss, subject: claims.sub, nonce: claims.nonce };
  }

  /** The provider's key for `kid`. Keys are cached for 6 hours; an unknown kid refetches at most once a minute. */
  private async key(provider: Provider, kid: string): Promise<JsonWebKey | undefined> {
    const cached = this.keys.get(provider);
    const find = (keys: JsonWebKey[]) => keys.find((k) => (k as { kid?: string }).kid === kid && k.kty === "RSA");
    const hit = cached && find(cached.keys);
    if (hit && this.now() - cached.at < 6 * 3_600_000) return hit;
    if (cached && this.now() - cached.at < 60_000) return hit;
    try {
      const doc = (await this.fetcher(JWKS_URLS[provider])) as { keys?: JsonWebKey[] };
      const keys = Array.isArray(doc?.keys) ? doc.keys : [];
      this.keys.set(provider, { at: this.now(), keys });
      return find(keys);
    } catch (e) {
      console.error(`links: ${provider} keys unavailable: ${(e as Error).message}`);
      return hit;
    }
  }

  /** Google: the code for an ID token, with the PKCE verifier and the client secret. */
  async exchangeGoogleCode(code: string, verifier: string): Promise<string> {
    const doc = (await this.fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: this.config.GOOGLE_WEB_CLIENT_ID ?? "",
        client_secret: this.config.GOOGLE_WEB_CLIENT_SECRET ?? "",
        redirect_uri: this.callbackUrl("google"),
      },
    })) as { id_token?: unknown };
    if (typeof doc?.id_token !== "string") throw new ApiError("recovery_invalid");
    return doc.id_token;
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const minutes = () => linkedRecoveryRules.flowMinutes;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function requireNative(links: Links, provider: Provider): void {
  if (links.nativeAudiences(provider).length === 0 || !links.config.BIPE_PIN_PEPPER) throw new ApiError("link_unavailable");
}

// --- Nonces and web flows -------------------------------------------------------------------------------

/** POST /v1/me/links/nonce (userId set) and POST /v1/recovery/link/nonce (userId null). Only the hash is kept. */
export async function newNonce({ db }: LinkDeps, purpose: LinkPurpose, userId: string | null): Promise<{ nonce: string; expires_at: string }> {
  const nonce = newSecret();
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO link_nonces (nonce_hash, purpose, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at`,
    [sha256(nonce), purpose, userId, minutes()],
  );
  return { nonce, expires_at: rows[0]!.expires_at.toISOString() };
}

/** POST /v1/me/links/{provider}/web and POST /v1/recovery/link/{provider}/web. */
export async function startWebFlow({ db, links }: LinkDeps, provider: Provider, purpose: LinkPurpose, userId: string | null, appId: AppId) {
  const clientId = links.webClientId(provider);
  if (!clientId || !links.config.BIPE_PIN_PEPPER) throw new ApiError("link_unavailable");
  const id = randomBytes(16).toString("base64url");
  const state = newSecret();
  const nonce = newSecret();
  const verifier = provider === "google" ? newSecret() : null;
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO link_flows (id, provider, purpose, user_id, app_id, state_hash, nonce_hash, verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9)) RETURNING expires_at`,
    [id, provider, purpose, userId, appId, sha256(state), sha256(nonce), verifier, minutes()],
  );
  const url = new URL(AUTHORIZE_URLS[provider]);
  const params: Record<string, string> = { client_id: clientId, redirect_uri: links.callbackUrl(provider), state, nonce };
  if (provider === "apple") {
    // No scope: Apple sends no name and no email. form_post carries the ID token to the API, never through the app.
    Object.assign(params, { response_type: "code id_token", response_mode: "form_post" });
  } else {
    const challenge = createHash("sha256").update(verifier!).digest("base64url");
    Object.assign(params, { response_type: "code", scope: "openid", code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" });
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { flow_id: id, url: url.toString(), expires_at: rows[0]!.expires_at.toISOString() };
}

interface FlowRow {
  id: string;
  provider: Provider;
  app_id: AppId;
  nonce_hash: string;
  verifier: string | null;
}

/**
 * The provider's callback. Returns where to send the browser: the app's link-done URL with the handoff in the
 * fragment, or with an error reason. `null` when the state matches no open flow (nothing to hand back).
 */
export async function finishWebFlow(
  { db, links }: LinkDeps,
  provider: Provider,
  input: { state?: string; code?: string; idToken?: string; error?: string },
): Promise<string | null> {
  if (!input.state || input.state.length > 128) return null;
  const { rows } = await db.query<FlowRow>(
    `UPDATE link_flows SET state_hash = NULL WHERE state_hash = $1 AND provider = $2 AND expires_at > now() AND done_at IS NULL
     RETURNING id, provider, app_id, nonce_hash, verifier`,
    [sha256(input.state), provider],
  );
  const flow = rows[0];
  if (!flow) return null;
  const back = (query: string, fragment?: string) => `${flow.app_id}:/link-done?flow=${encodeURIComponent(flow.id)}${query}${fragment ? `#${fragment}` : ""}`;
  if (input.error) return back(`&error=${input.error === "access_denied" || input.error === "user_cancelled_authorize" ? "cancelled" : "invalid"}`);
  try {
    let idToken = input.idToken;
    if (provider === "google") {
      if (!input.code || input.code.length > 2048 || !flow.verifier) throw new ApiError("recovery_invalid");
      idToken = await links.exchangeGoogleCode(input.code, flow.verifier);
    }
    if (!idToken) throw new ApiError("recovery_invalid");
    const token = await links.verifyIdToken(provider, idToken, [links.webClientId(provider)!]);
    if (sha256(token.nonce) !== flow.nonce_hash) throw new ApiError("recovery_invalid");
    const handoff = newSecret();
    await db.query(
      `UPDATE link_flows SET done_at = now(), subject_hash = $2, handoff_hash = $3, verifier = NULL WHERE id = $1`,
      [flow.id, links.subjectHash(provider, token.subject), sha256(handoff)],
    );
    return back("", handoff);
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(`links: ${provider} callback failed: ${(e as Error).message}`);
    return back("&error=invalid");
  }
}

export interface LinkProof {
  id_token?: string;
  flow_id?: string;
  handoff?: string;
}

/** The provider proof of a link or a recovery, as the subject hash. Each nonce, flow and handoff works once. */
async function proofSubject({ db, links }: LinkDeps, provider: Provider, purpose: LinkPurpose, userId: string | null, proof: LinkProof): Promise<string> {
  if (proof.id_token !== undefined && proof.flow_id === undefined && proof.handoff === undefined) {
    requireNative(links, provider);
    const token = await links.verifyIdToken(provider, proof.id_token, links.nativeAudiences(provider));
    const { rowCount } = await db.query(
      `DELETE FROM link_nonces WHERE nonce_hash = $1 AND purpose = $2 AND user_id IS NOT DISTINCT FROM $3 AND expires_at > now()`,
      [sha256(token.nonce), purpose, userId],
    );
    if (rowCount !== 1) throw new ApiError("recovery_invalid");
    return links.subjectHash(provider, token.subject);
  }
  if (proof.id_token === undefined && proof.flow_id && proof.handoff) {
    if (!SECRET_PATTERN.test(proof.handoff) || proof.flow_id.length > 64) throw new ApiError("recovery_invalid");
    const { rows } = await db.query<{ subject_hash: string }>(
      `UPDATE link_flows SET used_at = now()
       WHERE id = $1 AND handoff_hash = $2 AND provider = $3 AND purpose = $4 AND user_id IS NOT DISTINCT FROM $5
         AND done_at IS NOT NULL AND used_at IS NULL AND expires_at > now()
       RETURNING subject_hash`,
      [proof.flow_id, sha256(proof.handoff), provider, purpose, userId],
    );
    if (!rows[0]) throw new ApiError("recovery_invalid");
    return rows[0].subject_hash;
  }
  throw new ApiError("bad_request", "proof");
}

// --- Link and unlink --------------------------------------------------------------------------------------

async function recordEvent(client: Db | pg.PoolClient, userId: string, provider: Provider, change: "linked" | "unlinked"): Promise<void> {
  await client.query("INSERT INTO link_events (id, user_id, provider, change) VALUES ($1, $2, $3, $4)", [newRecoveryId(), userId, provider, change]);
}

/** PUT /v1/me/links/{provider}. One account per provider: a new link replaces the old one. */
export async function linkAccount(deps: LinkDeps, userId: string, provider: Provider, proof: LinkProof): Promise<void> {
  const subject = await proofSubject(deps, provider, "link", userId, proof);
  try {
    await inTransaction(deps.db, async (client) => {
      const { rows } = await client.query<{ user_id: string }>("SELECT user_id FROM account_links WHERE provider = $1 AND subject_hash = $2", [provider, subject]);
      if (rows[0] && rows[0].user_id !== userId) throw new ApiError("link_taken");
      if (rows[0]) return;
      await client.query(
        `INSERT INTO account_links (user_id, provider, subject_hash) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, provider) DO UPDATE SET subject_hash = $3, linked_at = now()`,
        [userId, provider, subject],
      );
      await recordEvent(client, userId, provider, "linked");
    });
  } catch (e) {
    // Two accounts linked the same provider account at once.
    if ((e as { code?: string }).code === "23505") throw new ApiError("link_taken");
    throw e;
  }
}

/** DELETE /v1/me/links/{provider}. */
export async function unlinkAccount({ db }: LinkDeps, userId: string, provider: Provider): Promise<void> {
  await inTransaction(db, async (client) => {
    const res = await client.query("DELETE FROM account_links WHERE user_id = $1 AND provider = $2", [userId, provider]);
    if (res.rowCount !== 1) throw new ApiError("not_found");
    await recordEvent(client, userId, provider, "unlinked");
  });
}

/** For GET /v1/me/account: the links (provider only) and the link events of the last 7 days. */
export async function linkState(db: Db, userId: string) {
  const [links, events] = await Promise.all([
    db.query<{ provider: Provider; linked_at: Date }>("SELECT provider, linked_at FROM account_links WHERE user_id = $1 ORDER BY provider", [userId]),
    db.query<{ id: string; provider: Provider; change: string; at: Date }>(
      `SELECT id, provider, change, at FROM link_events WHERE user_id = $1 AND at > now() - interval '7 days' ORDER BY at DESC LIMIT 20`,
      [userId],
    ),
  ]);
  return {
    links: links.rows.map((r) => ({ provider: r.provider, linked_at: r.linked_at.toISOString() })),
    link_events: events.rows.map((r) => ({ id: r.id, provider: r.provider, change: r.change, at: r.at.toISOString() })),
  };
}

// --- Recovery ---------------------------------------------------------------------------------------------

/**
 * POST /v1/recovery/link: the provider proof first, then the PIN, then the delay (ADR 0096). Access only: no new PIN.
 * Returns the claim secret once; the claim is POST /v1/recovery/{id}/claim, as for email.
 */
export async function recoverWithLink(deps: LinkDeps, provider: Provider, proof: LinkProof, pin: string) {
  const subject = await proofSubject(deps, provider, "recovery", null, proof);
  const { rows } = await deps.db.query<{ user_id: string }>("SELECT user_id FROM account_links WHERE provider = $1 AND subject_hash = $2", [provider, subject]);
  const userId = rows[0]?.user_id;
  if (!userId) throw new ApiError("recovery_invalid");
  await verifyPin(deps, userId, pin);
  const id = newRecoveryId();
  const claim = newSecret();
  const res = await deps.db.query<{ ready_at: Date }>(
    `INSERT INTO recoveries (id, user_id, method, purpose, state, claim_hash, started_at, ready_at)
     VALUES ($1, $2, $3, 'access', 'waiting', $4, now(), now() + make_interval(hours => $5)) RETURNING ready_at`,
    [id, userId, provider, secretHash(claim), linkedRecoveryRules.delayHours],
  );
  const readyAt = res.rows[0]!.ready_at;
  await notify(deps, userId, "bipe_mail_notice_recovery_started", readyAt);
  await pushToDevices(deps.push, userId, "recovery_started", null);
  return { recovery_id: id, claim_secret: claim, purpose: "access" as const, ready_at: readyAt.toISOString() };
}

/** Ended nonces and flows, and link events past their 7 days. */
export async function pruneLinks(db: Db): Promise<number> {
  const a = await db.query("DELETE FROM link_nonces WHERE expires_at < now() - interval '1 hour'");
  const b = await db.query("DELETE FROM link_flows WHERE expires_at < now() - interval '1 hour'");
  const c = await db.query("DELETE FROM link_events WHERE at < now() - interval '7 days'");
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}
