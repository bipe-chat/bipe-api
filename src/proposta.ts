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
export const PropostaBeaconBody = z
  .object({
    event: z.enum(["slide", "leave"]).default("slide"),
    path: z.string().max(200).regex(PROPOSTA_PATH),
    slide: z.number().int().min(1).max(200).optional(),
    title: z.string().trim().max(80).optional(),
  })
  .refine((b) => b.event === "leave" || b.slide !== undefined, { path: ["slide"] });

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

type Visit = {
  kind: "page" | "slide" | "leave"; path: string; slide?: number; title?: string; referrer?: string | null; utm?: Record<string, string>; place: Place;
};

export async function recordVisit(db: Db, visitorId: number, v: Visit): Promise<void> {
  await db.query(
    `INSERT INTO proposta_visits (visitor_id, kind, path, slide, title, referrer, utm, city, region, country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [visitorId, v.kind, v.path, v.slide ?? null, v.title || null, v.referrer ?? null, JSON.stringify(v.utm ?? {}), v.place.city ?? null, v.place.region ?? null, v.place.country ?? null],
  );
  await db.query("UPDATE proposta_visitors SET last_seen_at = now() WHERE id = $1", [visitorId]);
}

/** Visits past VISIT_KEEP_DAYS and ended sessions. */
export async function prunePropostaLog(db: Db): Promise<number> {
  const visits = await db.query("DELETE FROM proposta_visits WHERE at < now() - make_interval(days => $1)", [VISIT_KEEP_DAYS]);
  await db.query("DELETE FROM proposta_sessions WHERE expires_at < now()");
  await db.query("DELETE FROM proposta_summaries WHERE started_at < now() - make_interval(days => $1)", [VISIT_KEEP_DAYS]);
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
    at: Date; visitor_id: number; kind: "page" | "slide" | "leave"; path: string; slide: number | null; title: string | null; referrer: string | null;
    utm: Record<string, string>; city: string | null; region: string | null; country: string | null;
  }>(
    `SELECT at, visitor_id, kind, path, slide, title, referrer, utm, city, region, country
       FROM proposta_visits WHERE at > now() - make_interval(days => $1) ORDER BY at DESC LIMIT 1000`,
    [days],
  );
  return {
    days,
    visitors: visitors.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), last_seen_at: iso(r.last_seen_at) })),
    visits: visits.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    sittings: (await sittings(db, days)).map(sittingJson),
  };
}

// Sittings and time per step (ADR 0160).
const SITTING_GAP_MS = 30 * 60_000;
const STEP_CAP_MS = 10 * 60_000;
const SKIP_MS = 5_000;

export type Step = { at: Date; path: string; slide: number | null; title: string | null; ms: number };
export type Sitting = {
  visitorId: number; email: string; startedAt: Date; endedAt: Date; ms: number;
  place: string | null; referrer: string | null; utm: Record<string, string>; steps: Step[];
};
type Row = {
  visitor_id: number; email: string; at: Date; kind: "page" | "slide" | "leave"; path: string; slide: number | null; title: string | null;
  referrer: string | null; utm: Record<string, string>; city: string | null; region: string | null; country: string | null;
};

/** The sittings with an event in the last `days` days, newest first. */
export async function sittings(db: Db, days: number): Promise<Sitting[]> {
  const { rows } = await db.query<Row>(
    `SELECT v.visitor_id, p.email, v.at, v.kind, v.path, v.slide, v.title, v.referrer, v.utm, v.city, v.region, v.country
       FROM proposta_visits v JOIN proposta_visitors p ON p.id = v.visitor_id
      WHERE v.at > now() - make_interval(days => $1)
      ORDER BY v.visitor_id, v.at, v.id`,
    [days],
  );
  const out: Sitting[] = [];
  let group: Row[] = [];
  const flush = () => {
    if (group.length > 0) out.push(sittingOf(group));
    group = [];
  };
  for (const r of rows) {
    const last = group.at(-1);
    if (last && (last.visitor_id !== r.visitor_id || r.at.getTime() - last.at.getTime() >= SITTING_GAP_MS)) flush();
    group.push(r);
  }
  flush();
  return out.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}

function sittingOf(rows: Row[]): Sitting {
  const steps: Step[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "leave") return;
    const next = rows[i + 1];
    // The deck's page view and its first slide come together: the slide carries the time.
    if (r.kind === "page" && next?.kind === "slide" && next.path === r.path && next.at.getTime() - r.at.getTime() < SKIP_MS) return;
    const ms = next ? Math.min(next.at.getTime() - r.at.getTime(), STEP_CAP_MS) : 0;
    steps.push({ at: r.at, path: r.path, slide: r.slide, title: r.title, ms });
  });
  const first = rows.find((r) => r.kind === "page") ?? rows[0]!;
  const place = [first.city, first.region, first.country].filter(Boolean).join(", ") || null;
  return {
    visitorId: first.visitor_id, email: first.email, startedAt: rows[0]!.at, endedAt: rows.at(-1)!.at,
    ms: steps.reduce((t, s) => t + s.ms, 0), place, referrer: first.referrer, utm: first.utm ?? {}, steps,
  };
}

const secs = (ms: number) => Math.round(ms / 1000);
export const sittingJson = (s: Sitting) => ({
  visitor_id: s.visitorId, email: s.email, started_at: s.startedAt.toISOString(), ended_at: s.endedAt.toISOString(),
  seconds: secs(s.ms), place: s.place, referrer: s.referrer, utm: s.utm,
  steps: s.steps.map((t) => ({ at: t.at.toISOString(), path: t.path, slide: t.slide, title: t.title, seconds: secs(t.ms) })),
});

export const clock = (ms: number) => {
  const t = secs(ms);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const PAGE_NAMES: Record<string, string> = { "/proposta/deck/": "the deck", "/proposta/caso/": "the case", "/proposta/": "the overview" };
const pageName = (path: string) => PAGE_NAMES[path] ?? path;
const stepName = (t: Step) => (t.slide === null ? pageName(t.path) : `${t.title ?? "slide"} (${t.slide})`);

/** Plain-text summary for the operator mailbox. */
export function summaryMail(s: Sitting): { subject: string; text: string } {
  const pages = [...new Set(s.steps.map((t) => pageName(t.path)))];
  const minutes = Math.max(1, Math.round(s.ms / 60_000));
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const end = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const slides = s.steps.filter((t) => t.slide !== null);
  const lines = [
    `${s.email} read ${pages.join(" and ")}, ${minutes} min (${when.format(s.startedAt)} to ${end.format(s.endedAt)}, Brasília time).`,
    "",
    `Place: ${s.place ?? "unknown"}`,
    `From: ${s.referrer ?? "direct or unknown"}`,
  ];
  const tags = Object.entries(s.utm).map(([k, v]) => `${k}=${v}`).join(" ");
  if (tags) lines.push(`Link tags: ${tags}`);
  if (slides.length > 0) {
    lines.push(`Furthest slide: ${Math.max(...slides.map((t) => t.slide!))}`);
    const longest = [...slides].sort((a, b) => b.ms - a.ms).slice(0, 3).filter((t) => t.ms >= SKIP_MS);
    if (longest.length > 0) lines.push(`Longest: ${longest.map((t) => `${stepName(t)} ${clock(t.ms)}`).join(", ")}`);
    const skipped = slides.filter((t) => t.ms < SKIP_MS && t !== s.steps.at(-1)).map((t) => t.slide);
    if (skipped.length > 0) lines.push(`Under 5 s: slides ${[...new Set(skipped)].join(", ")}`);
  }
  lines.push("", "In order:");
  for (const t of s.steps) lines.push(`  ${clock(t.ms).padStart(5)}  ${stepName(t)}`);
  lines.push("", "The last step has no time unless the visitor closed or hid the tab. Full log: proposta sessions in the bipe-api CLI.");
  return { subject: `Proposta: ${s.email} read ${pages.join(" and ")}, ${minutes} min`, text: lines.join("\n") };
}

type SummaryMailer = { readonly enabled: boolean; send(to: string, subject: string, text: string): Promise<void> };

/**
 * Sends one summary per sitting that ended 30 minutes to 24 hours ago (ADR 0160). The row goes in first, so a
 * sitting gets at most one email; a failed send deletes the row, and the next run tries again within the 24 hours.
 */
export async function sendSummaries(db: Db, mailer: SummaryMailer, to: string | undefined): Promise<number> {
  if (!to || !mailer.enabled) return 0;
  const now = Date.now();
  let sent = 0;
  for (const s of await sittings(db, 2)) {
    const age = now - s.endedAt.getTime();
    if (age < SITTING_GAP_MS || age > 24 * 3_600_000 || s.steps.length === 0) continue;
    const claim = await db.query(
      `INSERT INTO proposta_summaries (visitor_id, started_at, ended_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [s.visitorId, s.startedAt, s.endedAt],
    );
    if (claim.rowCount === 0) continue;
    const mail = summaryMail(s);
    try {
      await mailer.send(to, mail.subject, mail.text);
      sent++;
    } catch (e) {
      await db.query("DELETE FROM proposta_summaries WHERE visitor_id = $1 AND started_at = $2", [s.visitorId, s.startedAt]);
      console.error(`strategic page summary not sent: ${(e as Error).message}`);
    }
  }
  return sent;
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
