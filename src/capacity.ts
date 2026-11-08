import { z } from "zod";
import type { Db } from "./db.js";
import { cell, MIN_CELL } from "./staff-report.js";

// Capacity of the node (ADR 0285, bipe#1312). The probe CronJob (src/capacity-probe.ts) reads metrics-server and the
// kubelet stats summary and posts one sample every 5 minutes to /internal/v1/capacity/sample. Machine numbers only.

export const CAPACITY_SAMPLE_PATH = "/internal/v1/capacity/sample";

const bytes = z.number().int().nonnegative().max(2 ** 53 - 1);
const name = z.string().min(1).max(253);

export const CapacitySample = z.object({
  node: z.object({
    name,
    cpu_used: bytes, // millicores
    cpu_allocatable: bytes.min(1),
    memory_used: bytes,
    memory_allocatable: bytes.min(1),
    fs_used: bytes,
    fs_capacity: bytes.min(1),
  }).strict(),
  volumes: z.array(z.object({ namespace: name, name, used: bytes, capacity: bytes.min(1) }).strict()).max(500),
  pods: z.array(z.object({ namespace: name, name, memory: bytes }).strict()).max(1000),
  ooms: z.array(z.object({ namespace: name, pod: name, container: name, finished_at: z.iso.datetime({ offset: true }) }).strict()).max(500),
}).strict();
export type CapacitySample = z.infer<typeof CapacitySample>;

/** Highest share of capacity used by any volume, 0 without volumes. */
export function volumeRatio(s: CapacitySample): number {
  return s.volumes.reduce((m, v) => Math.max(m, v.used / v.capacity), 0);
}

/** Stores one sample with the account count of this moment and folds it into the day's row. Returns the new OOM kills. */
export async function recordSample(db: Db, s: CapacitySample): Promise<CapacitySample["ooms"]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ accounts: number }>("SELECT count(*)::int AS accounts FROM signups");
    const accounts = rows[0]!.accounts;
    await client.query("INSERT INTO capacity_samples (accounts, sample) VALUES ($1, $2)", [accounts, JSON.stringify(s)]);
    const fresh: CapacitySample["ooms"] = [];
    for (const o of s.ooms) {
      const r = await client.query(
        `INSERT INTO capacity_ooms (namespace, pod, container, finished_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`, [o.namespace, o.pod, o.container, o.finished_at]);
      if (r.rowCount) fresh.push(o);
    }
    const n = s.node;
    await client.query(
      `INSERT INTO capacity_days AS d (day, samples, accounts_max, cpu_used_max, cpu_allocatable, memory_used_max,
         memory_allocatable, fs_used_max, fs_capacity, volume_ratio_max, oom_kills)
       VALUES ((now() AT TIME ZONE 'America/Sao_Paulo')::date, 1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (day) DO UPDATE SET
         samples = d.samples + 1,
         accounts_max = greatest(d.accounts_max, EXCLUDED.accounts_max),
         cpu_used_max = greatest(d.cpu_used_max, EXCLUDED.cpu_used_max),
         cpu_allocatable = EXCLUDED.cpu_allocatable,
         memory_used_max = greatest(d.memory_used_max, EXCLUDED.memory_used_max),
         memory_allocatable = EXCLUDED.memory_allocatable,
         fs_used_max = greatest(d.fs_used_max, EXCLUDED.fs_used_max),
         fs_capacity = EXCLUDED.fs_capacity,
         volume_ratio_max = greatest(d.volume_ratio_max, EXCLUDED.volume_ratio_max),
         oom_kills = d.oom_kills + EXCLUDED.oom_kills`,
      [accounts, n.cpu_used, n.cpu_allocatable, n.memory_used, n.memory_allocatable, n.fs_used, n.fs_capacity,
        volumeRatio(s), fresh.length]);
    await client.query("COMMIT");
    return fresh;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Raw samples go after 7 days, day rows and OOM records after 2 years. */
