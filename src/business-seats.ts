// People on a work account (ADR 0251, ADR 0252, bipe#1055; contract /v1/me/business/seats).
// One Matrix account, so the seat of a device is the only thing that tells people apart. bipe-api enforces the owner's
// actions by the device of the token and fails closed: a device with no seat has no owner rights. A seat holds a name
// the owner typed and no link to a personal account (ADR 0251 point 6).
import { randomUUID } from "node:crypto";
import type { Seat, SeatDevice, SeatList, SeatMe } from "./generated/business-api.js";
import { inTransaction, isCompany, lockBusiness, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { MasSession } from "./mas.js";
import { accountRules } from "./registry.js";

/** The MAS admin calls that seats need. Mas implements it; tests pass a fake. */
export interface SeatMas {
  userByUsername(username: string): Promise<{ id: string } | null>;
  activeSessions(masId: string): Promise<MasSession[]>;
  finishSession(session: MasSession): Promise<void>;
}

type SeatRow = { id: string; name: string; role: "owner" | "attendant"; status: "waiting" | "active"; window_expires_at: Date | null; created_at: Date };
type DeviceRow = { seat_id: string; device_id: string; kind: "phone" | "web"; added_at: Date };
type Deps = { db: Db; mas: SeatMas };

const OWNER_NAME = "Responsável";
const windowMs = () => accountRules.workAccountSeatWindowMinutes * 60_000;
const windowOpen = (row: SeatRow) => row.window_expires_at !== null && row.window_expires_at.getTime() > Date.now();

async function masSessions(mas: SeatMas, userId: string): Promise<MasSession[]> {
  const user = await mas.userByUsername(userId.slice(1).split(":")[0]!);
  if (!user) throw new ApiError("unauthorized");
  return mas.activeSessions(user.id);
}

async function audit(db: Queryable, businessId: string, action: string, seatId: string | null): Promise<void> {
  await db.query("INSERT INTO business_seat_events (business_id, action, seat_id) VALUES ($1, $2, $3)", [businessId, action, seatId]);
}

async function markRotation(db: Queryable, businessId: string): Promise<void> {
  await db.query(
    `INSERT INTO business_work_settings (business_id, backup_rotation_pending) VALUES ($1, true)
     ON CONFLICT (business_id) DO UPDATE SET backup_rotation_pending = true`,
    [businessId],
  );
}

/** The owner seat. A company account made after the migration gets it here, on the first look. */
async function ownerSeat(db: Queryable, businessId: string): Promise<SeatRow> {
  await db.query(
    `INSERT INTO business_seats (id, business_id, name, role, status) VALUES ($1, $2, $3, 'owner', 'active')
     ON CONFLICT (business_id) WHERE role = 'owner' DO NOTHING`,
    [randomUUID(), businessId, OWNER_NAME],
  );
  const { rows } = await db.query<SeatRow>("SELECT * FROM business_seats WHERE business_id = $1 AND role = 'owner'", [businessId]);
  return rows[0]!;
}

async function attach(db: Queryable, businessId: string, seatId: string, deviceId: string, kind: "phone" | "web"): Promise<void> {
  await db.query(
    `INSERT INTO business_seat_devices (business_id, seat_id, device_id, kind) VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, device_id) DO NOTHING`,
    [businessId, seatId, deviceId, kind],
  );
}

async function seatOfDevice(db: Queryable, businessId: string, deviceId: string): Promise<SeatRow | null> {
  const { rows } = await db.query<SeatRow>(
    `SELECT s.* FROM business_seat_devices d JOIN business_seats s ON s.id = d.seat_id
     WHERE d.business_id = $1 AND d.device_id = $2`,
    [businessId, deviceId],
  );
  return rows[0] ?? null;
}

/**
 * The seat of a device, or null. A device with no seat joins the owner seat in two cases only: the owner window is open
 * (a recovery or a phone move), or its MAS session is older than the owner seat (the account existed before seats).
 */
async function resolveSeat({ db, mas }: Deps, businessId: string, deviceId: string | null): Promise<SeatRow | null> {
  if (!deviceId) return null;
  const known = await seatOfDevice(db, businessId, deviceId);
  if (known) return known;
  const owner = await ownerSeat(db, businessId);
  if (windowOpen(owner)) {
    await attach(db, businessId, owner.id, deviceId, "phone");
    await db.query("UPDATE business_seats SET window_expires_at = NULL WHERE id = $1", [owner.id]);
    await audit(db, businessId, "device_joined", owner.id);
    return owner;
  }
  const session = (await masSessions(mas, businessId)).find((s) => s.deviceId === deviceId);
  if (session?.createdAt && Date.parse(session.createdAt) < owner.created_at.getTime()) {
    const { rowCount } = await db.query("SELECT 1 FROM web_links WHERE user_id = $1 AND web_device_id = $2", [businessId, deviceId]);
    await attach(db, businessId, owner.id, deviceId, rowCount ? "web" : "phone");
    return owner;
  }
  return null;
}

/** The seat of the calling device, or null (ADR 0284: the chat routes need a person). */
export async function callerSeat(deps: Deps, businessId: string, deviceId: string | null): Promise<{ id: string; role: "owner" | "attendant" } | null> {
  const seat = await resolveSeat(deps, businessId, deviceId);
  return seat ? { id: seat.id, role: seat.role } : null;
}

/** Owner-only actions. An account that is not a company account passes: the rule is about people on one account. */
export async function requireOwnerDevice(deps: Deps, userId: string, deviceId: string | null): Promise<void> {
  if (!(await isCompany(deps.db, userId))) return;
  const seat = await resolveSeat(deps, userId, deviceId);
  if (seat?.role !== "owner") throw new ApiError("owner_only");
}

const iso = (d: Date) => d.toISOString();
function seatDevice(row: DeviceRow): SeatDevice {
  return { device_id: row.device_id, kind: row.kind, added_at: iso(row.added_at) };
}
function seatOf(row: SeatRow, devices: DeviceRow[]): Seat {
  return {
    id: row.id, name: row.name, role: row.role, status: row.status,
    devices: devices.filter((d) => d.seat_id === row.id).map(seatDevice),
    ...(windowOpen(row) ? { window_expires_at: iso(row.window_expires_at!) } : {}),
  };
}

async function dropExpired(db: Queryable, businessId: string): Promise<void> {
  await db.query("DELETE FROM business_seats WHERE business_id = $1 AND status = 'waiting' AND (window_expires_at IS NULL OR window_expires_at <= now())", [businessId]);
}

/** GET /v1/me/business/seats. Only the owner gets device lists. A device with a session but no seat shows as unassigned. */
export async function seatList(deps: Deps, businessId: string, deviceId: string | null): Promise<SeatList> {
  const { db, mas } = deps;
  await dropExpired(db, businessId);
  const mine = await resolveSeat(deps, businessId, deviceId);
  await ownerSeat(db, businessId);
  const me: SeatMe = mine ? { seat_id: mine.id, name: mine.name, role: mine.role } : { role: "none" };
  const { rows: seats } = await db.query<SeatRow>("SELECT * FROM business_seats WHERE business_id = $1 ORDER BY role = 'owner' DESC, created_at", [businessId]);
  const { rows: settings } = await db.query<{ backup_rotation_pending: boolean }>("SELECT backup_rotation_pending FROM business_work_settings WHERE business_id = $1", [businessId]);
  const isOwner = mine?.role === "owner";
  let devices: DeviceRow[] = [];
  const unassigned: SeatDevice[] = [];
  if (isOwner) {
    const { rows } = await db.query<DeviceRow>("SELECT seat_id, device_id, kind, added_at FROM business_seat_devices WHERE business_id = $1 ORDER BY added_at", [businessId]);
    const sessions = (await masSessions(mas, businessId)).filter((s) => s.deviceId);
    const live = new Set(sessions.map((s) => s.deviceId));
    const known = new Set(rows.map((r) => r.device_id));
    devices = rows.filter((r) => live.has(r.device_id));
    const seen = new Set<string>();
    for (const s of sessions) {
      if (known.has(s.deviceId!) || seen.has(s.deviceId!)) continue;
      seen.add(s.deviceId!);
      unassigned.push({ device_id: s.deviceId!, kind: "phone", added_at: s.createdAt ?? iso(new Date()) });
    }
  }
  return {
    me,
    seats: seats.map((s) => seatOf(s, devices)),
    unassigned_devices: unassigned,
    max_people: accountRules.workAccountMaxPeople,
    backup_rotation_pending: isOwner && settings[0]?.backup_rotation_pending === true,
  };
}

async function refuseOpenWindow(db: Queryable, businessId: string, exceptSeat?: string): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM business_seats WHERE business_id = $1 AND window_expires_at > now() AND id IS DISTINCT FROM $2",
    [businessId, exceptSeat ?? null],
  );
  if (rowCount) throw new ApiError("seat_window_open");
}

