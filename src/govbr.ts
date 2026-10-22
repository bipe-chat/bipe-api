// gov.br signed challenge, trust step 5 (bipe#543; bipe docs/identity.md, docs/trust-levels.md).
// The API makes a one-page PDF that names Bipe, the @handle, the date and a code. The user signs it in the
// gov.br app and sends it back. We check the PDF signature against the pinned gov.br roots, that it covers the
// whole file, that it holds the caller's open code, then read name and CPF from the signer certificate.
// We keep the verified name and a keyed CPF hash. Never the PDF, the CPF or the certificate.
//
// Two parts wait on a real gov.br-signed file (bipe#542): where the certificate keeps the CPF (personOf) and
// how the code survives signing (containsCode). Both take the best guess and fail closed.
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import type * as pkijs from "pkijs";
import type { BadgeEnvelope } from "./badges.js";
import { commonName, otherNames, verifyCms, type CmsFailure } from "./cms.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

const LIFE_MS = 30 * 60_000;
// No 0/O and 1/I: the code is read by people.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const GOVBR_PDF_MAX_BYTES = 5 * 1024 * 1024;
const FILE_NAME = "bipe-verificacao.pdf";
const MARKER = "bipe-govbr:";
// ICP-Brasil person data otherName: birth date (8 digits), then the CPF (11 digits), then more fields.
const OID_PERSON_DATA = "2.16.76.1.3.1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type GovbrReason = "not_signed" | "not_govbr" | "wrong_document" | "expired" | "cpf_in_use" | "changed_after_signing";
export type GovbrStatus =
  | { verificationId: string; state: "verified"; badge?: BadgeEnvelope }
  | { verificationId: string; state: "rejected"; reason: GovbrReason };

export type GovbrDeps = {
  roots: pkijs.Certificate[];
  cpfSecret: string | undefined;
  /** The caller's badge after a verification, or null when badges are off. */
  badgeOf: (userId: string) => Promise<BadgeEnvelope | null>;
};

function newCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** POST /v1/verifications/govbr: a challenge bound to the caller's device key. */
export async function createGovbrChallenge(db: Db, userId: string, deviceKey: string, now = new Date()) {
  const { rows } = await db.query<{ handle: string }>("SELECT handle FROM handles WHERE user_id = $1", [userId]);
  const who = rows[0] ? `@${rows[0].handle}` : userId;
  const id = randomUUID();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + LIFE_MS);
  await db.query("INSERT INTO govbr_challenges (id, user_id, device_key, code, expires_at) VALUES ($1, $2, $3, $4, $5)", [
    id,
    userId,
    deviceKey,
    code,
    expiresAt,
  ]);
  return { verificationId: id, pdf: challengePdf(who, code, now).toString("base64"), fileName: FILE_NAME, expiresAt: expiresAt.toISOString() };
}

type ChallengeRow = { id: string; device_key: string; code: string; expires_at: Date; used_at: Date | null };

/** PUT /v1/verifications/govbr/{id}/document. A rejected file leaves the challenge open until it expires. */
export async function submitGovbrDocument(db: Db, deps: GovbrDeps, userId: string, id: string, pdf: Buffer, now = new Date()): Promise<GovbrStatus> {
  if (!UUID.test(id)) throw new ApiError("not_found");
  const { rows } = await db.query<ChallengeRow>(
    "SELECT id, device_key, code, expires_at, used_at FROM govbr_challenges WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  const row = rows[0];
  if (!row || row.used_at) throw new ApiError("not_found");
  if (deps.roots.length === 0) throw new ApiError("internal", "govbr_roots_missing");
  if (!deps.cpfSecret) throw new ApiError("internal", "cpf_secret_missing");
  const reject = (reason: GovbrReason): GovbrStatus => ({ verificationId: id, state: "rejected", reason });
  if (row.expires_at.getTime() <= now.getTime()) return reject("expired");

  const checked = await checkSignedPdf(pdf, deps.roots, now);
  if (!checked.ok) return reject(checked.reason);
  if (!containsCode(checked.signed, row.code)) return reject("wrong_document");
  const person = personOf(checked.cert);
  if (!person.name) return reject("not_govbr");
  // Fail closed and loud: a gov.br certificate without a CPF we can read means personOf needs the #542 answer.
  if (!person.cpf) throw new ApiError("internal", "govbr_cpf_missing");
  const cpfHash = createHmac("sha256", deps.cpfSecret).update(person.cpf).digest("hex");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const used = await client.query("UPDATE govbr_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL", [id, now]);
    if (used.rowCount !== 1) throw new ApiError("not_found");
    await client.query(
      `INSERT INTO person_verifications (user_id, level, verified_name, cpf_hash, device_key, verified_at)
       VALUES ($1, 'govbr', $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET level = 'govbr', verified_name = $2, cpf_hash = $3, device_key = $4, verified_at = $5`,
      [userId, person.name, cpfHash, row.device_key, now],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") return reject("cpf_in_use");
    throw e;
  } finally {
    client.release();
  }
  const badge = await deps.badgeOf(userId);
  return { verificationId: id, state: "verified", ...(badge ? { badge } : {}) };
}

/** Challenges that ended more than a day ago. */
export async function pruneGovbrChallenges(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM govbr_challenges WHERE expires_at < now() - interval '1 day'");
  return rowCount ?? 0;
}

// ---- Signed PDF ----

type PdfSignature = { contents: Buffer; signed: Buffer; coversAll: boolean };

/** Every signature dictionary: the CMS from /Contents and the bytes its /ByteRange covers. */
export function pdfSignatures(pdf: Buffer): PdfSignature[] {
  const text = pdf.toString("latin1");
  const out: PdfSignature[] = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (a !== 0 || b <= 0 || c <= b || d < 0 || c + d > pdf.length) continue;
    const gap = /^<([0-9a-fA-F\s]*)>$/.exec(text.slice(b, c));
    if (!gap) continue;
    out.push({
      contents: Buffer.from(gap[1]!.replace(/\s+/g, ""), "hex"),
      signed: Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]),
      // Only whitespace may follow the signed range; anything else was added after signing.
      coversAll: /^\s*$/.test(text.slice(c + d)),
    });
  }
  return out;
}

