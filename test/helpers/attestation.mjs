// Synthetic CA and app data only. Never accepted by the production verifier's Apple trust root.
import { createHash, webcrypto, X509Certificate } from "node:crypto";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { newChallenge } from "../../dist/attest.js";

pki.setEngine("node", new pki.CryptoEngine({ name: "node", crypto: webcrypto }));
const sha = (value) => createHash("sha256").update(value).digest();
const key = () => webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
let serial = 1;

async function certificate(name, keys, issuer, ca, nonce) {
  const cert = new pki.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1.Integer({ value: serial++ });
  cert.subject.typesAndValues.push(new pki.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1.Utf8String({ value: name }) }));
  cert.issuer = issuer?.cert.subject ?? cert.subject;
  cert.notBefore.value = new Date("2020-01-01T00:00:00Z");
  cert.notAfter.value = new Date("2040-01-01T00:00:00Z");
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  cert.extensions = [new pki.Extension({
    extnID: "2.5.29.19", critical: true,
    extnValue: new pki.BasicConstraints({ cA: ca }).toSchema().toBER(false),
  })];
  if (nonce) cert.extensions.push(new pki.Extension({
    extnID: "1.2.840.113635.100.8.2",
    extnValue: new asn1.Sequence({ value: [new asn1.Constructed({
      idBlock: { tagClass: 3, tagNumber: 1 },
      value: [new asn1.OctetString({ valueHex: Uint8Array.from(nonce).buffer })],
    })] }).toBER(false),
  }));
  await cert.sign(issuer?.keys.privateKey ?? keys.privateKey, "SHA-256");
  return { cert, keys, der: Buffer.from(cert.toSchema(true).toBER(false)) };
}

const root = await certificate("Synthetic App Attest root", await key(), null, true);
const intermediate = await certificate("Synthetic App Attest issuer", await key(), root, true);
const leafKeys = await key();
export const syntheticRoot = new X509Certificate(root.der);
export const APP_ID = "TESTTEAM01.chat.bipe.app.dev";

function cbor(value) {
  const size = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const bytes = Buffer.alloc(3); bytes[0] = (major << 5) | 25; bytes.writeUInt16BE(n, 1); return bytes;
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([size(2, value.length), value]);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([size(3, bytes.length), bytes]); }
  if (Array.isArray(value)) return Buffer.concat([size(4, value.length), ...value.map(cbor)]);
  const entries = Object.entries(value);
  return Buffer.concat([size(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

export async function attestation({ environment = "production", appId = APP_ID, challenge = newChallenge(), nonceChallenge = challenge } = {}) {
  const jwk = await webcrypto.subtle.exportKey("jwk", leafKeys.publicKey);
  const keyId = sha(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));
  const aaguid = environment === "production" ? Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]) : Buffer.from("appattestdevelop");
  const length = Buffer.alloc(2); length.writeUInt16BE(keyId.length);
  const authData = Buffer.concat([sha(Buffer.from(appId)), Buffer.from([0x41]), Buffer.alloc(4), aaguid, length, keyId]);
  const nonce = sha(Buffer.concat([authData, sha(Buffer.from(nonceChallenge))]));
  const leaf = await certificate("Synthetic App Attest key", leafKeys, intermediate, false, nonce);
  return {
    key_id: keyId.toString("base64"),
    challenge,
    attestation_object: cbor({ fmt: "apple-appattest", attStmt: { x5c: [leaf.der, intermediate.der] }, authData }).toString("base64"),
  };
}
