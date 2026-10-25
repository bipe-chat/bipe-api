import { z } from "zod";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { hashPassword, newSecret, SECRET_PATTERN, secretHash, verifyPassword } from "./secrets.js";
import type { Place } from "./weblink.js";

// Strategic pages at bipe.chat/proposta/ (ADR 0157 in bipe/docs/adr): one sign-in per invitee and a visit log.
// The edge sends /proposta/_auth/* here and asks GET /v1/proposta/check before each page (Caddy forward_auth).
// Staff make the invitees and set their passwords with the CLI. The log keeps no IP and no user agent.

export const PROPOSTA_COOKIE = "bipe_proposta";
export const PROPOSTA_COOKIE_PATH = "/proposta";
export const SESSION_DAYS = 30;
export const VISIT_KEEP_DAYS = 365;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
// Shape of a path under /proposta/ with no query or fragment.
const PROPOSTA_PATH = /^\/proposta(\/[A-Za-z0-9._~\/-]*)?$/;

export const PropostaLoginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });
export const PropostaBeaconBody = z.object({
  path: z.string().max(200).regex(PROPOSTA_PATH),
  slide: z.number().int().min(1).max(200),
});

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

// A missing invitee still costs one scrypt, so the answer time does not tell whether the address is known.
let decoy: Promise<string> | undefined;

/** Checks email and password and returns a new session secret for the cookie. Every refusal is the same 401. */
export async function login(db: Db, email: string, password: string): Promise<string> {
  const { rows } = await db.query<{ id: number; password_hash: string }>(
    `SELECT id, password_hash FROM proposta_invitees
      WHERE email = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [normaliseEmail(email)],
  );
  const invitee = rows[0];
  decoy ??= hashPassword(newSecret());
  const ok = await verifyPassword(password, invitee?.password_hash ?? (await decoy));
  if (!invitee || !ok) throw new ApiError("unauthorized");
  const secret = newSecret();
  await db.query(
    "INSERT INTO proposta_sessions (token_hash, invitee_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [secretHash(secret), invitee.id, SESSION_DAYS],
  );
  return secret;
}

export async function logout(db: Db, secret: string | undefined): Promise<void> {
  if (secret && SECRET_PATTERN.test(secret)) await db.query("DELETE FROM proposta_sessions WHERE token_hash = $1", [secretHash(secret)]);
}

/** The invitee of a live session, or null. A revoked or expired invitee has no live session. */
export async function sessionInvitee(db: Db, secret: string | undefined): Promise<number | null> {
  if (!secret || !SECRET_PATTERN.test(secret)) return null;
  const { rows } = await db.query<{ invitee_id: number }>(
    `SELECT s.invitee_id FROM proposta_sessions s JOIN proposta_invitees i ON i.id = s.invitee_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
        AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now())`,
    [secretHash(secret)],
  );
  return rows[0]?.invitee_id ?? null;
}

export type PageView = { path: string; utm: Record<string, string> };

/** The page in X-Forwarded-Uri, or null for an asset (image, font) or a path outside /proposta/. */
export function pageOf(forwardedUri: string | undefined): PageView | null {
  if (!forwardedUri) return null;
  let url: URL;
  try {
    url = new URL(forwardedUri, "https://bipe.chat");
  } catch {
    return null;
  }
  const path = url.pathname;
  if (!PROPOSTA_PATH.test(path) || !(path.endsWith("/") || path.endsWith(".html") || path === "/proposta")) return null;
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = url.searchParams.get(k);
    if (v) utm[k] = v.slice(0, 100);
  }
  return { path, utm };
}

/** Scheme and host of the Referer, or null. Links between the strategic pages are not a referrer. */
export function referrerOrigin(referer: string | undefined, siteUrl: string): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin === new URL(siteUrl).origin ? null : u.origin.slice(0, 200);
  } catch {
    return null;
  }
}

type Visit = { kind: "page" | "slide"; path: string; slide?: number; referrer?: string | null; utm?: Record<string, string>; place: Place };

export async function recordVisit(db: Db, inviteeId: number, v: Visit): Promise<void> {
  await db.query(
    `INSERT INTO proposta_visits (invitee_id, kind, path, slide, referrer, utm, city, region, country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [inviteeId, v.kind, v.path, v.slide ?? null, v.referrer ?? null, JSON.stringify(v.utm ?? {}), v.place.city ?? null, v.place.region ?? null, v.place.country ?? null],
  );
  await db.query("UPDATE proposta_invitees SET last_seen_at = now() WHERE id = $1", [inviteeId]);
}

