import { readFileSync } from "node:fs";
import { request } from "node:https";
import { signers, verifySignedList } from "./signed-lists.js";

// Federation allowlist (bipe#645 step 3, bipe-shared docs/signed-lists.md "Homeservers and the core edge"). The CronJob
// bipe-federation-allowlist (bipe-infra k8s/bipe/federation-allowlist.yaml) runs `node dist/allowlist-job.js` every
// 10 minutes in the bipe-api image. It fetches the operator list from the core, verifies it against the version it
// stored, and renders Synapse `federation_domain_whitelist` into Secret bipe-federation-allowlist. Synapse reads that
// Secret as extra config (bipe-infra ess/production.yaml). Synapse reads config only at start, so the job restarts
// Synapse when the rendered list changes. It does not load the API config: it needs only these variables.
//   LIST_URL            the core's operator list (default https://api.bipe.net.br/v1/operators)
//   SERVER_NAME         this homeserver's server name. It is left out of the list: Synapse never federates with itself
//   ALLOWLIST_SECRET    Secret that holds `operators.json` (the stored envelope) and `federation.yaml` (default bipe-federation-allowlist)
//   SYNAPSE_NAME        the Synapse workload to restart (default ess-synapse-main, a StatefulSet or a Deployment)
// A rejected list keeps the stored list and the rendered config: a stale or failed fetch never cuts federation and never
// adds a server (signed-lists.md "Stale list on a server"). The job then exits 1, so the failed Job is the alert.

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const API = `https://${process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc"}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;
const LIST_URL = process.env.LIST_URL ?? "https://api.bipe.net.br/v1/operators";
const SECRET = process.env.ALLOWLIST_SECRET ?? "bipe-federation-allowlist";
const SYNAPSE = process.env.SYNAPSE_NAME ?? "ess-synapse-main";
const MAX_BYTES = 1 << 20;

type Reply = { status: number; body: string };

function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers, ca: options.ca, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) return req.destroy(new Error(`${url.split("?")[0]}: reply over ${MAX_BYTES} bytes`));
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error(`${url.split("?")[0]}: timeout`)));
    req.on("error", reject);
    req.end(options.body);
  });
}

const ca = () => readFileSync(`${SA}/ca.crt`);
const token = () => readFileSync(`${SA}/token`, "utf8").trim();
const namespace = () => readFileSync(`${SA}/namespace`, "utf8").trim();

function kube(path: string, method = "GET", patch?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { authorization: `Bearer ${token()}`, accept: "application/json" };
  if (patch !== undefined) headers["content-type"] = "application/merge-patch+json";
  return call(`${API}${path}`, { method, headers, body: patch === undefined ? undefined : JSON.stringify(patch), ca: ca() });
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string | undefined) => Buffer.from(s ?? "", "base64").toString("utf8");

/** The Synapse config for these server names. JSON is valid YAML, and it quotes every name. */
export function renderAllowlist(names: string[]): string {
  return "# Rendered by bipe-api allowlist-job from the signed operator list (bipe#645). Do not edit.\n" +
    `federation_domain_whitelist: ${JSON.stringify(names)}\n`;
}

/** The server names in rendered config, or null when it has none (a new or hand-made Secret). */
export function renderedServers(config: string): string[] | null {
  const line = /^federation_domain_whitelist: (\[.*\])$/m.exec(config);
  if (!line) return null;
  try {
    const names: unknown = JSON.parse(line[1]!);
    return Array.isArray(names) && names.every((n) => typeof n === "string") ? names : null;
  } catch {
    return null;
  }
}

/** The `valid` server names of a verified operator list, without this server, sorted. */
export function allowedServers(operators: { server_name: string; status: string }[], self: string): string[] {
  return operators.filter((o) => o.status === "valid" && o.server_name !== self).map((o) => o.server_name).sort();
}

async function restartSynapse(ns: string): Promise<void> {
  const patch = { spec: { template: { metadata: { annotations: { "bipe.chat/allowlist-restarted-at": new Date().toISOString() } } } } };
  for (const kind of ["statefulsets", "deployments"]) {
    const res = await kube(`/apis/apps/v1/namespaces/${ns}/${kind}/${SYNAPSE}`, "PATCH", patch);
    if (res.status === 200) return console.log(`allowlist: restarted ${kind}/${SYNAPSE}`);
    if (res.status !== 404) throw new Error(`restart ${kind}/${SYNAPSE}: HTTP ${res.status}`);
  }
  throw new Error(`no StatefulSet or Deployment ${SYNAPSE}`);
}

async function main(): Promise<number> {
  const self = process.env.SERVER_NAME;
  if (!self) throw new Error("SERVER_NAME is not set");
  const ns = namespace();
  const secretPath = `/api/v1/namespaces/${ns}/secrets/${SECRET}`;
  const current = await kube(secretPath);
  if (current.status !== 200) throw new Error(`read Secret ${SECRET}: HTTP ${current.status}`);
  const data = (JSON.parse(current.body) as { data?: Record<string, string> }).data ?? {};
  const storedText = unb64(data["operators.json"]);
  const renderedNow = unb64(data["federation.yaml"]);
  let stored: { version: number; payload: string } | null = null;
  if (storedText) {
    const payload = (JSON.parse(storedText) as { payload: string }).payload;
    stored = { version: (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { version: number }).version, payload };
  }

  const fetched = await call(LIST_URL, { headers: { accept: "application/json" } });
  if (fetched.status !== 200) {
    console.error(`allowlist: kept version ${stored?.version ?? "none"}: ${LIST_URL} answered HTTP ${fetched.status}`);
    return 1;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(fetched.body);
  } catch {
    console.error(`allowlist: kept version ${stored?.version ?? "none"}: the list is not JSON`);
    return 1;
  }
  const checked = verifySignedList(envelope, { typ: "operators", signerSet: signers, now: Math.floor(Date.now() / 1000), stored });
  if (checked.error || !checked.payload?.operators) {
    console.error(`allowlist: kept version ${stored?.version ?? "none"}: ${checked.error ?? "malformed"}`);
    return 1;
  }

  const names = allowedServers(checked.payload.operators, self);
  const rendered = renderAllowlist(names);
  const version = checked.payload.version;
  // Synapse restarts only when the names change, not for a new version with the same servers or a new comment.
  const namesChanged = JSON.stringify(renderedServers(renderedNow)) !== JSON.stringify(names);
  if (stored?.version === version && rendered === renderedNow) {
    console.log(`allowlist: version ${version}, no change (${names.length} other servers)`);
    return 0;
  }
  const patched = await kube(secretPath, "PATCH", { data: { "operators.json": b64(fetched.body), "federation.yaml": b64(rendered) } });
  if (patched.status !== 200) throw new Error(`write Secret ${SECRET}: HTTP ${patched.status}`);
  console.log(`allowlist: stored version ${version} (${names.length} other servers: ${names.join(", ") || "none"})`);
  if (namesChanged) await restartSynapse(ns);
  return 0;
}

if (process.argv[1]?.endsWith("allowlist-job.js")) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error(`allowlist: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
