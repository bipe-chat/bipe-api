// Signed lists: the operator list and the issuer registry (docs/signed-lists.md, bipe-chat/bipe#645, bipe-chat/bipe#637).
// Reference for the verification order. Fail closed: any error means the caller keeps its stored list.
import { createHash, createPublicKey, verify } from "node:crypto";

const MAX_TIME = 253402300799;
const LEVELS = ["pix", "govbr", "institution", "cnpj", "brand-mark", "person", "org"];
const MALFORMED = Symbol("malformed");
const text = (v) => typeof v === "string" && v.length > 0;
const object = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const need = (ok) => { if (!ok) throw MALFORMED; };

export const b64urlDecode = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s, "base64url");
};
const b64url = (b) => Buffer.from(b).toString("base64url");

/** The value of prev in the next list: SHA-256 of the exact payload bytes of this list. */
export const listHash = (payloadBytes) => b64url(createHash("sha256").update(payloadBytes).digest());

function validSignature(publicKey, bytes, sig) {
  const raw = b64urlDecode(sig);
  if (!raw || raw.length !== 64) return false;
  try {
    return verify(null, bytes, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), raw);
  } catch {
    return false;
  }
}

function keyMap(keys, seen) {
  need(object(keys) && Object.keys(keys).length > 0);
  for (const [kid, key] of Object.entries(keys)) {
    need(text(kid) && !seen.has(kid));
    seen.add(kid);
    const raw = b64urlDecode(key);
    need(raw && raw.length === 32);
  }
}

function regionRecord(r) {
  need(object(r) && typeof r.id === "string" && /^[a-z]{2,}$/.test(r.id) && text(r.name));
  need(typeof r.core_api === "string" && r.core_api.startsWith("https://"));
  need(r.floor === "e2ee" || r.floor === "none");
}

function operatorsWellFormed(p) {
  regionRecord(p.region);
  need(Array.isArray(p.regions));
  p.regions.forEach(regionRecord);
  need(new Set([p.region.id, ...p.regions.map((r) => r.id)]).size === p.regions.length + 1);
  need(Array.isArray(p.operators));
  const servers = new Set();
  const reportKids = new Set();
  keyMap(p.appeal_keys, reportKids);
  for (const o of p.operators) {
    need(object(o) && text(o.server_name) && o.server_name === o.server_name.toLowerCase() && !servers.has(o.server_name));
    servers.add(o.server_name);
    need(text(o.name) && date(o.joined));
    if (o.status === "removed") {
      need(date(o.removed));
      need(["signing_keys", "account_api", "push_egress", "signup", "report_keys"].every((k) => !(k in o)));
    } else {
      need(o.status === "valid");
      need(object(o.signing_keys) && Object.keys(o.signing_keys).length > 0);
      need(typeof o.account_api === "string" && o.account_api.startsWith("https://"));
      need(Array.isArray(o.push_egress) && o.push_egress.length > 0 && o.push_egress.every(text));
      need(["open", "invite", "closed"].includes(o.signup));
      keyMap(o.report_keys, reportKids);
    }
  }
}

function issuersWellFormed(p) {
  need(Array.isArray(p.schemes) && Array.isArray(p.regions) && Array.isArray(p.issuers));
  const schemes = new Map();
  for (const s of p.schemes) {
    need(object(s) && typeof s.id === "string" && /^[a-z]{2}\.[a-z0-9-]{1,30}$/.test(s.id) && !schemes.has(s.id));
    need(typeof s.country === "string" && /^[A-Z]{2}$/.test(s.country) && (s.class === "person" || s.class === "org") && text(s.assurance));
    schemes.set(s.id, s);
  }
  const regions = new Map();
  const servers = new Set();
  const owned = new Set();
  for (const r of p.regions) {
    need(object(r) && typeof r.id === "string" && !regions.has(r.id) && Array.isArray(r.servers) && Array.isArray(r.schemes));
    regions.set(r.id, r);
    for (const s of r.servers) { need(text(s) && !servers.has(s)); servers.add(s); }
    for (const id of r.schemes) { need(schemes.has(id) && !owned.has(id)); owned.add(id); }
  }
  const ids = new Set();
  const kids = new Set();
  for (const i of p.issuers) {
    need(object(i) && typeof i.id === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(i.id) && !ids.has(i.id));
    ids.add(i.id);
    need(text(i.name) && date(i.accredited));
    if (i.status === "removed") {
      need(date(i.removed));
      need(["region", "levels", "schemes", "keys"].every((k) => !(k in i)));
      continue;
    }
    need(i.status === "valid" && regions.has(i.region));
    need(Array.isArray(i.levels) && i.levels.length > 0 && i.levels.every((l) => LEVELS.includes(l)));
    need(Array.isArray(i.schemes) && i.schemes.length > 0 && i.schemes.every((id) => regions.get(i.region).schemes.includes(id)));
    const held = i.schemes.map((id) => schemes.get(id));
    for (const level of i.levels) {
      if (level === "person" || level === "org") need(held.some((s) => s.class === level));
      else if ([...schemes.values()].some((s) => s.alias === level)) need(held.some((s) => s.alias === level));
    }
    keyMap(i.keys, kids);
  }
}

function wellFormed(p) {
  const time = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_TIME;
  need(Number.isInteger(p.version) && p.version >= 1 && p.version <= Number.MAX_SAFE_INTEGER);
  need(time(p.issued) && time(p.expires));
  if (p.version === 1) need(p.prev === null);
  else need(typeof p.prev === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.prev));
  if (p.typ === "operators") operatorsWellFormed(p);
  else issuersWellFormed(p);
}

/** docs/signed-lists.md "Verification order". stored: {version, payload} or null. Returns {error} or {payload, bytes}. */
export function verifySignedList(envelope, { typ, signerSet, now, stored = null }) {
  if (!object(envelope) || envelope.v !== 1) return { error: "unsupported_version" };
  const bytes = b64urlDecode(envelope.payload);
  const signers = new Set();
  if (bytes && Array.isArray(envelope.sigs)) {
    for (const s of envelope.sigs) {
      const key = object(s) && Object.hasOwn(signerSet.keys, s.kid) ? signerSet.keys[s.kid] : null;
      if (key && validSignature(key, bytes, s.sig)) signers.add(s.kid);
    }
  }
  if (signers.size < signerSet.threshold) return { error: "invalid_signature" };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: "malformed" };
  }
  if (!object(payload) || payload.typ !== typ) return { error: "wrong_type" };
  try {
    wellFormed(payload);
  } catch (e) {
    if (e === MALFORMED) return { error: "malformed" };
    throw e;
  }
  if (now >= payload.expires) return { error: "expired" };
  if (stored) {
    if (payload.version < stored.version) return { error: "rolled_back" };
    if (payload.version === stored.version && envelope.payload !== stored.payload) return { error: "rolled_back" };
    if (payload.version === stored.version + 1 && payload.prev !== listHash(b64urlDecode(stored.payload))) return { error: "broken_chain" };
  }
  return { payload, bytes };
}

/** The rule "who is a Bipe user": valid, removed or unknown, for a server name in a valid operator list. */
export const operatorStatus = (payload, server) => payload.operators.find((o) => o.server_name === server)?.status ?? "unknown";

/** The ids of the regions that federate: the floor is e2ee. A region with floor none runs alone (ADR 0197). */
export const federatedRegions = (payload) => [payload.region, ...payload.regions].filter((r) => r.floor === "e2ee").map((r) => r.id);
