import { z } from "zod";
import type { Db } from "./db.js";

// First-party experiment counters (ADR 0026): one daily number per experiment, arm and event.
// No IP, no identifier, no per-person row.

export const ExperimentEventBody = z.object({
  experiment: z.string().regex(/^[a-z0-9-]{1,32}$/),
  arm: z.string().regex(/^h[0-9]$/),
  event: z.enum(["assign", "install_click"]),
});
export type ExperimentEvent = z.infer<typeof ExperimentEventBody>;

export async function countEvent(db: Db, e: ExperimentEvent): Promise<void> {
  await db.query(
    `INSERT INTO experiment_counts (experiment, arm, event, day, n) VALUES ($1, $2, $3, current_date, 1)
     ON CONFLICT (experiment, arm, event, day) DO UPDATE SET n = experiment_counts.n + 1`,
    [e.experiment, e.arm, e.event],
  );
}

export type ArmReport = { arm: string; visitors: number; install_clicks: number; waitlist: number; install_rate: string; waitlist_rate: string };

/** Per arm: browsers assigned, TestFlight clicks, waitlist sign-ups whose source ends in ":<arm>". */
export async function experimentReport(db: Db, experiment: string): Promise<ArmReport[]> {
  const { rows } = await db.query<{ arm: string; visitors: string; install_clicks: string }>(
    `SELECT arm,
            coalesce(sum(n) FILTER (WHERE event = 'assign'), 0) AS visitors,
            coalesce(sum(n) FILTER (WHERE event = 'install_click'), 0) AS install_clicks
       FROM experiment_counts WHERE experiment = $1 GROUP BY arm ORDER BY arm`,
    [experiment],
  );
  const signups = await db.query<{ arm: string; n: string }>(
    `SELECT substring(source FROM ':(h[0-9])$') AS arm, count(*) AS n FROM waitlist
      WHERE source ~ ':h[0-9]$' GROUP BY 1`,
  );
  const byArm = new Map(signups.rows.map((r) => [r.arm, Number(r.n)]));
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  return rows.map((r) => {
    const visitors = Number(r.visitors), installs = Number(r.install_clicks), waitlist = byArm.get(r.arm) ?? 0;
    return { arm: r.arm, visitors, install_clicks: installs, waitlist, install_rate: pct(installs, visitors), waitlist_rate: pct(waitlist, visitors) };
  });
}
