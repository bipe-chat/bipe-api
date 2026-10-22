// gov.br signed challenge (bipe#543). Synthetic CA, signer and PDF only; no real person's data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { webcrypto } from "node:crypto";
import * as asn1 from "asn1js";
import * as pki from "pkijs";
import { challengePdf, checkSignedPdf, containsCode, personOf, validCpf } from "../dist/govbr.js";

pki.setEngine("node", new pki.CryptoEngine({ name: "node", crypto: webcrypto }));
const key = () => webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
let serial = 1;

async function certificate(name, keys, issuer, ca) {
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
  await cert.sign(issuer?.keys.privateKey ?? keys.privateKey, "SHA-256");
  return { cert, keys };
}

// 529.982.247-25 is the textbook valid CPF used in examples; it belongs to no one in these tests.
const CPF = "52998224725";
const CODE = "7KQ-4MZ";
const root = await certificate("Synthetic gov.br root", await key(), null, true);
const intermediate = await certificate("Synthetic AC Final", await key(), root, true);
const signer = await certificate(`FULANA DE TAL:${CPF}`, await key(), intermediate, false);
const otherRoot = await certificate("Other root", await key(), null, true);
const NOW = new Date("2026-10-21T12:00:00Z");

/** The challenge PDF plus a signature dictionary over the whole file, like an incremental update. */
async function signedPdf(base = challengePdf("@fulana", CODE, NOW)) {
  const hexLen = 16384;
  const ph = "0000000000";
  let text = base.toString("latin1") + `8 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 ${ph} ${ph} ${ph}] /Contents <${"0".repeat(hexLen)}> >>\nendobj\n%%EOF\n`;
  const b = text.indexOf("/Contents <") + "/Contents ".length;
  const c = b + hexLen + 2;
  const d = text.length - c;
  const pad = (n) => String(n).padEnd(ph.length, " ");
  text = text.replace(`[0 ${ph} ${ph} ${ph}]`, `[0 ${pad(b)} ${pad(c)} ${pad(d)}]`);
  const pdf = Buffer.from(text, "latin1");
  const data = Buffer.concat([pdf.subarray(0, b), pdf.subarray(c)]);
  const sd = new pki.SignedData({
    version: 1,
    encapContentInfo: new pki.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" }),
    signerInfos: [new pki.SignerInfo({
      version: 1,
      sid: new pki.IssuerAndSerialNumber({ issuer: signer.cert.issuer, serialNumber: signer.cert.serialNumber }),
    })],
    certificates: [signer.cert, intermediate.cert],
  });
  await sd.sign(signer.keys.privateKey, 0, "SHA-256", data);
  const der = Buffer.from(new pki.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: sd.toSchema(true) }).toSchema().toBER(false));
  const hex = der.toString("hex").padEnd(hexLen, "0");
  return Buffer.from(text.slice(0, b + 1) + hex + text.slice(c - 1), "latin1");
}

test("the challenge PDF holds the code in the text and in /Keywords", () => {
  const text = challengePdf("@fulana", CODE, NOW).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.includes(`(C\\363digo: ${CODE})`));
  assert.ok(text.includes(`/Keywords (bipe-govbr:${CODE})`));
  assert.ok(text.includes("@fulana"));
  assert.ok(text.includes("21/10/2026"));
});

test("an unsigned PDF is not_signed", async () => {
  assert.deepEqual(await checkSignedPdf(challengePdf("@fulana", CODE, NOW), [root.cert], NOW), { ok: false, reason: "not_signed" });
  assert.deepEqual(await checkSignedPdf(Buffer.from("not a pdf"), [root.cert], NOW), { ok: false, reason: "not_signed" });
});

test("a signed challenge passes, holds the code and gives name and CPF", async () => {
  const result = await checkSignedPdf(await signedPdf(), [root.cert], NOW);
  assert.equal(result.ok, true);
  assert.ok(containsCode(result.signed, CODE));
  assert.ok(!containsCode(result.signed, "ABC-DEF"));
  assert.deepEqual(personOf(result.cert), { name: "FULANA DE TAL", cpf: CPF });
});

test("bytes added after signing are changed_after_signing", async () => {
  const pdf = Buffer.concat([await signedPdf(), Buffer.from("9 0 obj\n<< >>\nendobj\n")]);
  assert.deepEqual(await checkSignedPdf(pdf, [root.cert], NOW), { ok: false, reason: "changed_after_signing" });
});

test("a changed byte inside the signed range is changed_after_signing", async () => {
  const pdf = Buffer.from((await signedPdf()).toString("latin1").replace("Data:", "Dada:"), "latin1");
  assert.deepEqual(await checkSignedPdf(pdf, [root.cert], NOW), { ok: false, reason: "changed_after_signing" });
});

test("a signature from another chain is not_govbr", async () => {
  assert.deepEqual(await checkSignedPdf(await signedPdf(), [otherRoot.cert], NOW), { ok: false, reason: "not_govbr" });
});

test("the code is found inside a Flate stream", () => {
  const stream = deflateSync(Buffer.from(`BT (bipe-govbr:${CODE}) Tj ET`));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), stream, Buffer.from("\nendstream\nendobj\n")]);
  assert.ok(containsCode(pdf, CODE));
});

test("CPF check digits", () => {
  assert.ok(validCpf(CPF));
  assert.ok(!validCpf("52998224726"));
  assert.ok(!validCpf("11111111111"));
  assert.ok(!validCpf("123"));
});
