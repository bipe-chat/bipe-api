// Android Key Attestation: proves a sign-up comes from a genuine Bipe app on an Android phone with a locked,
// verified boot (ADR 0043, bipe#92). No Google library: the app sends the certificate chain of a new Keystore key
// and the server checks it against Google's attestation roots. Format: developer.android.com, "Verify hardware-backed
// key pairs with key attestation" (KeyDescription, AuthorizationList, RootOfTrust, AttestationApplicationId).
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as asn1 from "asn1js";
import { takeChallenge } from "./attest.js";
import { ApiError } from "./errors.js";

// https://android.googleapis.com/attestation/root, fetched 25 Oct 2026: the RSA root (same key as the 2016 and 2019
// roots) and the EC root "Key Attestation CA1" (2025). A chain may end in any certificate that has one of these keys.
const ROOTS = readFileSync(fileURLToPath(new URL("../certs/google-key-attestation-roots.pem", import.meta.url)), "utf8")
  .split(/(?=-----BEGIN CERTIFICATE-----)/)
  .filter((pem) => pem.includes("BEGIN CERTIFICATE"))
  .map((pem) => new X509Certificate(pem));
const STATUS_URL = "https://android.googleapis.com/attestation/status";
const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const TAG_ROOT_OF_TRUST = 704;
const TAG_APPLICATION_ID = 709;
const SECURITY_SOFTWARE = 0;
const BOOT_VERIFIED = 0;
const BOOT_SELF_SIGNED = 1;

export interface KeyAttestation {
  key_attestation_chain: string[]; // standard base64 DER, leaf first
  challenge: string; // from POST /v1/attest/challenge; the app passes its UTF-8 bytes to setAttestationChallenge
}

export interface KeyAttestationPolicy {
  /** Application IDs of the Bipe Android app. One of them must be in the attestation. */
  packages: readonly string[];
  /** Lower-case hex SHA-256 of the app signing certificates. Empty: not checked (CI debug keys change every run). */
  certDigests: readonly string[];
  /** Lower-case hex verified boot keys of custom operating systems that count as attested (GrapheneOS, ADR 0043). */
  bootKeys: readonly string[];
}

/** Why a genuine chain does not make the phone attested. The sign-up then goes on as without an attestation. */
export type KeyAttestationResult = { attested: true } | { attested: false; reason: string };

/** The revoked serial numbers (lower-case hex, no leading zeros), or null while the status list is unknown. */
export type RevocationSource = () => ReadonlySet<string> | null;

const fail = (step: string): never => {
  // Step name only: chains are device-specific.
  console.error(`key attestation: failed at ${step}`);
  throw new ApiError("attestation_invalid");
};

const serialKey = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, "");