const seatPublic = (row: SeatRow): Seat => seatOf(row, []);

/** POST /v1/me/business/seats. Every person added is an attendant: one owner per account (ADR 0251 point 22). */
export async function createSeat({ db }: Deps, businessId: string, name: string): Promise<Seat> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await dropExpired(client, businessId);
    await ownerSeat(client, businessId);
    await refuseOpenWindow(client, businessId);
    const { rows: count } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM business_seats WHERE business_id = $1", [businessId]);
    if (count[0]!.n >= accountRules.workAccountMaxPeople) throw new ApiError("seat_limit");
    const { rows } = await client.query<SeatRow>(
      `INSERT INTO business_seats (id, business_id, name, role, status, window_expires_at)
       VALUES ($1, $2, $3, 'attendant', 'waiting', $4) RETURNING *`,
      [randomUUID(), businessId, name, new Date(Date.now() + windowMs())],
    );
    await audit(client, businessId, "seat_added", rows[0]!.id);
    return seatPublic(rows[0]!);
  });
}

async function seatById(db: Queryable, businessId: string, seatId: string): Promise<SeatRow> {
  const { rows } = await db.query<SeatRow>("SELECT * FROM business_seats WHERE business_id = $1 AND id::text = $2", [businessId, seatId]);
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

/** PATCH /v1/me/business/seats/{seatId}. */
export async function renameSeat({ db }: Deps, businessId: string, seatId: string, name: string): Promise<Seat> {
  await seatById(db, businessId, seatId);
  const { rows } = await db.query<SeatRow>("UPDATE business_seats SET name = $3 WHERE business_id = $1 AND id::text = $2 RETURNING *", [businessId, seatId, name]);
  return seatPublic(rows[0]!);
}

/** POST /v1/me/business/seats/{seatId}/window: only the owner's own seat, so a new phone of the owner can join it. */
export async function openOwnerWindow({ db }: Deps, businessId: string, seatId: string): Promise<Seat> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const seat = await seatById(client, businessId, seatId);
    if (seat.role !== "owner") throw new ApiError("bad_request", "seat");
    await refuseOpenWindow(client, businessId, seat.id);
    const { rows } = await client.query<SeatRow>("UPDATE business_seats SET window_expires_at = $2 WHERE id = $1 RETURNING *", [seat.id, new Date(Date.now() + windowMs())]);
    return seatPublic(rows[0]!);
  });
}

