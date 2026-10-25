import { z } from "zod";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { hashPassword, newSecret, SECRET_PATTERN, secretHash, verifyPassword } from "./secrets.js";
import type { Place } from "./weblink.js";

// Strategic pages at bipe.chat/proposta/ (ADR 0157, ADR 0158 in bipe/docs/adr): any email with one shared
// password, and a visit log by that email. The edge sends /proposta/_auth/* here and asks GET /v1/proposta/check
// before each page (Caddy forward_auth). Staff set the password with the CLI. The log keeps no IP and no user agent.

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

// With no password set, a sign-in still costs one scrypt, so the answer time does not tell that.
let decoy: Promise<string> | undefined;

/**
 * Checks the shared password, makes the visitor on the first sign-in with an email, and returns a new session
 * secret for the cookie. A wrong password and a missing password are the same 401.
 */
export async function login(db: Db, email: string, password: string): Promise<string> {
  const { rows } = await db.query<{ password_hash: string }>("SELECT password_hash FROM proposta_password WHERE id = 1");
  decoy ??= hashPassword(newSecret());
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? (await decoy));
  if (!rows[0] || !ok) throw new ApiError("unauthorized");
  const visitor = await db.query<{ id: number }>(
    `INSERT INTO proposta_visitors (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [normaliseEmail(email)],
  );
  const secret = newSecret();
  await db.query(
    "INSERT INTO proposta_sessions (token_hash, visitor_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [secretHash(secret), visitor.rows[0]!.id, SESSION_DAYS],
  );
  return secret;
}

export async function logout(db: Db, secret: string | undefined): Promise<void> {
  if (secret && SECRET_PATTERN.test(secret)) await db.query("DELETE FROM proposta_sessions WHERE token_hash = $1", [secretHash(secret)]);
}

/** The visitor of a live session, or null. */
export async function sessionVisitor(db: Db, secret: string | undefined): Promise<number | null> {
  if (!secret || !SECRET_PATTERN.test(secret)) return null;
  const { rows } = await db.query<{ visitor_id: number }>(
    "SELECT visitor_id FROM proposta_sessions WHERE token_hash = $1 AND expires_at > now()",
    [secretHash(secret)],
  );
  return rows[0]?.visitor_id ?? null;
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

export async function recordVisit(db: Db, visitorId: number, v: Visit): Promise<void> {
  await db.query(
    `INSERT INTO proposta_visits (visitor_id, kind, path, slide, referrer, utm, city, region, country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [visitorId, v.kind, v.path, v.slide ?? null, v.referrer ?? null, JSON.stringify(v.utm ?? {}), v.place.city ?? null, v.place.region ?? null, v.place.country ?? null],
  );
  await db.query("UPDATE proposta_visitors SET last_seen_at = now() WHERE id = $1", [visitorId]);
}

/** Visits past VISIT_KEEP_DAYS and ended sessions. */
export async function prunePropostaLog(db: Db): Promise<number> {
  const visits = await db.query("DELETE FROM proposta_visits WHERE at < now() - make_interval(days => $1)", [VISIT_KEEP_DAYS]);
  await db.query("DELETE FROM proposta_sessions WHERE expires_at < now()");
  return visits.rowCount ?? 0;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Staff report (GET /v1/admin/proposta, CLI proposta visits): named visitors, so no cell() (ADR 0158). */
export async function propostaReport(db: Db, days: number) {
  const visitors = await db.query<{ id: number; email: string; created_at: Date; last_seen_at: Date | null; page_views: number; max_slide: number | null }>(
    `SELECT p.id, p.email, p.created_at, p.last_seen_at,
            count(v.id) FILTER (WHERE v.kind = 'page')::int AS page_views, max(v.slide) AS max_slide
       FROM proposta_visitors p
       LEFT JOIN proposta_visits v ON v.visitor_id = p.id AND v.at > now() - make_interval(days => $1)
      GROUP BY p.id ORDER BY p.last_seen_at DESC NULLS LAST, p.id`,
    [days],
  );
  const visits = await db.query<{
    at: Date; visitor_id: number; kind: "page" | "slide"; path: string; slide: number | null; referrer: string | null;
    utm: Record<string, string>; city: string | null; region: string | null; country: string | null;
  }>(
    `SELECT at, visitor_id, kind, path, slide, referrer, utm, city, region, country
       FROM proposta_visits WHERE at > now() - make_interval(days => $1) ORDER BY at DESC LIMIT 1000`,
    [days],
  );
  return {
    days,
    visitors: visitors.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), last_seen_at: iso(r.last_seen_at) })),
    visits: visits.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
  };
}

/** CLI: sets the shared password (at least 10 characters) and ends every session. */
export async function setSharedPassword(db: Db, password: string): Promise<void> {
  if (password.length < 10 || password.length > 256) throw new Error("the password needs 10 to 256 characters");
  const hash = await hashPassword(password);
  await db.query(
    `INSERT INTO proposta_password (id, password_hash) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [hash],
  );
  await db.query("DELETE FROM proposta_sessions");
}

/** LGPD deletion request: the visitor, their sessions and their visits (ON DELETE CASCADE). */
export async function forgetVisitor(db: Db, email: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM proposta_visitors WHERE email = $1", [normaliseEmail(email)]);
  return (rowCount ?? 0) > 0;
}
