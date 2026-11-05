// External calendars of an agenda (ADR 0101, bipe#319; docs/scheduling.md levels A and B). Feed out: a secret URL per
// agenda; only the token's hash is stored. Busy in: a secret ICS address the owner pasted, read every 15 minutes; only
// start and end stay. The fetch refuses every private, loopback, link-local and metadata address, at connect time and
// after each redirect. Never log a token or an address.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { agendaRowExists } from "./agenda.js";
import type { Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { AgendaFeed, BusyImport } from "./generated/business-api.js";
import { parseBusy, writeFeed } from "./ics.js";

export const FeedBody = z.object({ include_customer_first_name: z.boolean().default(false) }).strict();
export const ImportBody = z.object({ url: z.string().url().max(2048).startsWith("https://") }).strict();

const FEED_SUMMARY = "Agendado";
const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const MAX_IMPORTS_PER_AGENDA = 5;
const FAILING_AFTER = 3;
const DAY_MS = 86_400_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// ---- Feed out --------------------------------------------------------------------------------------------------------

export async function issueFeed(db: Db, apiUrl: string, businessId: string, agendaId: string, body: z.infer<typeof FeedBody>): Promise<AgendaFeed> {
  await agendaRowExists(db, businessId, agendaId);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO agenda_feeds (agenda_id, business_id, token_hash, include_first_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agenda_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, include_first_name = EXCLUDED.include_first_name`,
    [agendaId, businessId, hash(token), body.include_customer_first_name],
  );
  return { url: `${apiUrl.replace(/\/$/, "")}/v1/agenda/feeds/${token}.ics`, include_customer_first_name: body.include_customer_first_name };
}

export async function revokeFeed(db: Db, businessId: string, agendaId: string): Promise<void> {
  await db.query("DELETE FROM agenda_feeds WHERE agenda_id = $1 AND business_id = $2", [agendaId, businessId]);
}

/** Invalid and revoked tokens answer the same not_found. */
export async function feedIcs(db: Queryable, token: string): Promise<string> {
  const { rows } = await db.query<{ agenda_id: string; include_first_name: boolean }>(
    "SELECT agenda_id, include_first_name FROM agenda_feeds WHERE token_hash = $1",
    [hash(token)],
  );
  const feed = rows[0];
  if (!feed) throw new ApiError("not_found");
  const { rows: bookings } = await db.query<{ id: string; start_at: Date; end_at: Date; status: string; customer_name: string | null }>(
    `SELECT id, start_at, end_at, status, customer_name FROM bookings
      WHERE agenda_id = $1 AND status IN ('requested', 'confirmed', 'done', 'cancelled') AND end_at > now() - interval '30 days'
      ORDER BY start_at LIMIT 2000`,
    [feed.agenda_id],
  );
  return writeFeed(bookings.map((b) => ({
    id: b.id,
    start: b.start_at,
    end: b.end_at,
    // Only a typed name exists here: a signed-in customer's name lives in Matrix, so the summary stays Agendado.
    summary: feed.include_first_name && b.customer_name ? (b.customer_name.trim().split(/\s+/)[0] ?? FEED_SUMMARY) : FEED_SUMMARY,
    cancelled: b.status === "cancelled",
  })));
}

// ---- Busy in ---------------------------------------------------------------------------------------------------------

/** True for an address no calendar fetch may reach. Fails closed: anything it cannot read counts as private. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version !== 6) return true;
  const text = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (text === "::" || text === "::1") return true;
  // A hextet form of an IPv4-mapped address, the discard prefix, documentation, NAT64, 6to4 and Teredo all fail closed.
  if (text.startsWith("::ffff:") || text.startsWith("64:ff9b") || text.startsWith("100:") || text.startsWith("2001:db8") || text.startsWith("2002:") || text.startsWith("2001:0:")) return true;
  const first = parseInt(text.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Checks every address at connect time, so a DNS answer cannot change between a check and the connection. */
function safeLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error("refused address"), { code: "EREFUSED" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

function fetchOnce(url: URL): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", lookup: safeLookup as never, headers: { accept: "text/calendar", "user-agent": "Bipe-Agenda/1" }, timeout: TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location, body: "" });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error("too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}

/** https only; a literal private address is refused before any connection; redirects are capped and checked again. */
export async function fetchCalendar(raw: string): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || (isIP(host) && isPrivateAddress(host))) throw new Error("refused url");
    const res = await fetchOnce(url);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new Error("bad redirect");
      url = new URL(res.location, url);
      continue;
    }
    if (res.status !== 200) throw new Error(`http ${res.status}`);
    return res.body;
  }
  throw new Error("too many redirects");
}

type ImportRow = { id: string; agenda_id: string; last_checked_at: Date | null; failures: number };

const importJson = (r: ImportRow): BusyImport => ({
  id: r.id,
  agenda_id: r.agenda_id,
  ...(r.last_checked_at ? { last_checked_at: r.last_checked_at.toISOString() } : {}),
  ...(r.failures >= FAILING_AFTER ? { failing: true } : {}),
});

export async function listImports(db: Queryable, businessId: string, agendaId: string) {
  await agendaRowExists(db, businessId, agendaId);
  const { rows } = await db.query<ImportRow>(
    "SELECT id, agenda_id, last_checked_at, failures FROM busy_imports WHERE business_id = $1 AND agenda_id = $2 ORDER BY created_at",
    [businessId, agendaId],
  );
  return { imports: rows.map(importJson) };
}

/** The same check as the worker's, when the owner saves: a refused or unreadable address answers bad_request. */
export async function addImport(db: Db, businessId: string, agendaId: string, body: z.infer<typeof ImportBody>, fetcher = fetchCalendar): Promise<BusyImport> {
  await agendaRowExists(db, businessId, agendaId);
  const { rows: count } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM busy_imports WHERE agenda_id = $1", [agendaId]);
  if (count[0]!.n >= MAX_IMPORTS_PER_AGENDA) throw new ApiError("bad_request", "too_many_imports");
  let text: string;
  try {
    text = await fetcher(body.url);
  } catch {
    throw new ApiError("bad_request", "url");
  }
  if (!text.includes("BEGIN:VCALENDAR")) throw new ApiError("bad_request", "url");
  const id = randomUUID();
  const { rows } = await db.query<ImportRow>(
    `INSERT INTO busy_imports (id, business_id, agenda_id, url) VALUES ($1, $2, $3, $4)
     RETURNING id, agenda_id, last_checked_at, failures`,
    [id, businessId, agendaId, body.url],
  );
  await storeBusy(db, id, agendaId, businessId, text);
  return importJson(rows[0]!);
}

export async function removeImport(db: Db, businessId: string, agendaId: string, importId: string): Promise<void> {
  await db.query("DELETE FROM busy_imports WHERE id = $1 AND business_id = $2 AND agenda_id = $3", [importId, businessId, agendaId]);
}

async function storeBusy(db: Db, importId: string, agendaId: string, businessId: string, text: string): Promise<void> {
  const { rows } = await db.query<{ time_zone: string; horizon_days: number }>("SELECT time_zone, horizon_days FROM agenda_settings WHERE business_id = $1", [businessId]);
  const settings = rows[0];
  if (!settings) return;
  const now = Date.now();
  const busy = parseBusy(text, { start: now - DAY_MS, end: now + (settings.horizon_days + 1) * DAY_MS }, settings.time_zone).slice(0, 5000);
  await db.query("DELETE FROM busy_blocks WHERE import_id = $1", [importId]);
  if (busy.length > 0) {
    await db.query(
      `INSERT INTO busy_blocks (import_id, agenda_id, start_at, end_at)
       SELECT $1, $2, s, e FROM unnest($3::timestamptz[], $4::timestamptz[]) AS t(s, e)`,
      [importId, agendaId, busy.map((b) => new Date(b.start)), busy.map((b) => new Date(b.end))],
    );
  }
  await db.query("UPDATE busy_imports SET last_checked_at = now(), failures = 0 WHERE id = $1", [importId]);
}

/** The job, every 15 minutes. A failing address keeps its last busy times and counts up; the agenda keeps working. */
export async function refreshBusyImports(db: Db, fetcher = fetchCalendar): Promise<void> {
  const { rows } = await db.query<{ id: string; agenda_id: string; business_id: string; url: string }>(
    "SELECT id, agenda_id, business_id, url FROM busy_imports ORDER BY last_checked_at NULLS FIRST LIMIT 500",
  );
  for (const row of rows) {
    try {
      const text = await fetcher(row.url);
      if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not a calendar");
      await storeBusy(db, row.id, row.agenda_id, row.business_id, text);
    } catch (e) {
      console.error(`busy import: read failed (${(e as Error).name})`);
      await db.query("UPDATE busy_imports SET failures = failures + 1 WHERE id = $1", [row.id]);
    }
  }
}
