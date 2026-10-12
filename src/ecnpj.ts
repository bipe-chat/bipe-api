// e-CNPJ proof (ADR 0042): the company signs the claim challenge with its ICP-Brasil e-CNPJ certificate.
// We check the CMS signature, the chain to a pinned ICP-Brasil root and the validity dates, then read the
// CNPJ from the certificate. Revocation (CRL/OCSP) is not checked yet: see docs/cnpj-verification.md.
import { readdirSync, readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { ApiError } from "./errors.js";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

/** ICP-Brasil: the CNPJ of a legal-entity certificate, in the SubjectAltName otherName 2.16.76.1.3.3. */
const OID_CNPJ = "2.16.76.1.3.3";
const OID_SAN = "2.5.29.17";

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function parseCertificate(bytes: Buffer): pkijs.Certificate {
  const pem = bytes.toString("latin1");
  const der = pem.includes("-----BEGIN")
    ? Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
    : bytes;
  return pkijs.Certificate.fromBER(toArrayBuffer(der));
}

/** Pinned ICP-Brasil root certificates (PEM or DER) from certs/icp-brasil. */
export function loadIcpBrasilRoots(dir: string): pkijs.Certificate[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(crt|cer|pem|der)$/i.test(f));
  } catch {
    return [];
  }
  return files.map((f) => parseCertificate(readFileSync(join(dir, f))));
}

/** The text inside an otherName value: [0] EXPLICIT wrapping an OCTET STRING or a string type. */
function otherNameText(value: asn1js.AsnType): string {
  let node = value as asn1js.BaseBlock & { valueBlock: { value?: asn1js.BaseBlock[]; valueHexView?: Uint8Array } };
  while (node.valueBlock.value && node.valueBlock.value.length > 0 && !(node instanceof asn1js.OctetString)) {
    node = node.valueBlock.value[0] as typeof node;
  }
  const bytes = node instanceof asn1js.OctetString ? node.valueBlock.valueHexView : node.valueBlock.valueHexView;
  return Buffer.from(bytes ?? new Uint8Array()).toString("latin1");
}

/** The 14-character CNPJ in an e-CNPJ certificate, or null. */
export function cnpjOfCertificate(cert: pkijs.Certificate): string | null {
  const san = cert.extensions?.find((e) => e.extnID === OID_SAN);
  const names = (san?.parsedValue as pkijs.AltName | undefined)?.altNames ?? [];
  for (const n of names) {
    if (n.type !== 0) continue; // otherName
    const v = n.value as { typeId?: string; value?: asn1js.AsnType } | asn1js.Sequence;
    // pkijs keeps otherName as the raw SEQUENCE { type-id OID, [0] value }.
    const seq = v instanceof asn1js.Sequence ? v.valueBlock.value : null;
    const oid = seq ? (seq[0] as asn1js.ObjectIdentifier).valueBlock.toString() : (v as { typeId?: string }).typeId;
    if (oid !== OID_CNPJ) continue;
    const text = otherNameText(seq ? (seq[1] as asn1js.AsnType) : ((v as { value: asn1js.AsnType }).value));
    const cnpj = text.replace(/[^0-9A-Z]/gi, "").toUpperCase();
    if (/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) return cnpj;
  }
  // Older certificates: "RAZAO SOCIAL:12345678000195" in the subject CN.
  const cn = cert.subject.typesAndValues.find((t) => t.type === "2.5.4.3")?.value.valueBlock.value;
  const m = typeof cn === "string" ? /:([0-9A-Z]{12}[0-9]{2})$/i.exec(cn.trim()) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Checks a CMS (PKCS#7) signature over `challenge`, attached or detached. Returns the CNPJ of the signing
 * certificate. Throws signature_invalid with a reason; never says more than needed.
 */
export async function verifyEcnpjSignature(signatureBase64: string, challenge: string, roots: pkijs.Certificate[], now = new Date()): Promise<{ cnpj: string }> {
  if (roots.length === 0) throw new ApiError("internal", "icp_brasil_roots_missing");
  let signed: pkijs.SignedData;
  try {
    const der = Buffer.from(signatureBase64, "base64");
    const info = pkijs.ContentInfo.fromBER(toArrayBuffer(der));
    if (info.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new Error("not SignedData");
    signed = new pkijs.SignedData({ schema: info.content });
  } catch {
    throw new ApiError("signature_invalid", "not_cms");
  }
  const expected = Buffer.from(challenge, "utf8");
  const attached = signed.encapContentInfo.eContent?.getValue();
  if (attached && !Buffer.from(attached).equals(expected)) throw new ApiError("signature_invalid", "wrong_content");

  let result: pkijs.SignedDataVerifyResult;
  try {
    result = await signed.verify({
      signer: 0,
      data: attached ? undefined : toArrayBuffer(expected),
      trustedCerts: roots,
      checkChain: true,
      checkDate: now,
      extendedMode: true,
    });
  } catch {
    throw new ApiError("signature_invalid", "verify_failed");
  }
  if (!result.signatureVerified) throw new ApiError("signature_invalid", "bad_signature");
  if (!result.signerCertificateVerified) throw new ApiError("signature_invalid", "untrusted_chain");
  const cert = result.signerCertificate;
  if (!cert) throw new ApiError("signature_invalid", "no_signer_certificate");
  const cnpj = cnpjOfCertificate(cert);
  if (!cnpj) throw new ApiError("signature_invalid", "not_ecnpj");
  return { cnpj };
}
