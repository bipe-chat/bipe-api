// Ring only the person who has the chat (bipe#1063 point 3, ADR 0284 point 23). Synapse sends each push of a pusher to
// push.bipe.net.br; the edge sends POST /_matrix/push/v1/notify here, and this filter passes it on to Sygnal. When the
// room is a customer chat with an assignee (business_chats), the devices of the other people of that work account get
// no push. Every other push passes unchanged: a chat in the pool rings every phone, as before.
// A pusher is the same for every device of the account, so a Matrix push rule cannot do this; the filter matches the
// pushkey and the account_route of the pusher to its device, and the device to its seat (business_seat_devices).
// Fails open: when a lookup fails, the push goes to every device. A missed customer message costs more than a ring.
// Logs carry counts and HTTP statuses only: never a room ID, a user ID, a device ID or a pushkey.
import type { Queryable } from "./business-common.js";
import type { Pusher } from "./synapse-admin.js";

/** The path of the push gateway API. Synapse calls it on push.bipe.net.br. */
export const NOTIFY_PATH = "/_matrix/push/v1/notify";
const PUSHERS_TTL_MS = 60_000;
const PUSHERS_CACHE_MAX = 1_000;

export interface PushFilterDeps {
  db: Queryable;
  /** Null without SYNAPSE_ADMIN_TOKEN: nothing is filtered. */
  pushers: ((userId: string) => Promise<Pusher[]>) | null;
  /** Null without SYGNAL_URL: the route answers 502. */
  sygnalUrl: string | null;
}

/** One device of a notify request (push gateway API). Other keys pass unchanged. */
interface NotifyDevice {
  pushkey?: unknown;
  data?: { default_payload?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

const routeOf = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;
  const payload = (data as Record<string, unknown>).default_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const route = (payload as Record<string, unknown>).account_route;
  return typeof route === "string" ? route : null;
};

/** A pusher is known by its pushkey and its account_route: one phone has the same pushkey for each account on it. */
const pusherKey = (pushkey: unknown, data: unknown): string | null => {
  const route = routeOf(data);
  return typeof pushkey === "string" && route !== null ? `${pushkey}\n${route}` : null;
};

const cache = new Map<string, { at: number; pushers: Pusher[] }>();

async function cachedPushers(deps: PushFilterDeps, userId: string, now: number): Promise<Pusher[]> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < PUSHERS_TTL_MS) return hit.pushers;
  const pushers = await deps.pushers!(userId);
  if (cache.size >= PUSHERS_CACHE_MAX) cache.clear();
  cache.set(userId, { at: now, pushers });
  return pushers;
}

/**
 * The pusher keys that stay silent for a push in `roomId`: the pushers of every device of a seat other than the
 * assignee, on each work account that has the room assigned. Empty when nobody has the chat.
 */
export async function silentPushers(deps: PushFilterDeps, roomId: string, now = Date.now()): Promise<Set<string>> {
  const silent = new Set<string>();
  if (!deps.pushers) return silent;
  const { rows } = await deps.db.query<{ business_id: string; device_id: string }>(
    `SELECT c.business_id, d.device_id FROM business_chats c
       JOIN business_seat_devices d ON d.business_id = c.business_id
      WHERE c.room_id = $1 AND c.assignee_seat_id IS NOT NULL AND d.seat_id <> c.assignee_seat_id`,
    [roomId],
  );
  const byBusiness = new Map<string, Set<string>>();
  for (const r of rows) {
    const devices = byBusiness.get(r.business_id) ?? new Set<string>();
    devices.add(r.device_id);
    byBusiness.set(r.business_id, devices);
  }
  for (const [businessId, devices] of byBusiness) {
    for (const p of await cachedPushers(deps, businessId, now)) {
      if (typeof p.device_id !== "string" || !devices.has(p.device_id)) continue;
      const key = pusherKey(p.pushkey, p.data);
      if (key) silent.add(key);
    }
  }
  return silent;
}

/**
 * The notify body to send on, or null when no device is left. `body` is the parsed request; a body this filter does
 * not understand passes unchanged.
 */
export async function filterNotify(deps: PushFilterDeps, body: unknown): Promise<unknown | null> {
  const notification = (body as { notification?: unknown } | null)?.notification;
  if (!notification || typeof notification !== "object") return body;
  const { room_id: roomId, devices } = notification as { room_id?: unknown; devices?: unknown };
  if (typeof roomId !== "string" || !Array.isArray(devices)) return body;
  const silent = await silentPushers(deps, roomId);
  if (silent.size === 0) return body;
  const kept = (devices as NotifyDevice[]).filter((d) => {
    const key = pusherKey(d?.pushkey, d?.data);
    return key === null || !silent.has(key);
  });
  if (kept.length === devices.length) return body;
  if (kept.length === 0) return null;
  return { ...(body as object), notification: { ...notification, devices: kept } };
}

/** Handles one notify request: filters it, sends it on to Sygnal and gives back Sygnal's answer. */
export async function relayNotify(deps: PushFilterDeps, raw: string): Promise<Response> {
  if (!deps.sygnalUrl) return Response.json({ error: "push gateway off" }, { status: 502 });
  let out = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    const filtered = await filterNotify(deps, parsed);
    // A dropped device is not a rejected pushkey: Synapse would delete a rejected pusher.
    if (filtered === null) return Response.json({ rejected: [] });
    if (filtered !== parsed) out = JSON.stringify(filtered);
  } catch (e) {
    console.error(`push filter: ${(e as Error).name}, sent unfiltered`);
  }
  const res = await fetch(`${deps.sygnalUrl.replace(/\/$/, "")}${NOTIFY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: out,
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => {
    console.error(`push filter: gateway ${e.name}`);
    return null;
  });
  if (!res) return Response.json({ error: "push gateway unreachable" }, { status: 502 });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}