/** POST /v1/me/business/seats/claim: the device of the token joins the seat with the open window. */
export async function claimSeat(deps: Deps, businessId: string, deviceId: string | null): Promise<SeatList> {
  if (!deviceId) throw new ApiError("bad_request", "device");
  await inTransaction(deps.db, async (client) => {
    await lockBusiness(client, businessId);
    if (await seatOfDevice(client, businessId, deviceId)) return;
    const { rows } = await client.query<SeatRow>(
      `SELECT * FROM business_seats WHERE business_id = $1 AND window_expires_at > now()
       ORDER BY role = 'attendant' DESC LIMIT 1`,
      [businessId],
    );
    const seat = rows[0];
    if (!seat) throw new ApiError("seat_window_closed");
    await attach(client, businessId, seat.id, deviceId, "phone");
    await client.query("UPDATE business_seats SET status = 'active', window_expires_at = NULL WHERE id = $1", [seat.id]);
    await audit(client, businessId, "device_joined", seat.id);
  });
  return seatList(deps, businessId, deviceId);
}

/** Ends the MAS sessions of these devices, then forgets them. A MAS failure throws before anything is forgotten. */
async function endDevices({ db, mas }: Deps, businessId: string, deviceIds: Set<string>): Promise<void> {
  if (deviceIds.size === 0) return;
  for (const session of await masSessions(mas, businessId)) {
    if (session.deviceId && deviceIds.has(session.deviceId)) await mas.finishSession(session);
  }
  await db.query("DELETE FROM business_seat_devices WHERE business_id = $1 AND device_id = ANY($2::text[])", [businessId, [...deviceIds]]);
  await db.query("DELETE FROM web_links WHERE user_id = $1 AND web_device_id = ANY($2::text[])", [businessId, [...deviceIds]]);
}