const REASON_OF: Record<CmsFailure, GovbrReason> = {
  not_cms: "not_signed",
  wrong_content: "changed_after_signing",
  bad_signature: "changed_after_signing",
  untrusted_chain: "not_govbr",
  no_signer_certificate: "not_govbr",
  verify_failed: "not_govbr",
};

export async function checkSignedPdf(
  pdf: Buffer,
  roots: pkijs.Certificate[],
  now = new Date(),
): Promise<{ ok: true; cert: pkijs.Certificate; signed: Buffer } | { ok: false; reason: GovbrReason }> {
  if (!pdf.subarray(0, 1024).toString("latin1").includes("%PDF-")) return { ok: false, reason: "not_signed" };
  const sigs = pdfSignatures(pdf);
  if (sigs.length === 0) return { ok: false, reason: "not_signed" };
  const sig = sigs.find((s) => s.coversAll);
  if (!sig) return { ok: false, reason: "changed_after_signing" };
  const result = await verifyCms(sig.contents, sig.signed, roots, now);
  if (!result.ok) return { ok: false, reason: REASON_OF[result.why] };
  return { ok: true, cert: result.cert, signed: sig.signed };
}

/** True when the signed bytes hold the code, as written or inside a Flate stream (bipe#542 confirms which). */
export function containsCode(signed: Buffer, code: string): boolean {
  const text = signed.toString("latin1");
  if (text.includes(code)) return true;
  let budget = 20 * 1024 * 1024;
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0 || budget <= 0) break;
    try {
      const out = inflateSync(signed.subarray(start, end), { maxOutputLength: Math.min(budget, 5 * 1024 * 1024) });
      budget -= out.length;
      if (out.toString("latin1").includes(code)) return true;
    } catch {
      // Not Flate, or too big: skip it.
    }
  }
  return false;
}

// ---- Signer certificate ----

export function validCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

/** Name and CPF of the signer: CN "NAME:CPF" first, then the ICP-Brasil person-data otherName. */
export function personOf(cert: pkijs.Certificate): { name: string | null; cpf: string | null } {
  const cn = commonName(cert);
  const m = cn ? /^(.+?)\s*:\s*(\d{11})$/.exec(cn) : null;
  const name = (m ? m[1]! : cn)?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const fromCn = m && validCpf(m[2]!) ? m[2]! : null;
  const fromSan = otherNames(cert, OID_PERSON_DATA)
    .map((t) => t.replace(/\D/g, "").slice(8, 19))
    .find(validCpf);
  return { name, cpf: fromCn ?? fromSan ?? null };
}

// ---- Challenge PDF ----

/** A PDF string literal in WinAnsi (Latin-1 for the letters we use), with octal escapes. */
function pdfText(s: string): string {
  let out = "(";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0xff) out += "?";
    else if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out})`;
}

/** One A4 page, Helvetica, no library. The code is in the text and in /Keywords. */
export function challengePdf(who: string, code: string, now: Date): Buffer {
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const lines: [font: string, size: number, y: number, text: string][] = [
    ["F1", 18, 760, "Verificação de identidade no Bipe"],
    ["F2", 12, 720, `Eu confirmo que a conta Bipe ${who} é minha.`],
    ["F2", 12, 696, `Código: ${code}`],
    ["F2", 12, 672, `Data: ${date}`],
    ["F2", 10, 630, "Assine este documento só no app gov.br."],
    ["F2", 10, 614, "O Bipe nunca pede sua senha ou o código do gov.br,"],
    ["F2", 10, 600, "nem manda documento para assinar por mensagem."],
    ["F2", 7, 60, `${MARKER}${code}`],
  ];
  const content = lines.map(([f, size, y, t]) => `BT /${f} ${size} Tf 60 ${y} Td ${pdfText(t)} Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfText("Verificação Bipe")} /Keywords ${pdfText(`${MARKER}${code}`)} /Producer (Bipe) >>`,
  ];
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
