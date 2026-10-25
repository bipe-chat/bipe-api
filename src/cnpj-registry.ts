// Receita Federal CNPJ open data (ADR 0042). Bipe keeps the latest monthly release on disk and scans it
// for the CNPJs that have a claim. No third party sees which CNPJs we check, and nothing loads 60 million
// rows into Postgres: a scan streams the zip files and keeps only the matching rows.
//
// Files: Estabelecimentos*.zip (one row per establishment), Empresas*.zip (one row per company root),
// Socios*.zip (partners per company root). ";"-separated, quoted, ISO-8859-1. Column order from
// Receita's metadata (cnpj-metadados.pdf).
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/** Situação cadastral 02 = ativa. Other codes: 01 nula, 03 suspensa, 04 inapta, 08 baixada. */
const ACTIVE = 2;

export type Establishment = { cnpj: string; tradeName: string | null; statusCode: number; active: boolean; cnaeMain: string | null; cnaeSecondary: string[] };
export type Partner = { root: string; kind: number; name: string; doc: string; qualification: number };
export type ScanResult = {
  month: string;
  establishments: Map<string, Establishment>;
  legalNames: Map<string, string>;
  partners: Map<string, Partner[]>;
};

// --- Zip ---------------------------------------------------------------------------------------------
// Each Receita zip holds one deflated CSV. Read the local file header for the data offset, then inflate
// from there; the deflate stream ends by itself, so the (possibly ZIP64) sizes are not needed.

function zipEntryStream(path: string): Readable {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(30);
  try {
    readSync(fd, header, 0, 30, 0);
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${path}: not a zip local file header`);
  const method = header.readUInt16LE(8);
  const start = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (method === 8) return createReadStream(path, { start }).pipe(createInflateRaw());
  // Stored (no compression): the size is in the header unless it is a ZIP64 placeholder.
  const size = header.readUInt32LE(18);
  if (method === 0 && size !== 0xffffffff) return size === 0 ? Readable.from([]) : createReadStream(path, { start, end: start + size - 1 });
  throw new Error(`${path}: compression method ${method} not supported`);
}

/** Splits one CSV line: ";" separators, fields in double quotes, "" inside a quoted field. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let v = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        v += line[i++];
      }
      out.push(v);
      i++; // the ";"
    } else {
      const end = line.indexOf(";", i);
      out.push(end < 0 ? line.slice(i) : line.slice(i, end));
      i = end < 0 ? line.length + 1 : end + 1;
    }
  }
  return out;
}

async function forEachRow(files: string[], onRow: (cols: string[]) => void): Promise<void> {
  for (const file of files) {
    const lines = createInterface({ input: zipEntryStream(file).setEncoding("latin1"), crlfDelay: Infinity });
    for await (const line of lines) if (line) onRow(splitLine(line));
  }
}

// --- Release on disk ---------------------------------------------------------------------------------

const FAMILIES = ["Estabelecimentos", "Empresas", "Socios"] as const;

function familyFiles(dir: string, family: (typeof FAMILIES)[number]): string[] {
  return readdirSync(dir).filter((f) => new RegExp(`^${family}\\d\\.zip$`).test(f)).sort().map((f) => join(dir, f));
}

/** The newest complete release under baseDir (a YYYY-MM folder with all 30 files), or null. */
export function latestRelease(baseDir: string): { month: string; dir: string } | null {
  if (!existsSync(baseDir)) return null;
  const months = readdirSync(baseDir).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort().reverse();
  for (const month of months) {
    const dir = join(baseDir, month);
    if (FAMILIES.every((f) => familyFiles(dir, f).length === 10)) return { month, dir };
  }
  return null;
}

/**
 * Finds the given CNPJs (14 characters, normalised) in one release: their establishment rows, the legal
 * name of each company root, and the partners of each root. Unknown CNPJs are simply absent.
 */
export async function scanRelease(release: { month: string; dir: string }, cnpjs: Iterable<string>): Promise<ScanResult> {
  const wanted = new Set(cnpjs);
  const roots = new Set([...wanted].map((c) => c.slice(0, 8)));
  const result: ScanResult = { month: release.month, establishments: new Map(), legalNames: new Map(), partners: new Map() };
  if (wanted.size === 0) return result;

  // Estabelecimentos: 0 cnpj_basico, 1 cnpj_ordem, 2 cnpj_dv, 3 matriz/filial, 4 nome_fantasia, 5 situacao_cadastral,
  // 11 cnae_fiscal_principal, 12 cnae_fiscal_secundaria (comma-separated)
  await forEachRow(familyFiles(release.dir, "Estabelecimentos"), (c) => {
    if (!roots.has(c[0]!)) return;
    const cnpj = `${c[0]}${c[1]}${c[2]}`;
    if (!wanted.has(cnpj)) return;
    const statusCode = Number.parseInt(c[5] ?? "", 10);
    const cnaeSecondary = (c[12] ?? "").split(",").map((v) => v.trim()).filter((v) => /^\d{7}$/.test(v));
    const cnaeMain = /^\d{7}$/.test(c[11]?.trim() ?? "") ? c[11]!.trim() : null;
    result.establishments.set(cnpj, { cnpj, tradeName: c[4]?.trim() || null, statusCode, active: statusCode === ACTIVE, cnaeMain, cnaeSecondary });
  });
  // Empresas: 0 cnpj_basico, 1 razao_social
  await forEachRow(familyFiles(release.dir, "Empresas"), (c) => {
    if (roots.has(c[0]!)) result.legalNames.set(c[0]!, c[1]!.trim());
  });
  // Socios: 0 cnpj_basico, 1 identificador (1 PJ, 2 PF, 3 estrangeiro), 2 nome, 3 cpf mascarado ou cnpj, 4 qualificação
  await forEachRow(familyFiles(release.dir, "Socios"), (c) => {
    if (!roots.has(c[0]!)) return;
    const list = result.partners.get(c[0]!) ?? [];
    list.push({ root: c[0]!, kind: Number(c[1]), name: c[2]!.trim(), doc: c[3]!.trim(), qualification: Number(c[4]) });
    result.partners.set(c[0]!, list);
  });
  return result;
}

// --- Download -----------------------------------------------------------------------------------------
// Receita publishes on a public Nextcloud share. WebDAV needs the share token as user name, a PROPFIND body
// and a browser-like user agent (the server answers 200 with an empty body otherwise; seen 12 October 2026).

const DAV_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>';
const UA = "Mozilla/5.0 (compatible; bipe-api; +https://bipe.chat)";

async function propfind(baseUrl: string, token: string, path: string): Promise<{ name: string; size: number }[]> {
  const res = await fetch(`${baseUrl}/${path}`, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml", "User-Agent": UA, Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}` },
    body: DAV_BODY,
  });
  if (res.status !== 207) throw new Error(`PROPFIND ${path}: HTTP ${res.status}`);
  const xml = await res.text();
  return xml.split("<d:response>").slice(1).map((block) => ({
    name: decodeURIComponent((/<d:href>([^<]*)<\/d:href>/.exec(block)?.[1] ?? "").replace(/\/$/, "").split("/").pop() ?? ""),
    size: Number(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1] ?? 0),
  }));
}