async function devicesOfSeat(db: Queryable, seatId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ device_id: string }>("SELECT device_id FROM business_seat_devices WHERE seat_id = $1", [seatId]);
  return new Set(rows.map((r) => r.device_id));
}

async function endSeat(deps: Deps, businessId: string, seat: SeatRow, action: string): Promise<void> {
  const devices = await devicesOfSeat(deps.db, seat.id);
  await endDevices(deps, businessId, devices);
  await deps.db.query("DELETE FROM business_seats WHERE id = $1", [seat.id]);
  await audit(deps.db, businessId, action, seat.id);
  if (devices.size > 0) await markRotation(deps.db, businessId);
}

/** DELETE /v1/me/business/seats/{seatId}. A waiting seat had no device, so it asks for no rotation. */
export async function removeSeat(deps: Deps, businessId: string, callerDevice: string | null, seatId: string): Promise<SeatList> {
  const seat = await seatById(deps.db, businessId, seatId);
  if (seat.role === "owner") throw new ApiError("bad_request", "owner_seat");
  await endSeat(deps, businessId, seat, "seat_removed");
  return seatList(deps, businessId, callerDevice);
}

/** POST /v1/me/business/seats/leave. The session of the caller ends here, so the list it gets back is its last answer. */
export async function leaveSeat(deps: Deps, businessId: string, deviceId: string | null): Promise<SeatList> {
  const seat = await resolveSeat(deps, businessId, deviceId);
  if (seat?.role !== "attendant") throw new ApiError("owner_only");
  await endSeat(deps, businessId, seat, "seat_left");
  return {
    me: { role: "none" }, seats: [], unassigned_devices: [],
    max_people: accountRules.workAccountMaxPeople, backup_rotation_pending: false,
  };
}

/** PUT /v1/me/business/seats/devices/{deviceId}: a device with no person joins a seat. */
export async function assignDevice(deps: Deps, businessId: string, callerDevice: string | null, deviceId: string, seatId: string): Promise<SeatList> {
  const { db } = deps;
  const seat = await seatById(db, businessId, seatId);
  if (await seatOfDevice(db, businessId, deviceId)) throw new ApiError("bad_request", "device");
  if (!(await masSessions(deps.mas, businessId)).some((s) => s.deviceId === deviceId)) throw new ApiError("not_found");
  await attach(db, businessId, seat.id, deviceId, "phone");
  await db.query("UPDATE business_seats SET status = 'active', window_expires_at = NULL WHERE id = $1 AND status = 'waiting'", [seat.id]);
  await audit(db, businessId, "device_assigned", seat.id);
  return seatList(deps, businessId, callerDevice);
}

