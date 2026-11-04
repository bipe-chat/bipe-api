// Sealed reports across operators (docs/report-envelope.md, bipe-chat/bipe#697). The reference code for the
// envelope rules, the HPKE seal and open, and the media proof. Node built-ins only.
//
// HPKE is RFC 9180, base mode, single shot, suite DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305
// (kem 0x0020, kdf 0x0001, aead 0x0003). CryptoKit (HPKE.Ciphersuite.Curve25519_SHA256_ChachaPoly), Tink
// (DHKEM_X25519_HKDF_SHA256 / HKDF_SHA256 / CHACHA20_POLY1305) and this file implement the same suite.

import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";

export const REPORT_VERSION = 1;
export const HPKE_SUITE = { kem: 0x0020, kdf: 0x0001, aead: 0x0003 };
/** HPKE `info` for a report sealed to an operator, and for an appeal sealed to the associação. */
export const REPORT_INFO = { operator: "chat.bipe.report.v1", associacao: "chat.bipe.appeal.v1" };
export const REPORT_LIMITS = { reasonChars: 1000, events: 20, contextEvents: 20, mediaPerEvent: 10, bodyBytes: 1048576 };

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return Buffer.from(s, "base64url");
};
const i2osp = (n, len) => {
  const out = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) out[i] = n & 0xff;
  return out;
};

// --- HPKE (RFC 9180) ----------------------------------------------------------------------------------------

const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const privateKey = (sk) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, sk]), format: "der", type: "pkcs8" });
const publicKey = (pk) => createPublicKey({ key: Buffer.concat([X25519_SPKI, pk]), format: "der", type: "spki" });
const rawPublic = (sk) => createPublicKey(privateKey(sk)).export({ format: "der", type: "spki" }).subarray(12);

const KEM_ID = Buffer.concat([Buffer.from("KEM"), i2osp(HPKE_SUITE.kem, 2)]);
const SUITE_ID = Buffer.concat([Buffer.from("HPKE"), i2osp(HPKE_SUITE.kem, 2), i2osp(HPKE_SUITE.kdf, 2), i2osp(HPKE_SUITE.aead, 2)]);

const extract = (salt, ikm) => createHmac("sha256", salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
function expand(prk, info, length) {
  const blocks = [];
  let t = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    blocks.push(t);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, Buffer.concat([i2osp(length, 2), Buffer.from("HPKE-v1"), suite, Buffer.from(label), info]), length);

/** DeriveKeyPair of DHKEM(X25519): the private and public key, 32 bytes each, from input keying material. */
export function deriveKeyPair(ikm) {
  const prk = labeledExtract(KEM_ID, Buffer.alloc(0), "dkp_prk", Buffer.from(ikm));
  const sk = labeledExpand(KEM_ID, prk, "sk", Buffer.alloc(0), 32);
  return { sk, pk: rawPublic(sk) };
}

/** A fresh X25519 key pair, raw 32-byte keys. */
export function generateKeyPair() {
  const { privateKey: key } = generateKeyPairSync("x25519");
  const sk = key.export({ format: "der", type: "pkcs8" }).subarray(16);
  return { sk, pk: rawPublic(sk) };
}

function keySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(SUITE_ID, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(SUITE_ID, Buffer.alloc(0), "info_hash", Buffer.from(info));
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]);
  const secret = labeledExtract(SUITE_ID, sharedSecret, "secret", Buffer.alloc(0));
  return { key: labeledExpand(SUITE_ID, secret, "key", context, 32), nonce: labeledExpand(SUITE_ID, secret, "base_nonce", context, 12) };
}

function sharedSecret(dh, enc, pkR) {
  const prk = labeledExtract(KEM_ID, Buffer.alloc(0), "eae_prk", dh);
  return labeledExpand(KEM_ID, prk, "shared_secret", Buffer.concat([enc, pkR]), 32);
}

/**
 * Single-shot HPKE seal (base mode). `ephemeral` is for test vectors only: a sender always takes a fresh key.
 * Returns { enc, ct } as Buffers.
 */