export async function pruneCapacity(db: Db): Promise<void> {
  await db.query("DELETE FROM capacity_samples WHERE taken_at < now() - interval '7 days'");
  await db.query("DELETE FROM capacity_days WHERE day < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 731");
  await db.query("DELETE FROM capacity_ooms WHERE seen_at < now() - interval '2 years'");
}

// ---- Alerts (ADR 0285, bipe#1313) ----------------------------------------------------------------

export type AlertLimits = { memory: number; disk: number; cpu: number };
export type AlertSend = (body: string) => Promise<void>;

const pct = (r: number) => `${Math.round(r * 100)}%`;
const brTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

/** The conditions that hold in this sample, as key to [start text, clear text]. */
async function conditions(db: Db, s: CapacitySample, limits: AlertLimits): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const n = s.node;
  const mem = n.memory_used / n.memory_allocatable;
  if (mem > limits.memory) out.set("memory", `Memória do servidor em ${pct(mem)} (limite ${pct(limits.memory)}).`);
  const fs = n.fs_used / n.fs_capacity;
  if (fs > limits.disk) out.set("disk", `Disco do servidor em ${pct(fs)} (limite ${pct(limits.disk)}).`);
  for (const v of s.volumes) {
    const r = v.used / v.capacity;
    if (r > limits.disk) out.set(`volume:${v.namespace}/${v.name}`, `Volume ${v.namespace}/${v.name} em ${pct(r)} (limite ${pct(limits.disk)}).`);
  }
  // CPU counts only when it held for 15 minutes: this sample and the samples of the last 15 minutes.
  const { rows } = await db.query<{ n: number; high: number }>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE (sample->'node'->>'cpu_used')::float8 / (sample->'node'->>'cpu_allocatable')::float8 > $1)::int AS high
       FROM capacity_samples WHERE taken_at > now() - interval '15 minutes'`, [limits.cpu]);
  const cpu = n.cpu_used / n.cpu_allocatable;
  if (rows[0]!.n >= 3 && rows[0]!.high === rows[0]!.n) {
    out.set("cpu", `CPU do servidor acima de ${pct(limits.cpu)} há 15 minutos (agora ${pct(cpu)}).`);
  }
  return out;
}

/**
 * One message when a condition starts and one when it clears; nothing while it holds. A message that fails to send
 * leaves the state as it was, so the next sample tries again. Each new OOM kill gets its own message.
 */
export async function checkAlerts(db: Db, s: CapacitySample, fresh: CapacitySample["ooms"], limits: AlertLimits, send: AlertSend): Promise<void> {
  const now = await conditions(db, s, limits);
  const s0 = s.node;
  const clearOf = (key: string): string => {
    if (key === "memory") return `Memória do servidor voltou a ${pct(s0.memory_used / s0.memory_allocatable)}.`;
    if (key === "disk") return `Disco do servidor voltou a ${pct(s0.fs_used / s0.fs_capacity)}.`;
    if (key === "cpu") return `CPU do servidor voltou a ${pct(s0.cpu_used / s0.cpu_allocatable)}.`;
    const v = s.volumes.find((x) => `volume:${x.namespace}/${x.name}` === key);
    return v ? `Volume ${v.namespace}/${v.name} voltou a ${pct(v.used / v.capacity)}.` : `${key.slice("volume:".length)} não aparece mais.`;
  };
  const { rows } = await db.query<{ condition: string }>("SELECT condition FROM capacity_alerts");
  const held = new Set(rows.map((r) => r.condition));
  for (const [key, start] of now) {
    if (held.has(key)) continue;
    await send(start);
    await db.query("INSERT INTO capacity_alerts (condition) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
  }
  for (const key of held) {
    if (now.has(key)) continue;
    await send(clearOf(key));
    await db.query("DELETE FROM capacity_alerts WHERE condition = $1", [key]);
  }
  for (const o of fresh) await send(`${o.pod} (container ${o.container}) reiniciou por falta de memória às ${brTime(o.finished_at)}.`);
}

// ---- Staff report (ADR 0285, bipe#1315) ----------------------------------------------------------

const percent = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

/** /v1/admin/capacity: the last sample and one row per Brazil day, oldest first. Accounts go through cell(). */
export async function capacityReport(db: Db, days: number) {
  const { rows: last } = await db.query<{ taken_at: Date; accounts: number; sample: CapacitySample }>(
    "SELECT taken_at, accounts, sample FROM capacity_samples ORDER BY taken_at DESC LIMIT 1");
  const { rows: dayRows } = await db.query<{
    day: string; accounts_max: number; cpu_used_max: string; cpu_allocatable: string; memory_used_max: string;
    memory_allocatable: string; fs_used_max: string; fs_capacity: string; volume_ratio_max: number; oom_kills: number;
  }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, accounts_max, cpu_used_max, cpu_allocatable, memory_used_max,
            memory_allocatable, fs_used_max, fs_capacity, volume_ratio_max, oom_kills
       FROM capacity_days WHERE day > (now() AT TIME ZONE 'America/Sao_Paulo')::date - $1::int ORDER BY day`, [days]);
  const l = last[0];
  const s = l?.sample;
  const newest = dayRows.at(-1);
  const gb = newest ? Number(newest.memory_used_max) / 2 ** 30 : 0;
  const vcpu = newest ? Number(newest.cpu_used_max) / 1000 : 0;
  const accounts = newest ? cell(newest.accounts_max) : null;
  return {
    min_cell: MIN_CELL,
    last: l && s ? {
      taken_at: l.taken_at.toISOString(),
      accounts: cell(l.accounts),
      cpu_pct: percent(s.node.cpu_used, s.node.cpu_allocatable),
      memory_pct: percent(s.node.memory_used, s.node.memory_allocatable),
      disk_pct: percent(s.node.fs_used, s.node.fs_capacity),
      cpu_allocatable_m: s.node.cpu_allocatable,
      memory_allocatable: s.node.memory_allocatable,
      fs_capacity: s.node.fs_capacity,
      volumes: s.volumes.map((v) => ({ name: `${v.namespace}/${v.name}`, used: v.used, capacity: v.capacity, pct: percent(v.used, v.capacity) }))
        .sort((a, b) => b.pct - a.pct),
      pods: [...s.pods].sort((a, b) => b.memory - a.memory).slice(0, 10).map((p) => ({ name: p.name, memory: p.memory })),
    } : null,
    days: dayRows.map((d) => ({
      day: d.day,
      accounts: cell(d.accounts_max),
      cpu_pct: percent(Number(d.cpu_used_max), Number(d.cpu_allocatable)),
      memory_pct: percent(Number(d.memory_used_max), Number(d.memory_allocatable)),
      disk_pct: percent(Number(d.fs_used_max), Number(d.fs_capacity)),
      volume_pct: Math.round(d.volume_ratio_max * 100),
      oom_kills: d.oom_kills,
    })),
    accounts_per_gb: accounts !== null && gb > 0 ? Math.round((accounts / gb) * 10) / 10 : null,
    accounts_per_vcpu: accounts !== null && vcpu > 0 ? Math.round((accounts / vcpu) * 10) / 10 : null,
  };
}

/** The staff index part: null when no sample came in the last 15 minutes, so a stopped probe shows "-". */
export async function capacitySummary(db: Db) {
  const { rows } = await db.query<{ sample: CapacitySample }>(
    "SELECT sample FROM capacity_samples WHERE taken_at > now() - interval '15 minutes' ORDER BY taken_at DESC LIMIT 1");
  const s = rows[0]?.sample;
  if (!s) return null;
  const { rows: oom } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM capacity_ooms WHERE finished_at > now() - interval '7 days'");
  return {
    memory_pct: percent(s.node.memory_used, s.node.memory_allocatable),
    disk_pct: Math.max(percent(s.node.fs_used, s.node.fs_capacity), ...s.volumes.map((v) => percent(v.used, v.capacity))),
    ooms_7d: oom[0]!.n,
  };
}
