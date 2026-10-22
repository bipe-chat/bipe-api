// CMS (PKCS#7) signature check against pinned roots, shared by the e-CNPJ proof (ADR 0042) and the gov.br
// signed challenge (bipe#543). Checks the signature, the chain and the validity dates. Revocation is not checked.
import { readdirSync, readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function parseCertificate(bytes: Buffer): pkijs.Certificate {
  const pem = bytes.toString("latin1");
  const der = pem.includes("-----BEGIN")
    ? Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
    : bytes;
  return pkijs.Certificate.fromBER(toArrayBuffer(der));
}

/** Pinned certificates (PEM or DER) from a directory. A missing directory gives none. */
export function loadPinnedCertificates(dir: string): pkijs.Certificate[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(crt|cer|pem|der)$/i.test(f));
  } catch {
    return [];
  }
  return files.map((f) => parseCertificate(readFileSync(join(dir, f))));
}

export type CmsFailure = "not_cms" | "wrong_content" | "verify_failed" | "bad_signature" | "untrusted_chain" | "no_signer_certificate";
export type CmsResult = { ok: true; cert: pkijs.Certificate } | { ok: false; why: CmsFailure };

/**
 * Checks a DER CMS SignedData over `data`. An attached content must equal `data`; a detached signature is
 * checked over `data`. Trailing bytes after the DER (zero padding in a PDF /Contents) are ignored.
 */
export async function verifyCms(der: Uint8Array, data: Uint8Array, roots: pkijs.Certificate[], now = new Date()): Promise<CmsResult> {
  let signed: pkijs.SignedData;
  try {
    const parsed = asn1js.fromBER(toArrayBuffer(der));
    if (parsed.offset === -1) throw new Error("not BER");
    const info = new pkijs.ContentInfo({ schema: parsed.result });
    if (info.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new Error("not SignedData");
    signed = new pkijs.SignedData({ schema: info.content });
  } catch {
    return { ok: false, why: "not_cms" };
  }
  const attached = signed.encapContentInfo.eContent?.getValue();
  if (attached && !Buffer.from(attached).equals(Buffer.from(data))) return { ok: false, why: "wrong_content" };

  let result: pkijs.SignedDataVerifyResult;
  try {
    result = await signed.verify({
      signer: 0,
      data: attached ? undefined : toArrayBuffer(data),
      trustedCerts: roots,
      checkChain: true,
      checkDate: now,
      extendedMode: true,
    });
  } catch (e) {
    // pkijs throws a result object for a failed chain or a failed signature.
    const r = e as Partial<pkijs.SignedDataVerifyResult>;
    if (r && r.signatureVerified === false) return { ok: false, why: "bad_signature" };
    if (r && r.signerCertificateVerified === false) return { ok: false, why: "untrusted_chain" };
    return { ok: false, why: "verify_failed" };
  }
  if (!result.signatureVerified) return { ok: false, why: "bad_signature" };
  if (!result.signerCertificateVerified) return { ok: false, why: "untrusted_chain" };
  if (!result.signerCertificate) return { ok: false, why: "no_signer_certificate" };
  return { ok: true, cert: result.signerCertificate };
}

/** The subject CN of a certificate, or null. */
export function commonName(cert: pkijs.Certificate): string | null {
  const cn = cert.subject.typesAndValues.find((t) => t.type === "2.5.4.3")?.value.valueBlock.value;
  return typeof cn === "string" ? cn.trim() : null;
}

/** The text inside an otherName value: [0] EXPLICIT wrapping an OCTET STRING or a string type. */
function otherNameText(value: asn1js.AsnType): string {
  let node = value as asn1js.BaseBlock & { valueBlock: { value?: asn1js.BaseBlock[]; valueHexView?: Uint8Array } };
  while (node.valueBlock.value && node.valueBlock.value.length > 0 && !(node instanceof asn1js.OctetString)) {
    node = node.valueBlock.value[0] as typeof node;
  }
  return Buffer.from(node.valueBlock.valueHexView ?? new Uint8Array()).toString("latin1");
}

/** The texts of the SubjectAltName otherName entries with this OID. */
export function otherNames(cert: pkijs.Certificate, oid: string): string[] {
  const san = cert.extensions?.find((e) => e.extnID === "2.5.29.17");
  const names = (san?.parsedValue as pkijs.AltName | undefined)?.altNames ?? [];
  const out: string[] = [];
  for (const n of names) {
    if (n.type !== 0) continue; // otherName
    const v = n.value as { typeId?: string; value?: asn1js.AsnType } | asn1js.Sequence;
    // pkijs keeps otherName as the raw SEQUENCE { type-id OID, [0] value }.
    const seq = v instanceof asn1js.Sequence ? v.valueBlock.value : null;
    const id = seq ? (seq[0] as asn1js.ObjectIdentifier).valueBlock.toString() : (v as { typeId?: string }).typeId;
    if (id !== oid) continue;
    out.push(otherNameText(seq ? (seq[1] as asn1js.AsnType) : (v as { value: asn1js.AsnType }).value));
  }
  return out;
}
