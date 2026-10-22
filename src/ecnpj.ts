// e-CNPJ proof (ADR 0042): the company signs the claim challenge with its ICP-Brasil e-CNPJ certificate.
// We check the CMS signature, the chain to a pinned ICP-Brasil root and the validity dates, then read the
// CNPJ from the certificate. Revocation (CRL/OCSP) is not checked yet: see docs/cnpj-verification.md.
import type * as pkijs from "pkijs";
import { commonName, loadPinnedCertificates, otherNames, verifyCms } from "./cms.js";
import { ApiError } from "./errors.js";

/** ICP-Brasil: the CNPJ of a legal-entity certificate, in the SubjectAltName otherName 2.16.76.1.3.3. */
const OID_CNPJ = "2.16.76.1.3.3";

/** Pinned ICP-Brasil root certificates (PEM or DER) from certs/icp-brasil. */
export const loadIcpBrasilRoots = loadPinnedCertificates;

/** The 14-character CNPJ in an e-CNPJ certificate, or null. */
export function cnpjOfCertificate(cert: pkijs.Certificate): string | null {
  for (const text of otherNames(cert, OID_CNPJ)) {
    const cnpj = text.replace(/[^0-9A-Z]/gi, "").toUpperCase();
    if (/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) return cnpj;
  }
  // Older certificates: "RAZAO SOCIAL:12345678000195" in the subject CN.
  const cn = commonName(cert);
  const m = cn ? /:([0-9A-Z]{12}[0-9]{2})$/i.exec(cn) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Checks a CMS (PKCS#7) signature over `challenge`, attached or detached. Returns the CNPJ of the signing
 * certificate. Throws signature_invalid with a reason; never says more than needed.
 */
export async function verifyEcnpjSignature(signatureBase64: string, challenge: string, roots: pkijs.Certificate[], now = new Date()): Promise<{ cnpj: string }> {
  if (roots.length === 0) throw new ApiError("internal", "icp_brasil_roots_missing");
  const result = await verifyCms(Buffer.from(signatureBase64, "base64"), Buffer.from(challenge, "utf8"), roots, now);
  if (!result.ok) throw new ApiError("signature_invalid", result.why);
  const cnpj = cnpjOfCertificate(result.cert);
  if (!cnpj) throw new ApiError("signature_invalid", "not_ecnpj");
  return { cnpj };
}