export function seal(pkR, info, aad, plaintext, { ephemeral } = {}) {
  const e = ephemeral ?? generateKeyPair();
  const pk = Buffer.from(pkR);
  const dh = diffieHellman({ privateKey: privateKey(e.sk), publicKey: publicKey(pk) });
  const { key, nonce } = keySchedule(sharedSecret(dh, e.pk, pk), info);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc: Buffer.from(e.pk), ct };
}

/** Single-shot HPKE open (base mode). Throws when the tag does not verify. */
export function open(skR, enc, info, aad, ct) {
  const sk = Buffer.from(skR);
  const dh = diffieHellman({ privateKey: privateKey(sk), publicKey: publicKey(Buffer.from(enc)) });
  const { key, nonce } = keySchedule(sharedSecret(dh, Buffer.from(enc), rawPublic(sk)), info);
  if (ct.length < 16) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad), { plaintextLength: ct.length - 16 });
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
}

// --- Envelope ------------------------------------------------------------------------------------------------

const SERVER_NAME = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;
const USER_ID = /^@[^:\s]+:[a-z0-9.-]+(:[0-9]{1,5})?$/;
const ROOM_ID = /^![^:\s]+(:[a-z0-9.-]+(:[0-9]{1,5})?)?$/;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FLAGGER_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ENVELOPE_KEYS = new Set(["v", "report_id", "to", "kid", "category", "target_operator", "target_user", "target_room", "reporter", "flagger_id", "created"]);

/**
 * Checks a plain envelope against docs/report-envelope.md. Returns null when it is valid, else the error id.
 * `categories` is registries/report-categories.json.
 */
export function envelopeError(env, categories) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return "malformed";
  if (env.v !== REPORT_VERSION) return "unsupported_version";
  if (Object.keys(env).some((k) => !ENVELOPE_KEYS.has(k))) return "malformed";
  if (!REPORT_ID.test(env.report_id ?? "")) return "malformed";
  if (!(env.to in REPORT_INFO)) return "malformed";
  if (!KID.test(env.kid ?? "")) return "malformed";
  const category = categories.categories.find((c) => c.id === env.category);
  if (!category) return "unknown_category";
  if (!SERVER_NAME.test(env.target_operator ?? "")) return "malformed";
  if (env.target_user === undefined && env.target_room === undefined) return "no_target";
  if (env.target_user !== undefined && !USER_ID.test(env.target_user)) return "malformed";
  if (env.target_room !== undefined && !ROOM_ID.test(env.target_room)) return "malformed";
  if (env.target_user !== undefined && env.target_user.slice(env.target_user.indexOf(":") + 1) !== env.target_operator) return "wrong_operator";
  if (env.reporter === "user") {
    if (env.flagger_id !== undefined) return "malformed";
  } else if (env.reporter === "flagger") {
    if (!FLAGGER_ID.test(env.flagger_id ?? "")) return "malformed";
    if (!category.flaggerEligible) return "not_flagger_category";
  } else return "malformed";
  if (!Number.isInteger(env.created) || env.created <= 0) return "malformed";
  return null;
}

/** Seals a report body to a recipient key. Returns the wire object of docs/report-envelope.md. */
export function sealReport(envelope, body, pkR, { ephemeral } = {}) {
  const envBytes = Buffer.from(JSON.stringify(envelope), "utf8");
  const plain = Buffer.from(JSON.stringify(body), "utf8");
  if (plain.length > REPORT_LIMITS.bodyBytes) throw new Error("report body too large");
  const { enc, ct } = seal(pkR, REPORT_INFO[envelope.to], envBytes, plain, { ephemeral });
  return { v: REPORT_VERSION, envelope: b64url(envBytes), enc: b64url(enc), ct: b64url(ct) };
}

/**
 * Opens a sealed report with the recipient's private key. Returns { envelope, body } or { error }.
 * The envelope is checked before the body is opened; the HPKE tag binds the envelope bytes (AAD).
 */
