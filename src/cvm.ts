// CVM register check for the CNPJ badge (ADR 0077, bipe#237). Once a day the API downloads CVM's open register of the
// service providers that may offer or intermediate investments, and the stop-order file, and keeps one table of
// CNPJ to registrations plus the stop orders. The badge signer reads it at issue and renewal, so the apps never call
// CVM or the API per message. No scraping, no message content. Data: CVM, dados.cvm.gov.br (ODbL; attribution in
// the apps). File shapes come from ADR 0077 (checked 13 October 2026); a changed shape fails the refresh, keeps the
// last good table and logs it. A table older than 7 days gives no CVM line.
import { inflateRawSync } from "node:zlib";
import type { Db } from "./db.js";

const BASE = "https://dados.cvm.gov.br/dados";
const UA = "Mozilla/5.0 (compatible; bipe-api; +https://bipe.chat)";
export const CVM_MAX_AGE_MS = 7 * 86_400_000;

/** One provider register (ADR 0077 table). `label`: the category when the file has no category column. */
export type CvmSource = { id: string; path: string; entry?: RegExp; categoryColumn?: string; label?: string };

export const CVM_SOURCES: CvmSource[] = [
  { id: "intermed", path: "INTERMED/CAD/DADOS/cad_intermed.zip", categoryColumn: "TP_PARTIC" },
  { id: "adm_cart", path: "ADM_CART/CAD/DADOS/cad_adm_cart.zip", entry: /_pj\.csv$/i, categoryColumn: "CATEG_REG" },
  { id: "consultor", path: "CONSULTOR_VLMOB/CAD/DADOS/cad_consultor_vlmob.zip", entry: /_pj\.csv$/i, label: "consultora de valores mobiliários" },
  { id: "agente_auton", path: "AGENTE_AUTON/CAD/DADOS/cad_agente_auton.zip", entry: /_pj\.csv$/i, label: "assessora de investimento" },
  { id: "crowdfunding", path: "CROWDFUNDING/CAD/DADOS/cad_crowdfunding.zip", label: "plataforma de investimento participativo" },
  { id: "coord_oferta", path: "COORD_OFERTA/CAD/DADOS/cad_coord_oferta.zip", label: "coordenadora de ofertas" },
  { id: "adm_fii", path: "ADM_FII/CAD/DADOS/cad_adm_fii.csv", label: "administradora de fundos imobiliários" },
];
export const CVM_STOP_ORDERS = "ATO_DECLR/INTERMED/DADOS/ato_declr.csv";

export type CvmRegistration = { cnpj: string; source: string; category: string; status: "active" | "cancelled" | "other"; registeredOn: string | null; cancelledOn: string | null };
export type CvmStopOrder = { cnpj: string; act: string; on: string };

/** The signed badge field (bipe-shared docs/badge-attestation.md "cvm"). Absent: no CVM line. */
export type CvmField =
  | { st: "registered"; cat: string[] }
  | { st: "cancelled"; on: string }
  | { st: "stop_order"; on: string }
  | { st: "no_registration" };

// --- Parsing --------------------------------------------------------------------------------------------

