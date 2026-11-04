import type { Db } from "./db.js";
import { type DevicePushDeps, pushToDevices } from "./device-push.js";

// Join pushes (bipe-chat/bipe#967, spec notification-settings): whether an account gets invite_joined and
// group_link_joined. The prefs live here, not in push rules, because the API sends these pushes itself. An account
// without a row gets both on.

export interface NotificationPrefs {
  invite_joined: boolean;
  group_link_joined: boolean;
}

const DEFAULTS: NotificationPrefs = { invite_joined: true, group_link_joined: true };

/** GET /v1/me/notification-prefs. */
export async function getNotificationPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
  const { rows } = await db.query<NotificationPrefs>(
    "SELECT invite_joined, group_link_joined FROM notification_prefs WHERE user_id = $1",
    [userId],
  );
  return rows[0] ? { invite_joined: rows[0].invite_joined, group_link_joined: rows[0].group_link_joined } : { ...DEFAULTS };
}

/** PUT /v1/me/notification-prefs. A missing field keeps its saved value. */
export async function setNotificationPrefs(db: Db, userId: string, change: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  const prefs = { ...(await getNotificationPrefs(db, userId)), ...change };
  await db.query(
    `INSERT INTO notification_prefs (user_id, invite_joined, group_link_joined, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET invite_joined = $2, group_link_joined = $3, updated_at = now()`,
    [userId, prefs.invite_joined, prefs.group_link_joined],
  );
  return prefs;
}

/**
 * Sends a join push to `userId` when that account's pref for `kind` is on. Never throws: a failed pref read logs the
 * kind only and sends nothing.
 */
export async function pushJoin(
  db: Db,
  push: DevicePushDeps | undefined,
  userId: string,
  kind: "invite_joined" | "group_link_joined",
  extra: Record<string, string> = {},
): Promise<void> {
  try {
    if (!(await getNotificationPrefs(db, userId))[kind]) return;
  } catch (e) {
    console.error(`push ${kind}: prefs ${(e as Error).name}`);
    return;
  }
  await pushToDevices(push, userId, kind, null, extra);
}