export function openReport(sealed, skR, categories) {
  if (!sealed || sealed.v !== REPORT_VERSION) return { error: "unsupported_version" };
  let envBytes, envelope, enc, ct;
  try {
    envBytes = fromB64url(sealed.envelope);
    envelope = JSON.parse(envBytes.toString("utf8"));
    enc = fromB64url(sealed.enc);
    ct = fromB64url(sealed.ct);
  } catch {
    return { error: "malformed" };
  }
  if (enc.length !== 32) return { error: "malformed" };
  const error = envelopeError(envelope, categories);
  if (error) return { error };
  let plain;
  try {
    plain = open(skR, enc, REPORT_INFO[envelope.to], envBytes, ct);
  } catch {
    return { error: "cannot_open" };
  }
  let body;
  try {
    body = JSON.parse(plain.toString("utf8"));
  } catch {
    return { error: "malformed_body" };
  }
  const bodyError = reportBodyError(body);
  return bodyError ? { error: bodyError } : { envelope, body };
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Checks a sealed body after it opens. Returns null when it is valid, else "malformed_body". */
export function reportBodyError(body) {
  const bad = "malformed_body";
  if (!isObject(body)) return bad;
  const item = (e) => {
    if (!isObject(e) || !isObject(e.event) || typeof e.event.event_id !== "string" || typeof e.event.sender !== "string") return false;
    if (e.decrypted !== undefined && !isObject(e.decrypted)) return false;
    if (e.media !== undefined && (!Array.isArray(e.media) || e.media.length > REPORT_LIMITS.mediaPerEvent || e.media.some((m) => mediaError(m)))) return false;
    return true;
  };
  if (!Array.isArray(body.events) || !body.events.length || body.events.length > REPORT_LIMITS.events || !body.events.every(item)) return bad;
  if (body.context !== undefined && (!Array.isArray(body.context) || body.context.length > REPORT_LIMITS.contextEvents || !body.context.every(item))) return bad;
  if (body.reason !== undefined && (typeof body.reason !== "string" || [...body.reason].length > REPORT_LIMITS.reasonChars)) return bad;
  if (body.scores !== undefined && (!isObject(body.scores) || Object.entries(body.scores).some(([k, v]) => !/^[a-z][a-z0-9_]{0,31}$/.test(k) || typeof v !== "number" || v < 0 || v > 1))) return bad;
  return null;
}

// --- Media proof -------------------------------------------------------------------------------------------

/** A media item: the fields of a Matrix EncryptedFile that let the operator fetch and decrypt the file. */
export function mediaError(m) {
  if (!isObject(m) || typeof m.url !== "string" || !/^mxc:\/\/[^/]+\/[A-Za-z0-9_-]+$/.test(m.url)) return "malformed";
  if (typeof m.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(m.key)) return "malformed";
  if (typeof m.iv !== "string" || !/^[A-Za-z0-9+/]{22}$/.test(m.iv)) return "malformed";
  if (typeof m.sha256 !== "string" || !/^[A-Za-z0-9+/]{43}$/.test(m.sha256)) return "malformed";
  return null;
}

/**
 * Checks a media proof: the SHA-256 of the ciphertext the operator downloaded equals `sha256`, and the file
 * decrypts with AES-256-CTR (Matrix attachments v2). Returns { plaintext } or { error: "hash_mismatch" }.
 */
export function verifyMedia(m, ciphertext) {
  if (mediaError(m)) return { error: "malformed" };
  const hash = createHash("sha256").update(ciphertext).digest("base64").replace(/=+$/, "");
  if (hash !== m.sha256) return { error: "hash_mismatch" };
  const decipher = createDecipheriv("aes-256-ctr", Buffer.from(m.key, "base64url"), Buffer.from(m.iv, "base64"));
  return { plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]) };
}

/** Encrypts a file as a Matrix attachment (for test vectors). Returns { ciphertext, media }. */
export function encryptMedia(plaintext, { key, iv, url }) {
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sha256 = createHash("sha256").update(ciphertext).digest("base64").replace(/=+$/, "");
  return { ciphertext, media: { url, key: b64url(key), iv: iv.toString("base64").replace(/=+$/, ""), sha256 } };
}

export { b64url, fromB64url, randomBytes };
