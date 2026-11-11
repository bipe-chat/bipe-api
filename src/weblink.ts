import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { Reader, type CityResponse } from "mmdb-lib";
import { afterPhoneApproved, afterWebApproved } from "./business-seats.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Mas, MasSession } from "./mas.js";

// Web sign-in approval on the phone (ADR 0118 in bipe/docs/adr, bipe#389).

const SINCE_MAX_AGE_MS = 15 * 60_000;
const SINCE_MAX_AHEAD_MS = 2 * 60_000;
const SINCE_SLACK_MS = 60_000;

export type WebLinkKind = "computer" | "phone";

/** The caller's device and the kind of approval, for the web session record (bipe#398). */
export type WebLinkCaller = { db: Db; deviceId: string | null; kind?: WebLinkKind; seatId?: string };

/**
 * Finishes the MAS browser sessions of the caller that started at or after `since` minus 60 s: the
 * session that the phone's private web view made with the form fill. Older sessions stay, so a staff
 * browser session is not touched. With kind computer, first records the OAuth 2.0 sessions that those
 * browser sessions approved as web sessions of the caller's device. Returns the number finished.
 */
export async function finishWebLink(mas: Mas, userId: string, since: string, caller?: WebLinkCaller): Promise<number> {
  const start = Date.parse(since);
  const now = Date.now();
  if (Number.isNaN(start) || start < now - SINCE_MAX_AGE_MS || start > now + SINCE_MAX_AHEAD_MS) throw new ApiError("bad_request", "since");
  const user = await mas.userByUsername(userId.slice(1).split(":")[0]!);
  if (!user) throw new ApiError("unauthorized");
  const ids = await mas.activeBrowserSessionsSince(user.id, new Date(start - SINCE_SLACK_MS));
  // A failed record must not keep the phone's browser session open: log it and finish the sessions.
  if (caller?.kind === "computer" && caller.deviceId) {
    await recordWebLinks(mas, caller.db, userId, caller.deviceId, ids, caller.seatId).catch(() => console.error("web-link: the web session record failed"));
  }
  if (caller?.kind === "phone" && caller.deviceId) {
    await afterPhoneApproved(caller.db, userId, caller.deviceId, caller.seatId).catch(() => console.error("web-link: the owner window failed"));
  }
  for (const id of ids) await mas.finishBrowserSession(id);
  return ids.length;
}

/** Records each Matrix device that one of the browser sessions approved, other than the approver's own device. */
async function recordWebLinks(mas: Mas, db: Db, userId: string, approverDeviceId: string, browserSessions: string[], seatId?: string): Promise<void> {
  for (const id of browserSessions) {
    for (const session of await mas.oauthSessionsApprovedBy(id)) {
      if (!session.deviceId || session.deviceId === approverDeviceId) continue;
      await db.query(
        `INSERT INTO web_links (user_id, web_device_id, approver_device_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, web_device_id) DO UPDATE SET approver_device_id = EXCLUDED.approver_device_id, linked_at = now()`,
        [userId, session.deviceId, approverDeviceId],
      );
      await afterWebApproved(db, userId, approverDeviceId, session.deviceId, seatId);
    }
  }
}

/** The MAS admin calls that end web sessions. Mas implements it; theft tests pass a fake. */
export interface WebLinkMas {
  activeSessions(masId: string): Promise<MasSession[]>;
  finishSession(session: MasSession): Promise<void>;
}

/** The web devices that a phone device of the account approved, except those of another person (ADR 0251 point 15). */
export async function webDevicesApprovedBy(db: Db, userId: string, approverDeviceId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ web_device_id: string }>(
    `SELECT w.web_device_id FROM web_links w
     LEFT JOIN business_seat_devices a ON a.business_id = w.user_id AND a.device_id = w.approver_device_id
     LEFT JOIN business_seat_devices d ON d.business_id = w.user_id AND d.device_id = w.web_device_id
     WHERE w.user_id = $1 AND w.approver_device_id = $2 AND (a.seat_id IS NULL OR d.seat_id IS NULL OR a.seat_id = d.seat_id)`,
    [userId, approverDeviceId],
  );
  return new Set(rows.map((r) => r.web_device_id));
}

/**
 * Ends every active MAS session of the account whose device is a web session that the approver device approved, then
 * forgets those records. Web sessions that other devices of the account approved stay. Returns the number of devices.
 */
export async function endWebLinks(mas: WebLinkMas, db: Db, masId: string, userId: string, approverDeviceId: string): Promise<number> {
  const web = await webDevicesApprovedBy(db, userId, approverDeviceId);
  if (web.size === 0) return 0;
  const ended = new Set<string>();
  for (const session of await mas.activeSessions(masId)) {
    if (!session.deviceId || !web.has(session.deviceId)) continue;
    await mas.finishSession(session);
    ended.add(session.deviceId);
  }
  await db.query("DELETE FROM web_links WHERE user_id = $1 AND approver_device_id = $2", [userId, approverDeviceId]);
  return ended.size;
}

