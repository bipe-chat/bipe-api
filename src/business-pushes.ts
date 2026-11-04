// Reminders and alerts of the business tools (ADR 0102, bipe#320; spec notification-service). Content-free pushes
// through Sygnal, like the join pushes: the phone shows fixed text. Nothing goes into the encrypted chat. A web customer
// has no account and gets no push. Each send is best effort and never fails the request that caused it.
import { localParts } from "./business-common.js";
import type { Db } from "./db.js";
import { type DevicePushDeps, type PushKind, pushToDevices } from "./device-push.js";
import { getNotificationPrefs, type NotificationPrefs } from "./notification-prefs.js";

/** The hour of the morning summary, in the business's time zone. */
const SUMMARY_HOUR = 7;
/** A reminder later than this is skipped: after a long restart a stale reminder helps nobody. */
const LATE_MS = 30 * 60_000;
const MINUTE_MS = 60_000;
const LOOKAHEAD_DAYS = 8;

export type BusinessPushes = {
  /** To the company account, when work_alerts is on. */
  owner(businessId: string, kind: "work_new_booking" | "work_new_order" | "work_cancelled"): void;
  /** To a signed-in customer. */
  customer(userId: string | undefined, kind: "booking_changed" | "order_updated" | "queue_called"): void;
};

export function businessPushes(db: Db, push: DevicePushDeps | undefined): BusinessPushes {
  const send = (userId: string, kind: PushKind, pref?: keyof NotificationPrefs) =>
    void sendWithPref(db, push, userId, kind, pref).catch((e: Error) => console.error(`push ${kind}: ${e.name}`));
  return {
    owner: (businessId, kind) => send(businessId, kind, "work_alerts"),
    customer: (userId, kind) => {
      if (userId) send(userId, kind);
    },
  };
}

async function sendWithPref(db: Db, push: DevicePushDeps | undefined, userId: string, kind: PushKind, pref?: keyof NotificationPrefs): Promise<void> {
  if (pref && !(await getNotificationPrefs(db, userId))[pref]) return;
  await pushToDevices(push, userId, kind, null);
}

/** The reminder that is due now for a booking, by the business's reminder_minutes, or undefined. */
export function dueReminder(startMs: number, reminderMinutes: number[], nowMs: number): number | undefined {
  if (startMs <= nowMs) return undefined;
  return reminderMinutes.find((minutes) => {
    const due = startMs - minutes * MINUTE_MS;
    return due <= nowMs && nowMs - due <= LATE_MS;
  });
}

/** A long reminder is "tomorrow"; a short one is "soon". */
export const reminderKind = (minutes: number): PushKind => (minutes >= 12 * 60 ? "booking_tomorrow" : "booking_soon");

/** Sends once: the row in business_pushes_sent survives restarts. */
async function firstTime(db: Db, key: string): Promise<boolean> {
  const { rowCount } = await db.query("INSERT INTO business_pushes_sent (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
  return (rowCount ?? 0) > 0;
}

/** The job, every minute: due reminders of confirmed bookings, and the morning summary of a day with bookings. */
export async function runBusinessPushes(db: Db, push: DevicePushDeps | undefined, now = Date.now()): Promise<void> {
  const { rows } = await db.query<{ id: string; customer_id: string; start_at: Date; reminder_minutes: number[] }>(
    `SELECT b.id, b.customer_id, b.start_at, s.reminder_minutes FROM bookings b
       JOIN agenda_settings s ON s.business_id = b.business_id
      WHERE b.status = 'confirmed' AND b.customer_id IS NOT NULL AND b.start_at > now()
        AND b.start_at < now() + make_interval(days => $1)`,
    [LOOKAHEAD_DAYS],
  );
  for (const row of rows) {
    const minutes = dueReminder(row.start_at.getTime(), row.reminder_minutes, now);
    if (minutes === undefined || !(await firstTime(db, `reminder:${row.id}:${minutes}`))) continue;
    await sendWithPref(db, push, row.customer_id, reminderKind(minutes), "booking_reminders");
  }
  const { rows: shops } = await db.query<{ business_id: string; time_zone: string }>(
    "SELECT business_id, time_zone FROM agenda_settings WHERE published AND NOT tool_off",
  );
  for (const shop of shops) {
    const local = localParts(shop.time_zone, now);
    if (Math.floor(local.minute / 60) !== SUMMARY_HOUR) continue;
    const { rowCount } = await db.query(
      `SELECT 1 FROM bookings WHERE business_id = $1 AND status IN ('confirmed', 'requested')
         AND start_at >= ($2::date::timestamp AT TIME ZONE $3) AND start_at < (($2::date + 1)::timestamp AT TIME ZONE $3) LIMIT 1`,
      [shop.business_id, local.date, shop.time_zone],
    );
    if (!rowCount || !(await firstTime(db, `today:${shop.business_id}:${local.date}`))) continue;
    await sendWithPref(db, push, shop.business_id, "work_today", "work_summary");
  }
  await db.query("DELETE FROM business_pushes_sent WHERE sent_at < now() - interval '30 days'");
}
