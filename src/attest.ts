// Apple App Attest: proves a sign-up comes from a genuine Bipe app on a real Apple device.
// Verification follows Apple's "Validating apps that connect to your server" (attestation steps 1 to 9).
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "./errors.js";

const ROOT = new X509Certificate(
  readFileSync(fileURLToPath(new URL("../certs/apple-app-attestation-root-ca.pem", import.meta.url))),
);
// OID 1.2.840.113635.100.8.2: the nonce extension in the credential certificate.
const NONCE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop");
const CHALLENGE_TTL_MS = 5 * 60_000;

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

// Single-use challenges in memory (one API instance, like the rate limits).
const challenges = new Map<string, number>();

export function newChallenge(): string {
  const now = Date.now();
  if (challenges.size > 10_000) for (const [c, exp] of challenges) if (exp <= now) challenges.delete(c);
  const challenge = randomBytes(32).toString("base64url");
  challenges.set(challenge, now + CHALLENGE_TTL_MS);
  return challenge;
}

function takeChallenge(challenge: string): boolean {
  const exp = challenges.get(challenge);
  challenges.delete(challenge);
  return exp !== undefined && exp > Date.now();
}

export interface Attestation {
  key_id: string; // base64, from DCAppAttestService.generateKey
  attestation_object: string; // base64, from attestKey(_:clientDataHash:)
  challenge: string; // from POST /v1/attest/challenge; the app hashes its UTF-8 bytes as clientDataHash
}

/** Throws ApiError("attestation_invalid") unless the attestation is genuine for one of the app IDs. */
export function verifyAttestation(att: Attestation, appIds: string[]): void {
  const fail = (step: string): never => {
    // Step name only: attestation data is not secret but is large and device-specific.
    console.error(`app attest: failed at ${step}`);
    throw new ApiError("attestation_invalid");
  };
  if (!takeChallenge(att.challenge)) fail("challenge");

  let obj: Map<string, unknown>;
  try {
    obj = decodeCbor(Buffer.from(att.attestation_object, "base64")) as Map<string, unknown>;
  } catch {
    return fail("cbor");
  }
  if (obj.get("fmt") !== "apple-appattest") fail("fmt");
  const stmt = obj.get("attStmt") as Map<string, unknown> | undefined;
  const x5c = stmt?.get("x5c") as Buffer[] | undefined;
  const authData = obj.get("authData") as Buffer | undefined;
  if (!x5c || x5c.length < 2 || !Buffer.isBuffer(authData)) return fail("structure");

  // 1. Certificate chain: credential cert <- intermediate <- Apple App Attestation Root CA.
  let cred: X509Certificate, inter: X509Certificate;
  try {
    cred = new X509Certificate(x5c[0]!);
    inter = new X509Certificate(x5c[1]!);
  } catch {
    return fail("certificates");
  }
  const now = new Date();
  for (const c of [cred, inter]) if (new Date(c.validFrom) > now || new Date(c.validTo) < now) fail("validity");
  if (!cred.checkIssued(inter) || !cred.verify(inter.publicKey)) fail("chain-leaf");
  if (!inter.checkIssued(ROOT) || !inter.verify(ROOT.publicKey)) fail("chain-root");

  // 2-4. Nonce = SHA256(authData || SHA256(challenge)) must equal the certificate extension value.
  const clientDataHash = sha256(Buffer.from(att.challenge, "utf8"));
  const nonce = sha256(authData, clientDataHash);
  const extNonce = extensionNonce(cred.raw);
  if (!extNonce || !extNonce.equals(nonce)) fail("nonce");

  // 5. Key ID = SHA256 of the credential public key (uncompressed EC point).
  const jwk = cred.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) return fail("public-key");
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const keyId = Buffer.from(att.key_id, "base64");
  if (!sha256(point).equals(keyId)) fail("key-id");

  // 6. RP ID hash = SHA256(appId) for one of our App IDs (TEAMID.bundleid).
  const rpIdHash = authData.subarray(0, 32);
  if (!appIds.some((id) => sha256(Buffer.from(id)).equals(rpIdHash))) fail("app-id");

  // 7. Counter is 0 on attestation.
  if (authData.readUInt32BE(33) !== 0) fail("counter");

  // 8. AAGUID: production or development App Attest environment.
  const aaguid = authData.subarray(37, 53);
  if (!aaguid.equals(AAGUID_PRODUCTION) && !aaguid.equals(AAGUID_DEVELOPMENT)) fail("aaguid");

  // 9. Credential ID equals the key ID.
  const credLen = authData.readUInt16BE(53);
  if (!authData.subarray(55, 55 + credLen).equals(keyId)) fail("credential-id");
}

// The extension value is DER: SEQUENCE { [1] { OCTET STRING (32 bytes) } }. Take the 32-byte OCTET STRING after the OID.
function extensionNonce(der: Buffer): Buffer | null {
  const at = der.indexOf(NONCE_OID);
  if (at < 0) return null;
  const marker = der.indexOf(Buffer.from([0x04, 0x20]), at + NONCE_OID.length);
  if (marker < 0 || marker > at + 64) return null;
  return der.subarray(marker + 2, marker + 34);
}

// Minimal CBOR decoder for the attestation object: maps, arrays, byte and text strings, unsigned ints.
function decodeCbor(buf: Buffer): unknown {
  let pos = 0;
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf.readUInt8(pos++);
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    throw new Error("cbor: unsupported length");
  };
  const item = (depth: number): unknown => {
    if (depth > 8 || pos >= buf.length) throw new Error("cbor: depth");
    const head = buf.readUInt8(pos++);
    const major = head >> 5, len = readLen(head & 0x1f);
    switch (major) {
      case 0: return len;
      case 2: { const v = buf.subarray(pos, pos + len); pos += len; if (v.length !== len) throw new Error("cbor: short"); return Buffer.from(v); }
      case 3: { const v = buf.toString("utf8", pos, pos + len); pos += len; return v; }
      case 4: return Array.from({ length: len }, () => item(depth + 1));
      case 5: { const m = new Map<unknown, unknown>(); for (let i = 0; i < len; i++) m.set(item(depth + 1), item(depth + 1)); return m; }
      default: throw new Error("cbor: unsupported type");
    }
  };
  return item(0);
}