/** The newest month folder on the share. */
export async function newestMonth(baseUrl: string, token: string): Promise<string> {
  const months = (await propfind(baseUrl, token, "")).map((e) => e.name).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort();
  const month = months.at(-1);
  if (!month) throw new Error("no month folders on the Receita share");
  return month;
}

/**
 * Downloads the 30 files verification needs for one month into baseDir/month. Files already complete on disk
 * are skipped. Each file is written to a .part name first, then renamed, so a half file never counts.
 */
export async function downloadRelease(baseUrl: string, token: string, baseDir: string, month: string, log: (s: string) => void): Promise<string> {
  const dir = join(baseDir, month);
  mkdirSync(dir, { recursive: true });
  const entries = (await propfind(baseUrl, token, `${month}/`)).filter((e) => FAMILIES.some((f) => new RegExp(`^${f}\\d\\.zip$`).test(e.name)));
  if (entries.length !== 30) throw new Error(`${month}: expected 30 files, found ${entries.length}`);
  for (const e of entries) {
    const target = join(dir, e.name);
    if (existsSync(target) && statSync(target).size === e.size) continue;
    log(`downloading ${month}/${e.name} (${(e.size / 1e6).toFixed(0)} MB)`);
    const res = await fetch(`${baseUrl}/${month}/${e.name}`, {
      headers: { "User-Agent": UA, Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}` },
    });
    if (!res.ok || !res.body) throw new Error(`GET ${e.name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${target}.part`));
    if (statSync(`${target}.part`).size !== e.size) throw new Error(`${e.name}: size mismatch`);
    renameSync(`${target}.part`, target);
  }
  return dir;
}