/** Splits a ";" CSV (CVM files: ISO-8859-1, CRLF, fields may be quoted) into a header and rows. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ";") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const [first, ...rest] = lines;
  if (!first) return { header: [], rows: [] };
  return { header: split(first.replace(/^﻿/, "")), rows: rest.map(split) };
}

/** 14 characters, digits and uppercase letters (the CNPJ form of test-vectors/cnpj.json), or null. */
export function cvmCnpj(raw: string | undefined): string | null {
  const v = (raw ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(v) ? v : null;
}

/** YYYY-MM-DD from YYYY-MM-DD or DD/MM/YYYY, else null. */
export function cvmDate(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

/** SIT values (unverified beyond ADR 0077): running registrations are active, cancelled ones cancelled, the rest is ignored. */
export function cvmStatus(sit: string): "active" | "cancelled" | "other" {
  const s = fold(sit);
  if (s.includes("CANCEL")) return "cancelled";
  if (s.startsWith("EM FUNCIONAMENTO") || ["ATIVO", "ATIVA", "REGISTRADO", "REGISTRADA", "DEFERIDO", "AUTORIZADO", "AUTORIZADA"].includes(s)) return "active";
  return "other";
}

const column = (header: string[], ...names: RegExp[]) => header.findIndex((h) => names.some((n) => n.test(h)));

/** One provider file. Throws on a shape it does not know (no CNPJ, DENOM_SOCIAL or SIT column, or no rows). */
export function parseRegister(source: CvmSource, text: string): CvmRegistration[] {
  const { header, rows } = parseCsv(text);
  const cnpjAt = column(header, /^CNPJ$/i, /^CNPJ_/i);
  const nameAt = column(header, /^DENOM_SOCIAL$/i);
  const sitAt = column(header, /^SIT$/i);
  const catAt = source.categoryColumn ? column(header, new RegExp(`^${source.categoryColumn}$`, "i")) : -1;
  const regAt = column(header, /^DT_REG/i);
  const cancelAt = column(header, /^DT_CANCEL/i);
  if (cnpjAt < 0 || nameAt < 0 || sitAt < 0 || (source.categoryColumn && catAt < 0)) throw new Error(`cvm ${source.id}: unknown file shape`);
  if (rows.length === 0) throw new Error(`cvm ${source.id}: no rows`);
  const out: CvmRegistration[] = [];
  for (const r of rows) {
    const cnpj = cvmCnpj(r[cnpjAt]);
    if (!cnpj) continue;
    const category = (catAt >= 0 ? r[catAt] ?? "" : source.label ?? "").trim().toLocaleLowerCase("pt-BR");
    if (!category) continue;
    out.push({
      cnpj,
      source: source.id,
      category,
      status: cvmStatus(r[sitAt] ?? ""),
      registeredOn: regAt >= 0 ? cvmDate(r[regAt]) : null,
      cancelledOn: cancelAt >= 0 ? cvmDate(r[cancelAt]) : null,
    });
  }
  if (out.length === 0) throw new Error(`cvm ${source.id}: no row with a CNPJ`);
  return out;
}

/** ato_declr.csv. Only rows whose CNPJ_CPF is a CNPJ count (ADR 0077 point 5: no CPF, no name match). */
export function parseStopOrders(text: string): CvmStopOrder[] {
  const { header, rows } = parseCsv(text);
  const docAt = column(header, /^CNPJ_CPF$/i);
  const dateAt = column(header, /^Data_Ato_Declaratorio$/i);
  const actAt = column(header, /^Numero_Ato_Declaratorio$/i);
  if (docAt < 0 || dateAt < 0 || actAt < 0) throw new Error("cvm stop orders: unknown file shape");
  if (rows.length === 0) throw new Error("cvm stop orders: no rows");
  const out: CvmStopOrder[] = [];
  for (const r of rows) {
    const cnpj = cvmCnpj(r[docAt]);
    const on = cvmDate(r[dateAt]);
    if (cnpj && on) out.push({ cnpj, act: (r[actAt] ?? "").slice(0, 64), on });
  }
  return out;
}

/** The CSV entries of a zip, by name (central directory; deflate or stored). The CVM zips hold a few small files. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("latin1");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 8) out.set(name, inflateRawSync(data));
    else if (method === 0) out.set(name, data);
    else throw new Error(`zip method ${method} not supported`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The CSV text of one source: the zip entry the source names (or its only CSV), or the plain file. */
export function sourceText(source: CvmSource, body: Buffer): string {
  if (!source.path.endsWith(".zip")) return body.toString("latin1");
  const csvs = [...unzip(body)].filter(([name]) => /\.csv$/i.test(name) && (source.entry ? source.entry.test(name) : true));
  if (csvs.length !== 1) throw new Error(`cvm ${source.id}: expected one CSV in the zip, found ${csvs.length}`);
  return csvs[0]![1].toString("latin1");
}

// --- Refresh -------------------------------------------------------------------------------------------

export type Fetcher = (url: string) => Promise<Buffer>;

const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url.replace(BASE, "")}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

let refreshing: Promise<void> | null = null;

/**
 * Downloads and parses every file, then replaces both tables in one transaction. Any failure keeps the last good
 * tables (a flagged stop order stays flagged until a good file says otherwise), writes last_error and throws.
 */
export function refreshCvm(db: Db, fetcher: Fetcher = httpFetch, log: (s: string) => void = console.log): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const registrations: CvmRegistration[] = [];
      for (const source of CVM_SOURCES) registrations.push(...parseRegister(source, sourceText(source, await fetcher(`${BASE}/${source.path}`))));
      const stops = parseStopOrders((await fetcher(`${BASE}/${CVM_STOP_ORDERS}`)).toString("latin1"));
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM cvm_registrations");
        await client.query(
          `INSERT INTO cvm_registrations (cnpj, source, category, status, registered_on, cancelled_on)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::date[], $6::date[])`,
          [registrations.map((r) => r.cnpj), registrations.map((r) => r.source), registrations.map((r) => r.category),
            registrations.map((r) => r.status), registrations.map((r) => r.registeredOn), registrations.map((r) => r.cancelledOn)],
        );
        await client.query("DELETE FROM cvm_stop_orders");
        await client.query(
          "INSERT INTO cvm_stop_orders (cnpj, act, act_on) SELECT * FROM unnest($1::text[], $2::text[], $3::date[]) ON CONFLICT DO NOTHING",
          [stops.map((s) => s.cnpj), stops.map((s) => s.act), stops.map((s) => s.on)],
        );
        await client.query("UPDATE cvm_state SET refreshed_at = now(), last_error = NULL, last_error_at = NULL WHERE id = 1");
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      log(`cvm: refreshed, ${registrations.length} registrations, ${stops.length} stop orders`);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await db.query("UPDATE cvm_state SET last_error = $1, last_error_at = now() WHERE id = 1", [msg]).catch(() => {});
      console.error(`cvm: ALERT refresh failed, keeping the last good table: ${msg}`);
      throw e;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** CNAE divisions 64, 65 and 66: financial services, insurance, auxiliary activities (ADR 0077 point 3). */
export function isFinancialCnae(cnaes: (string | null | undefined)[]): boolean {
  return cnaes.some((c) => /^6[456]/.test((c ?? "").replace(/\D/g, "")));
}

/**
 * The badge field for one CNPJ, or undefined for no CVM line: a stop order overrides; active registrations list
 * their categories; only cancelled ones give the newest cancel date; none gives no_registration for a financial
 * CNAE only. A table older than 7 days (or never refreshed) gives undefined.
 */
export async function cvmField(db: Db, cnpj: string, cnaes: (string | null | undefined)[], now = Date.now()): Promise<CvmField | undefined> {
  const { rows: state } = await db.query<{ refreshed_at: Date | null }>("SELECT refreshed_at FROM cvm_state WHERE id = 1");
  const refreshed = state[0]?.refreshed_at;
  if (!refreshed || now - refreshed.getTime() > CVM_MAX_AGE_MS) return undefined;
  const { rows: stops } = await db.query<{ on: string }>("SELECT to_char(max(act_on), 'YYYY-MM-DD') AS on FROM cvm_stop_orders WHERE cnpj = $1", [cnpj]);
  if (stops[0]?.on) return { st: "stop_order", on: stops[0].on };
  const { rows } = await db.query<{ category: string; status: string; cancelled_on: string | null }>(
    "SELECT category, status, to_char(cancelled_on, 'YYYY-MM-DD') AS cancelled_on FROM cvm_registrations WHERE cnpj = $1 ORDER BY category",
    [cnpj],
  );
  const active = [...new Set(rows.filter((r) => r.status === "active").map((r) => r.category))];
  if (active.length) return { st: "registered", cat: active };
  const cancelled = rows.filter((r) => r.status === "cancelled" && r.cancelled_on).map((r) => r.cancelled_on!).sort();
  if (cancelled.length) return { st: "cancelled", on: cancelled.at(-1)! };
  if (rows.length === 0 && isFinancialCnae(cnaes)) return { st: "no_registration" };
  return undefined;
}

/** Daily refresh in the server process. The first run waits until the table is 20 hours old. */
export function startCvmRefresh(db: Db): void {
  const tick = async () => {
    const { rows } = await db.query<{ refreshed_at: Date | null }>("SELECT refreshed_at FROM cvm_state WHERE id = 1").catch(() => ({ rows: [] as { refreshed_at: Date | null }[] }));
    const at = rows[0]?.refreshed_at;
    if (at && Date.now() - at.getTime() < 20 * 3_600_000) return;
    await refreshCvm(db).catch(() => {});
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 3_600_000).unref();
}