/** DELETE /v1/me/business/seats/devices/{deviceId}. The caller cannot remove its own device. */
export async function removeDevice(deps: Deps, businessId: string, callerDevice: string | null, deviceId: string): Promise<SeatList> {
  if (deviceId === callerDevice) throw new ApiError("bad_request", "device");
  await endDevices(deps, businessId, new Set([deviceId]));
  await audit(deps.db, businessId, "device_removed", null);
  await markRotation(deps.db, businessId);
  return seatList(deps, businessId, callerDevice);
}

/** POST /v1/me/business/seats/backup-rotated. */
export async function backupRotated(deps: Deps, businessId: string, callerDevice: string | null): Promise<SeatList> {
  await deps.db.query("UPDATE business_work_settings SET backup_rotation_pending = false WHERE business_id = $1", [businessId]);
  return seatList(deps, businessId, callerDevice);
}

/**
 * A recovery gave out new credentials (ADR 0057): the next device with no seat is the owner's. No-op for an account
 * with no owner seat: a personal account, or a company account that gets its seat on the first look.
 */
export async function openOwnerWindowForRecovery(db: Queryable, userId: string): Promise<void> {
  await db.query("UPDATE business_seats SET window_expires_at = $2 WHERE business_id = $1 AND role = 'owner'", [userId, new Date(Date.now() + windowMs())]);
}

/**
 * POST /v1/web-link/finish with kind phone. An owner device approved a new phone: open the owner window, so that phone
 * joins the owner seat. Not with seatId: that flow adds a person, who joins with the claim.
 */
export async function afterPhoneApproved(db: Queryable, userId: string, approverDevice: string, seatId?: string): Promise<void> {
  if (seatId || !(await isCompany(db, userId))) return;
  const approver = await seatOfDevice(db, userId, approverDevice);
  if (approver?.role !== "owner") return;
  const { rowCount } = await db.query("SELECT 1 FROM business_seats WHERE business_id = $1 AND role = 'attendant' AND window_expires_at > now()", [userId]);
  if (!rowCount) await openOwnerWindowForRecovery(db, userId);
}

/**
 * POST /v1/web-link/finish with kind computer. The web session belongs to the picked seat, else to the seat of the
 * approving device (ADR 0251 point 14). An attendant's phone cannot approve: it has no hidden password.
 */
export async function afterWebApproved(db: Queryable, userId: string, approverDevice: string, webDevice: string, seatId?: string): Promise<void> {
  if (!(await isCompany(db, userId))) return;
  const approver = await seatOfDevice(db, userId, approverDevice);
  if (!approver) return;
  let target = approver.id;
  if (seatId && approver.role === "owner") target = (await seatById(db, userId, seatId)).id;
  await attach(db, userId, target, webDevice, "web");
}

/**
 * Theft mark on a phone of a company account (ADR 0251 points 15 and 19): the devices to end with it. An attendant's
 * web sessions end with that phone. An owner keeps the other owner devices. The owner's phone rotates the backup next.
 */
export async function afterDeviceStolen(db: Queryable, userId: string, deviceId: string): Promise<Set<string>> {
  const seat = await seatOfDevice(db, userId, deviceId);
  await markRotation(db, userId);
  if (seat?.role !== "attendant") return new Set();
  const { rows } = await db.query<{ device_id: string }>("SELECT device_id FROM business_seat_devices WHERE seat_id = $1 AND kind = 'web'", [seat.id]);
  return new Set(rows.map((r) => r.device_id));
}

/** Forgets devices that the theft path ended. */
export async function forgetDevices(db: Queryable, userId: string, deviceIds: string[]): Promise<void> {
  await db.query("DELETE FROM business_seat_devices WHERE business_id = $1 AND device_id = ANY($2::text[])", [userId, deviceIds]);
}