/** Bind trust roots in code, never from a request or environment setting. Tests use a synthetic CA. */
export function createKeyAttestationVerifier(roots: readonly X509Certificate[], revoked: RevocationSource) {
  const rootKeys = roots.map((root) => root.publicKey.export({ type: "spki", format: "der" }));
  return function verifyKeyAttestation(att: KeyAttestation, policy: KeyAttestationPolicy): KeyAttestationResult {
    if (!takeChallenge(att.challenge)) fail("challenge");

    // 1. Chain: each certificate is signed by the next one; the last one has a pinned Google root key.
    let chain: X509Certificate[];
    try {
      chain = att.key_attestation_chain.map((b64) => new X509Certificate(Buffer.from(b64, "base64")));
    } catch {
      return fail("certificates");
    }
    if (chain.length < 2) fail("structure");
    for (let i = 0; i < chain.length - 1; i++) if (!chain[i]!.verify(chain[i + 1]!.publicKey)) fail("chain");
    const last = chain.at(-1)!;
    const lastKey = last.publicKey.export({ type: "spki", format: "der" });
    if (!last.verify(last.publicKey) || !rootKeys.some((key) => key.equals(lastKey))) fail("root");
    // Validity dates are not checked: many factory chains carry odd dates. Google revokes through the status list.

    // 2. Revocation. Without the status list a genuine chain still passes, but the phone is not attested.
    const list = revoked();
    if (list && chain.some((cert) => list.has(serialKey(cert.serialNumber)))) fail("revoked");

    // 3. The key description in the leaf certificate.
    const description = keyDescription(chain[0]!) ?? fail("key-description");
    if (!description.challenge.equals(Buffer.from(att.challenge, "utf8"))) fail("challenge-binding");

    // 4. The app: package name and, when configured, signing certificate.
    const app = description.applicationId ?? fail("application-id");
    if (!app.packages.some((name) => policy.packages.includes(name))) fail("package");
    if (policy.certDigests.length > 0 && !app.digests.some((d) => policy.certDigests.includes(d))) fail("signature");

    // 5. The phone: hardware keystore, locked bootloader, verified boot (or a custom OS with a known boot key).
    if (!list) return { attested: false, reason: "status-unavailable" };
    if (description.attestationSecurity === SECURITY_SOFTWARE || description.keymasterSecurity === SECURITY_SOFTWARE) {
      return { attested: false, reason: "software" };
    }
    const boot = description.rootOfTrust;
    if (!boot) return { attested: false, reason: "root-of-trust" };
    if (!boot.deviceLocked) return { attested: false, reason: "unlocked" };
    if (boot.verifiedBootState === BOOT_VERIFIED) return { attested: true };
    if (boot.verifiedBootState === BOOT_SELF_SIGNED && policy.bootKeys.includes(boot.verifiedBootKey)) return { attested: true };
    return { attested: false, reason: "boot-state" };
  };
}

interface KeyDescription {
  attestationSecurity: number;
  keymasterSecurity: number;
  challenge: Buffer;
  rootOfTrust: { verifiedBootKey: string; deviceLocked: boolean; verifiedBootState: number } | null;
  applicationId: { packages: string[]; digests: string[] } | null;
}

// KeyDescription ::= SEQUENCE { attestationVersion, attestationSecurityLevel, keyMintVersion, keyMintSecurityLevel,
// attestationChallenge, uniqueId, softwareEnforced AuthorizationList, hardwareEnforced AuthorizationList }
function keyDescription(leaf: X509Certificate): KeyDescription | null {
  try {
    const value = extensionValue(leaf.raw, KEY_DESCRIPTION_OID);
    if (!value) return null;
    const seq = parse(value);
    if (!(seq instanceof asn1.Sequence)) return null;
    const items = seq.valueBlock.value;
    if (items.length < 8) return null;
    const software = items[6]!, hardware = items[7]!;
    const rootOfTrust = tagged(hardware, TAG_ROOT_OF_TRUST);
    // The keystore writes the application ID; KeyMint versions put it in either list.
    const appId = tagged(software, TAG_APPLICATION_ID) ?? tagged(hardware, TAG_APPLICATION_ID);
    return {
      attestationSecurity: enumerated(items[1]!),
      keymasterSecurity: enumerated(items[3]!),
      challenge: octets(items[4]!),
      rootOfTrust: rootOfTrust ? parseRootOfTrust(rootOfTrust) : null,
      applicationId: appId ? parseApplicationId(octets(appId)) : null,
    };
  } catch {
    return null;
  }
}

// RootOfTrust ::= SEQUENCE { verifiedBootKey OCTET STRING, deviceLocked BOOLEAN, verifiedBootState ENUMERATED, ... }
function parseRootOfTrust(node: asn1.AsnType) {
  if (!(node instanceof asn1.Sequence) || node.valueBlock.value.length < 3) throw new Error("root of trust");
  const [key, locked, state] = node.valueBlock.value;
  if (!(locked instanceof asn1.Boolean)) throw new Error("device locked");
  return { verifiedBootKey: octets(key!).toString("hex"), deviceLocked: locked.getValue(), verifiedBootState: enumerated(state!) };
}

