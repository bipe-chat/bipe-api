import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { workHoursRules, workHoursProblemOf } from "./registry.js";

// Work side opening hours (ADR 0138 rule 4, bipe#511). The API keeps the hours of a company account so every device
// of that account reads the same. The phone applies them to that account's pushes; nothing here changes push rules.

export interface WorkHours {
  enabled: boolean;
  time_zone: string;
  days: { day: number; ranges: { start: string; end: string }[] }[];
}

async function requireCompany(db: Db, userId: string): Promise<void> {
  const { rows } = await db.query<{ account_type: string }>("SELECT account_type FROM signups WHERE user_id = $1", [userId]);
  if (rows[0]?.account_type !== "company") throw new ApiError("not_found");
}

function defaults(): WorkHours {
  return { enabled: false, time_zone: workHoursRules.defaultTimeZone, days: workHoursRules.defaultDays };
}

/** GET /v1/me/work-hours. An account that never saved hours gets the defaults, off. */
export async function getWorkHours(db: Db, userId: string): Promise<WorkHours> {
  await requireCompany(db, userId);
  const { rows } = await db.query<{ enabled: boolean; time_zone: string; days: WorkHours["days"] }>(
    "SELECT enabled, time_zone, days FROM work_hours WHERE user_id = $1",
    [userId],
  );
  return rows[0] ? { enabled: rows[0].enabled, time_zone: rows[0].time_zone, days: rows[0].days } : defaults();
}

/** PUT /v1/me/work-hours. Days sorted by weekday; ranges must pass the shared rule. */
export async function setWorkHours(db: Db, userId: string, hours: WorkHours): Promise<WorkHours> {
  await requireCompany(db, userId);
  const problem = workHoursProblemOf(hours);
  if (problem) throw new ApiError("bad_request", `work_hours_${problem}`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hours.time_zone });
  } catch {
    throw new ApiError("bad_request", "time_zone");
  }
  const days = [...hours.days].sort((a, b) => a.day - b.day);
  await db.query(
    `INSERT INTO work_hours (user_id, enabled, time_zone, days, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET enabled = $2, time_zone = $3, days = $4::jsonb, updated_at = now()`,
    [userId, hours.enabled, hours.time_zone, JSON.stringify(days)],
  );
  return { enabled: hours.enabled, time_zone: hours.time_zone, days };
}