/** POST /v1/web-link/sign-out: the phone signs out the web sessions it approved before it leaves the account (bipe#398). */
export async function signOutWebLinks(mas: Mas, db: Db, userId: string, deviceId: string | null): Promise<number> {
  if (!deviceId) throw new ApiError("bad_request", "device");
  const user = await mas.userByUsername(userId.slice(1).split(":")[0]!);
  if (!user) throw new ApiError("unauthorized");
  return endWebLinks(mas, db, user.id, userId, deviceId);
}

/** True when the device is a web session that a phone of the account approved (table web_links). */
async function isWebDevice(db: Db, userId: string, deviceId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM web_links WHERE user_id = $1 AND web_device_id = $2", [userId, deviceId]);
  return rows.length > 0;
}

/** Only a phone signs devices out (ADR 0291): refuses a caller without a device or a caller that is a recorded web session. */
async function requirePhoneCaller(db: Db, userId: string, callerDeviceId: string | null): Promise<string> {
  if (!callerDeviceId) throw new ApiError("bad_request", "device");
  if (await isWebDevice(db, userId, callerDeviceId)) throw new ApiError("bad_request", "web_device");
  return callerDeviceId;
}

/**
 * DELETE /v1/me/devices/{deviceId} (ADR 0291, bipe#1480): finishes every active MAS session of the account whose
 * Matrix device is the target, then forgets the target's web sign-in record. Throws not_found when no active session
 * has that device. The caller's own device is refused: that is sign-out.
 */
export async function signOutDevice(mas: WebLinkMas, db: Db, masId: string, userId: string, callerDeviceId: string | null, targetDeviceId: string): Promise<void> {
  const caller = await requirePhoneCaller(db, userId, callerDeviceId);
  if (targetDeviceId === caller) throw new ApiError("bad_request", "own_device");
  const sessions = (await mas.activeSessions(masId)).filter((s) => s.deviceId === targetDeviceId);
  if (sessions.length === 0) throw new ApiError("not_found");
  for (const session of sessions) await mas.finishSession(session);
  await db.query("DELETE FROM web_links WHERE user_id = $1 AND web_device_id = $2", [userId, targetDeviceId]);
}

/**
 * POST /v1/me/devices/sign-out-others (ADR 0291, bipe#1480): finishes every active MAS session of the account except
 * the caller device's sessions. MAS browser sessions with no device are finished too: one of them can approve a new
 * device. Forgets the web sign-in records of the devices it signed out. Returns the number of devices signed out.
 */
export async function signOutOtherDevices(mas: WebLinkMas, db: Db, masId: string, userId: string, callerDeviceId: string | null): Promise<number> {
  const caller = await requirePhoneCaller(db, userId, callerDeviceId);
  const ended = new Set<string>();
  for (const session of await mas.activeSessions(masId)) {
    if (session.deviceId === caller) continue;
    await mas.finishSession(session);
    if (session.deviceId) ended.add(session.deviceId);
  }
  if (ended.size > 0) await db.query("DELETE FROM web_links WHERE user_id = $1 AND web_device_id = ANY($2::text[])", [userId, [...ended]]);
  return ended.size;
}

export type Place = { city?: string; region?: string; country?: string };

/**
 * GeoIP city lookup from a database file on the server (DB-IP "IP to City Lite", CC BY 4.0; bipe-infra
 * k8s/bipe/geoip.yaml). The IP goes to no outside service and is never logged. The file is read again
 * when its modification time changes (monthly update job).
 */
export class Geo {
  private reader?: Reader<CityResponse>;
  private mtimeMs = 0;
  private checkedAt = 0;

  constructor(private readonly path: string | undefined) {
    this.reload();
  }

  get enabled(): boolean {
    return this.reader !== undefined;
  }

  place(ip: string): Place {
    if (isIP(ip) === 0) throw new ApiError("bad_request", "ip");
    if (Date.now() - this.checkedAt > 3_600_000) this.reload();
    const r = this.reader?.get(ip);
    if (!r) return {};
    const name = (n?: Record<string, string>) => n?.["pt-BR"] ?? n?.en;
    const place: Place = {};
    const city = name(r.city?.names as Record<string, string> | undefined);
    const region = name(r.subdivisions?.[0]?.names as Record<string, string> | undefined);
    const country = r.country?.iso_code;
    if (city) place.city = city;
    if (region) place.region = region;
    if (country) place.country = country;
    return place;
  }

  private reload(): void {
    this.checkedAt = Date.now();
    if (!this.path) return;
    try {
      const mtimeMs = statSync(this.path).mtimeMs;
      if (this.reader && mtimeMs === this.mtimeMs) return;
      this.reader = new Reader<CityResponse>(readFileSync(this.path));
      this.mtimeMs = mtimeMs;
      console.log(`geoip: loaded (${new Date(this.reader.metadata.buildEpoch).toISOString().slice(0, 10)})`);
    } catch (e) {
      // Keep the old reader when the new file cannot be read (for example during the update).
      if (!this.reader) console.error(`geoip: not loaded (${(e as NodeJS.ErrnoException).code ?? "read failed"})`);
    }
  }
}
