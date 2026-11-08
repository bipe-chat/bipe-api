import { readFileSync } from "node:fs";
import { request } from "node:https";
import type { CapacitySample } from "./capacity.js";

// Capacity probe (ADR 0285, bipe#1312). The CronJob bipe-capacity (bipe-infra k8s/bipe/capacity.yaml) runs
// `node dist/capacity-probe.js` every 5 minutes in the bipe-api image. It reads the Kubernetes API with its read-only
// ServiceAccount and posts one sample to bipe-api. It does not load the API config: it needs only these variables.
//   CAPACITY_SAMPLE_URL   e.g. http://bipe-api.ess.svc:8080/internal/v1/capacity/sample
//   BIPE_INTERNAL_SECRET  the shared secret of the internal routes
//   CAPACITY_NAMESPACE    namespace for pod memory and OOM kills (default ess)
//   NODE_NAME             the node to read (default: the first node)

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const API = `https://${process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc"}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;
const ca = readFileSync(`${SA}/ca.crt`);
const token = readFileSync(`${SA}/token`, "utf8").trim();

function kube<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(`${API}${path}`, { ca, headers: { authorization: `Bearer ${token}`, accept: "application/json" }, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`${path.split("?")[0]}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${path}: timeout`)));
    req.on("error", reject);
    req.end();
  });
}

const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50,
};

/** A Kubernetes quantity ("250m", "1234Ki", "2") as a number of base units. */
function quantity(q: string): number {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q.trim());
  const f = m ? SUFFIX[m[2]!] : undefined;
  if (!m || f === undefined) throw new Error(`bad quantity ${q}`);
  return Number(m[1]) * f;
}
const milli = (q: string) => Math.round(quantity(q) * 1000);
const whole = (q: string) => Math.round(quantity(q));

type Meta = { metadata: { name: string; namespace?: string } };
type Node = Meta & { status: { allocatable: { cpu: string; memory: string } } };
type Usage = { cpu: string; memory: string };
type Summary = {
  node: { fs?: { usedBytes?: number; capacityBytes?: number } };
  pods?: { volume?: { pvcRef?: { name: string; namespace: string }; usedBytes?: number; capacityBytes?: number }[] }[];
};
type Pod = Meta & { status: { containerStatuses?: { name: string; lastState?: { terminated?: { reason?: string; finishedAt?: string } } }[] } };

async function sample(): Promise<CapacitySample> {
  const ns = process.env.CAPACITY_NAMESPACE ?? "ess";
  const nodes = await kube<{ items: Node[] }>("/api/v1/nodes");
  const node = nodes.items.find((n) => n.metadata.name === process.env.NODE_NAME) ?? nodes.items[0];
  if (!node) throw new Error("no node");
  const name = encodeURIComponent(node.metadata.name);
  const [usage, summary, podMetrics, pods] = await Promise.all([
    kube<{ usage: Usage }>(`/apis/metrics.k8s.io/v1beta1/nodes/${name}`),
    kube<Summary>(`/api/v1/nodes/${name}/proxy/stats/summary`),
    kube<{ items: (Meta & { containers: { usage: Usage }[] })[] }>(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`),
    kube<{ items: Pod[] }>(`/api/v1/namespaces/${ns}/pods`),
  ]);
  const volumes = new Map<string, CapacitySample["volumes"][number]>();
  for (const p of summary.pods ?? []) for (const v of p.volume ?? []) {
    if (!v.pvcRef || !v.capacityBytes) continue;
    volumes.set(`${v.pvcRef.namespace}/${v.pvcRef.name}`, { namespace: v.pvcRef.namespace, name: v.pvcRef.name, used: v.usedBytes ?? 0, capacity: v.capacityBytes });
  }
  const ooms: CapacitySample["ooms"] = [];
  for (const p of pods.items) for (const c of p.status.containerStatuses ?? []) {
    const t = c.lastState?.terminated;
    if (t?.reason === "OOMKilled" && t.finishedAt) ooms.push({ namespace: ns, pod: p.metadata.name, container: c.name, finished_at: t.finishedAt });
  }
  return {
    node: {
      name: node.metadata.name,
      cpu_used: milli(usage.usage.cpu),
      cpu_allocatable: milli(node.status.allocatable.cpu),
      memory_used: whole(usage.usage.memory),
      memory_allocatable: whole(node.status.allocatable.memory),
      fs_used: summary.node.fs?.usedBytes ?? 0,
      fs_capacity: summary.node.fs?.capacityBytes ?? 1,
    },
    volumes: [...volumes.values()],
    pods: podMetrics.items.map((p) => ({ namespace: ns, name: p.metadata.name, memory: p.containers.reduce((sum, c) => sum + whole(c.usage.memory), 0) })),
    ooms,
  };
}

const url = process.env.CAPACITY_SAMPLE_URL;
const secret = process.env.BIPE_INTERNAL_SECRET;
if (!url || !secret) {
  console.error("capacity probe: CAPACITY_SAMPLE_URL and BIPE_INTERNAL_SECRET are required");
  process.exit(1);
}
const body = await sample();
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-bipe-internal": secret }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`capacity probe: bipe-api answered HTTP ${res.status}`);
  process.exit(1);
}
const mem = Math.round((body.node.memory_used / body.node.memory_allocatable) * 100);
const fs = Math.round((body.node.fs_used / body.node.fs_capacity) * 100);
console.log(`capacity probe: memory ${mem}%, disk ${fs}%, ${body.volumes.length} volumes, ${body.ooms.length} OOM records`);
