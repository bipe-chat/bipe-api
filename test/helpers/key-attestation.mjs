// Synthetic Android Key Attestation chains only. Never accepted by the production verifier's Google roots.
import { createHash, webcrypto, X509Certificate } from "node:crypto";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { newChallenge } from "../../dist/attest.js";

pki.setEngine("node", new pki.CryptoEngine({ name: "node", crypto: webcrypto }));
const key = () => webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
let serial = 1000;
const buf = (bytes) => Uint8Array.from(bytes).buffer;

async function certificate(name, keys, issuer, ca, extension) {
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
  if (extension) cert.extensions.push(new pki.Extension({ extnID: "1.3.6.1.4.1.11129.2.1.17", extnValue: extension }));
  await cert.sign(issuer?.keys.privateKey ?? keys.privateKey, "SHA-256");
  const der = Buffer.from(cert.toSchema(true).toBER(false));
  return { cert, keys, der, serial: new X509Certificate(der).serialNumber.toLowerCase().replace(/^0+(?=.)/, "") };
}

const tagged = (tagNumber, value) => new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [value] });

export const PACKAGE = "chat.bipe.app.next";
export const SIGNING_DIGEST = createHash("sha256").update("synthetic signing certificate").digest("hex");
export const BOOT_KEY = createHash("sha256").update("synthetic boot key").digest("hex");

function keyDescription({ challenge, security, packageName, digest, locked, bootState, bootKey, rootOfTrust }) {
  const appId = new asn1.Sequence({ value: [
    new asn1.Set({ value: [new asn1.Sequence({ value: [
      new asn1.OctetString({ valueHex: buf(Buffer.from(packageName)) }), new asn1.Integer({ value: 1 }),
    ] })] }),
    new asn1.Set({ value: [new asn1.OctetString({ valueHex: buf(Buffer.from(digest, "hex")) })] }),
  ] }).toBER(false);
  const hardware = rootOfTrust ? [tagged(704, new asn1.Sequence({ value: [
    new asn1.OctetString({ valueHex: buf(Buffer.from(bootKey, "hex")) }),
    new asn1.Boolean({ value: locked }),
    new asn1.Enumerated({ value: bootState }),
    new asn1.OctetString({ valueHex: buf(Buffer.alloc(32, 7)) }),
  ] }))] : [];
  return new asn1.Sequence({ value: [
    new asn1.Integer({ value: 300 }),
    new asn1.Enumerated({ value: security }),
    new asn1.Integer({ value: 300 }),
    new asn1.Enumerated({ value: security }),
    new asn1.OctetString({ valueHex: buf(Buffer.from(challenge, "utf8")) }),
    new asn1.OctetString({ valueHex: new ArrayBuffer(0) }),
    new asn1.Sequence({ value: [tagged(709, new asn1.OctetString({ valueHex: appId }))] }),
    new asn1.Sequence({ value: hardware }),
  ] }).toBER(false);
}

const root = await certificate("Synthetic Key Attestation root", await key(), null, true);
const otherRoot = await certificate("Synthetic other root", await key(), null, true);
export const syntheticRoot = new X509Certificate(root.der);

/** A chain leaf, intermediate, root. Options change one fact of the phone or the app. */
export async function keyAttestation({
  challenge = newChallenge(), boundChallenge = challenge, security = 1, packageName = PACKAGE, digest = SIGNING_DIGEST,
  locked = true, bootState = 0, bootKey = createHash("sha256").update("stock boot key").digest("hex"), rootOfTrust = true,
  trustRoot = root, breakChain = false,
} = {}) {
  const intermediate = await certificate("Synthetic attestation issuer", await key(), trustRoot, true);
  const leafIssuer = breakChain ? await certificate("Synthetic stranger", await key(), trustRoot, true) : intermediate;
  const extension = keyDescription({ challenge: boundChallenge, security, packageName, digest, locked, bootState, bootKey, rootOfTrust });
  const leaf = await certificate("Android Keystore Key", await key(), leafIssuer, false, extension);
  return {
    proof: { challenge, key_attestation_chain: [leaf.der, intermediate.der, trustRoot.der].map((d) => d.toString("base64")) },
    serials: { leaf: leaf.serial, intermediate: intermediate.serial },
  };
}

export { otherRoot };
