import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { platformOf } from "./growth.js";
import { cell, MIN_CELL } from "./staff-report.js";

// Recovery that survives the App Store transfer (bipe#531, bipe/docs/team-transfer-recovery.md).
// - An iPhone copies its keychain items into the app-group keychain group, then records the move here, per device.
// - A server factor that does not depend on the Apple Team ID: a verified recovery email. The linked-account work
//   (bipe#305) adds a linked Google account to INDEPENDENT_RECOVERY_USERS; a linked Apple account never counts,
//   because its `sub` changes with the team.
// - The staff report counts how many active iOS accounts are covered. Counts only, through cell(); never a user ID,
//   a device ID or an email.

/** User IDs with a Team-ID-independent factor the server can check. One source for the account state and the report. */
export const INDEPENDENT_RECOVERY_USERS = "SELECT user_id FROM recovery_emails WHERE email IS NOT NULL AND verified_at IS NOT NULL";

export async function hasIndependentRecovery(db: Db | pg.PoolClient, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ yes: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM (${INDEPENDENT_RECOVERY_USERS}) f WHERE f.user_id = $1) AS yes`,
    [userId],
  );
  return rows[0]?.yes ?? false;
}

/** POST /v1/me/keychain-move. The device comes from the access token, never from the body. */
export async function recordKeychainMove(db: Db, userId: string, deviceId: string | null): Promise<void> {
  if (!deviceId) throw new ApiError("bad_request", "device_required");
  await db.query(
    `INSERT INTO keychain_moves (user_id, device_id) VALUES ($1, $2)
     ON CONFLICT (user_id, device_id) DO UPDATE SET moved_at = now()`,
    [userId, deviceId],
  );
}

export interface ReadinessInput {
  /** iOS devices seen in the window: one entry per (user, device). */
  devices: { userId: string; deviceId: string }[];
  /** "<user>\n<device>" of every recorded move. */
  moved: Set<string>;
  /** Users with a server factor. */
  factor: Set<string>;
}

const share = (part: number, whole: number): number | null =>
  whole < MIN_CELL ? null : Math.round((part / whole) * 1000) / 10;

/** The numbers of the staff report from raw rows (section 6 of the design doc). Pure, so tests need no database. */
export function readinessCounts(days: number, { devices, moved, factor }: ReadinessInput) {
  const byUser = new Map<string, string[]>();
  for (const d of devices) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d.deviceId]);
  const isMoved = (user: string, device: string) => moved.has(`${user}\n${device}`);
  let devicesMoved = 0;
  let withFactor = 0;
  let allMoved = 0;
  let covered = 0;
  for (const [user, list] of byUser) {
    const n = list.filter((device) => isMoved(user, device)).length;
    devicesMoved += n;
    const hasFactor = factor.has(user);
    const everyDevice = n === list.length;
    if (hasFactor) withFactor++;
    if (everyDevice) allMoved++;
    if (hasFactor || everyDevice) covered++;
  }
  const accounts = byUser.size;
  return {
    days,
    min_cell: MIN_CELL,
    ios_devices: cell(devices.length),
    ios_devices_moved: cell(devicesMoved),
    ios_accounts: cell(accounts),
    accounts_server_factor: cell(withFactor),
    accounts_all_devices_moved: cell(allMoved),
    accounts_covered: cell(covered),
    accounts_uncovered: cell(accounts - covered),
    covered_share: share(covered, accounts),
    server_factor_share: share(withFactor, accounts),
  };
}

/**
 * GET /v1/admin/transfer-readiness and the CLI `transfer report`. Synapse `devices` needs SELECT on user_id,
 * device_id, user_agent and last_seen for role bipe_growth (bipe-infra scripts/setup-growth.sh).
 */
export async function transferReadiness(db: Db, synapse: pg.Pool | null, days: number) {
  if (!synapse) throw new ApiError("internal");
  const since = Date.now() - days * 86_400_000;
  const { rows } = await synapse.query<{ user_id: string; device_id: string; ua: string | null }>(
    "SELECT user_id, device_id, user_agent AS ua FROM devices WHERE last_seen > $1",
    [since],
  );
  const devices = rows.filter((r) => platformOf(r.ua) === "ios").map((r) => ({ userId: r.user_id, deviceId: r.device_id }));
  const users = [...new Set(devices.map((d) => d.userId))];
  const [moves, factors] = await Promise.all([
    db.query<{ user_id: string; device_id: string }>("SELECT user_id, device_id FROM keychain_moves WHERE user_id = ANY($1)", [users]),
    db.query<{ user_id: string }>(`SELECT user_id FROM (${INDEPENDENT_RECOVERY_USERS}) f WHERE f.user_id = ANY($1)`, [users]),
  ]);
  return readinessCounts(days, {
    devices,
    moved: new Set(moves.rows.map((r) => `${r.user_id}\n${r.device_id}`)),
    factor: new Set(factors.rows.map((r) => r.user_id)),
  });
}