/** Visits past VISIT_KEEP_DAYS and ended sessions. */
export async function prunePropostaLog(db: Db): Promise<number> {
  const visits = await db.query("DELETE FROM proposta_visits WHERE at < now() - make_interval(days => $1)", [VISIT_KEEP_DAYS]);
  await db.query("DELETE FROM proposta_sessions WHERE expires_at < now()");
  return visits.rowCount ?? 0;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Staff report (GET /v1/admin/proposta, CLI proposta visits): named invitees, so no cell() (ADR 0157). */
export async function propostaReport(db: Db, days: number) {
  const invitees = await db.query<{
    id: number; email: string; label: string | null; created_at: Date; expires_at: Date | null; revoked_at: Date | null;
    last_seen_at: Date | null; page_views: number; max_slide: number | null;
  }>(
    `SELECT i.id, i.email, i.label, i.created_at, i.expires_at, i.revoked_at, i.last_seen_at,
            count(v.id) FILTER (WHERE v.kind = 'page')::int AS page_views, max(v.slide) AS max_slide
       FROM proposta_invitees i
       LEFT JOIN proposta_visits v ON v.invitee_id = i.id AND v.at > now() - make_interval(days => $1)
      GROUP BY i.id ORDER BY i.last_seen_at DESC NULLS LAST, i.id`,
    [days],
  );
  const visits = await db.query<{
    at: Date; invitee_id: number; kind: "page" | "slide"; path: string; slide: number | null; referrer: string | null;
    utm: Record<string, string>; city: string | null; region: string | null; country: string | null;
  }>(
    `SELECT at, invitee_id, kind, path, slide, referrer, utm, city, region, country
       FROM proposta_visits WHERE at > now() - make_interval(days => $1) ORDER BY at DESC LIMIT 1000`,
    [days],
  );
  return {
    days,
    invitees: invitees.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), expires_at: iso(r.expires_at), revoked_at: iso(r.revoked_at), last_seen_at: iso(r.last_seen_at) })),
    visits: visits.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
  };
}

// CLI (ADR 0157). Passwords are at least 10 characters; a generated one has 16 without l, 1, 0 and o.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export function newInviteePassword(): string {
  const bytes = Buffer.from(newSecret(), "base64url");
  return Array.from(bytes.subarray(0, 16), (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

function checkPassword(password: string): void {
  if (password.length < 10 || password.length > 256) throw new Error("the password needs 10 to 256 characters");
}

export async function addInvitee(db: Db, email: string, password: string, label: string | undefined, days: number | undefined): Promise<void> {
  checkPassword(password);
  const address = PropostaLoginBody.shape.email.parse(normaliseEmail(email));
  await db.query(
    `INSERT INTO proposta_invitees (email, label, password_hash, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)`,
    [address, label ?? null, await hashPassword(password), days ?? null],
  );
}

/** A new password also ends the invitee's sessions. Returns false for an unknown email. */
export async function setInviteePassword(db: Db, email: string, password: string): Promise<boolean> {
  checkPassword(password);
  const { rows } = await db.query<{ id: number }>("UPDATE proposta_invitees SET password_hash = $2 WHERE email = $1 RETURNING id", [normaliseEmail(email), await hashPassword(password)]);
  if (!rows[0]) return false;
  await db.query("DELETE FROM proposta_sessions WHERE invitee_id = $1", [rows[0].id]);
  return true;
}

export async function revokeInvitee(db: Db, email: string): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>("UPDATE proposta_invitees SET revoked_at = now() WHERE email = $1 AND revoked_at IS NULL RETURNING id", [normaliseEmail(email)]);
  if (!rows[0]) return false;
  await db.query("DELETE FROM proposta_sessions WHERE invitee_id = $1", [rows[0].id]);
  return true;
}

/** LGPD deletion request: the invitee, their sessions and their visits (ON DELETE CASCADE). */
export async function forgetInvitee(db: Db, email: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM proposta_invitees WHERE email = $1", [normaliseEmail(email)]);
  return (rowCount ?? 0) > 0;
}