// AttestationApplicationId ::= SEQUENCE { packageInfos SET OF SEQUENCE { packageName OCTET STRING, version INTEGER },
// signatureDigests SET OF OCTET STRING }
function parseApplicationId(der: Buffer) {
  const seq = parse(der);
  if (!(seq instanceof asn1.Sequence) || seq.valueBlock.value.length < 2) throw new Error("application id");
  const [infos, digests] = seq.valueBlock.value;
  const packages = setItems(infos!).map((info) => {
    if (!(info instanceof asn1.Sequence)) throw new Error("package info");
    return octets(info.valueBlock.value[0]!).toString("utf8");
  });
  return { packages, digests: setItems(digests!).map((d) => octets(d).toString("hex")) };
}

function parse(der: Buffer): asn1.AsnType {
  const bytes = Uint8Array.from(der);
  const { offset, result } = asn1.fromBER(bytes);
  if (offset === -1 || offset !== bytes.byteLength) throw new Error("ber");
  return result;
}

// AuthorizationList ::= SEQUENCE of optional [tag] EXPLICIT fields.
function tagged(list: asn1.AsnType, tag: number): asn1.AsnType | null {
  if (!(list instanceof asn1.Sequence)) throw new Error("authorization list");
  for (const item of list.valueBlock.value) {
    if (item.idBlock.tagClass === 3 && item.idBlock.tagNumber === tag && item instanceof asn1.Constructed) {
      return item.valueBlock.value[0] ?? null;
    }
  }
  return null;
}

function setItems(node: asn1.AsnType): asn1.AsnType[] {
  if (!(node instanceof asn1.Set)) throw new Error("set");
  return node.valueBlock.value;
}

function octets(node: asn1.AsnType): Buffer {
  if (!(node instanceof asn1.OctetString)) throw new Error("octet string");
  return Buffer.from(node.valueBlock.valueHexView);
}

function enumerated(node: asn1.AsnType): number {
  if (!(node instanceof asn1.Enumerated)) throw new Error("enumerated");
  return node.valueBlock.valueDec;
}

// Certificate ::= SEQUENCE { tbsCertificate, ... }; extensions are [3] at the end of tbsCertificate.
function extensionValue(der: Buffer, oid: string): Buffer | null {
  const cert = parse(der);
  if (!(cert instanceof asn1.Sequence)) return null;
  const tbs = cert.valueBlock.value[0];
  if (!(tbs instanceof asn1.Sequence)) return null;
  for (const field of tbs.valueBlock.value) {
    if (field.idBlock.tagClass !== 3 || field.idBlock.tagNumber !== 3 || !(field instanceof asn1.Constructed)) continue;
    const extensions = field.valueBlock.value[0];
    if (!(extensions instanceof asn1.Sequence)) return null;
    for (const ext of extensions.valueBlock.value) {
      if (!(ext instanceof asn1.Sequence)) continue;
      const [id, ...rest] = ext.valueBlock.value;
      if (id instanceof asn1.ObjectIdentifier && id.valueBlock.toString() === oid) {
        const value = rest.at(-1);
        return value instanceof asn1.OctetString ? Buffer.from(value.valueBlock.valueHexView) : null;
      }
    }
  }
  return null;
}

// Google's status list of revoked attestation keys and certificates, refreshed every 6 hours.
let revokedSerials: Set<string> | null = null;

export async function refreshKeyAttestationStatus(): Promise<void> {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "max-age=0" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { entries?: Record<string, { status?: string }> };
    if (!body.entries || typeof body.entries !== "object") throw new Error("no entries");
    revokedSerials = new Set(
      // REVOKED and SUSPENDED both stop the chain.
      Object.entries(body.entries).filter(([, e]) => e?.status === "REVOKED" || e?.status === "SUSPENDED").map(([serial]) => serialKey(serial)),
    );
  } catch (error) {
    // Keep the last good list. Without any list, genuine chains pass but count as not attested.
    console.error(`key attestation: status list not loaded (${error instanceof Error ? error.message : "error"})`);
  }
}

export type KeyAttestationVerifier = ReturnType<typeof createKeyAttestationVerifier>;

/** Production callers always use Google's pinned roots and status list. Only synthetic tests construct another. */
export const verifyKeyAttestation = createKeyAttestationVerifier(ROOTS, () => revokedSerials);
