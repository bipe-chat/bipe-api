import type { Pusher } from "./synapse-admin.js";

// Content-free pushes to the devices of an account (bipe-shared spec notification-service): the approval nudge
// (bipe-chat/bipe#628) and the recovery alerts (bipe-chat/bipe#171). Each push goes through Sygnal to the Bipe Next
// pushers of the account. It carries only the push kind and the pusher's own data (its account_route): no room, no
// text, no name. The push only opens Bipe there; the app then reads what it needs (the sync, GET /v1/me/account).
// Best effort: a failure is logged and never fails the request that caused the push.
// Logs carry the push kind, counts and HTTP statuses only: never a user ID, a device ID or a pushkey.

/** The bipe_push_kind values the apps read (spec notification-service). */
export type PushKind = "device_approval" | "recovery_started" | "recovery_completed";

/** APNs format event_id_only needs an event ID, else Sygnal builds a full payload. Not a real event. */
export const pushEventId = (kind: PushKind) => `$${kind}`;

/** One device in a Sygnal notify request (push gateway API). */
export interface GatewayDevice {
  app_id: string;
  pushkey: string;
  data: Record<string, unknown>;
}

/**
 * The pushers that get the push: enabled HTTP pushers with format event_id_only and an account_route in their
 * default_payload (Bipe Next registers only these, spec push-registration), of a known device other than
 * `exceptDeviceId`. Null: every device. Each keeps its own data, with the kind added to the default_payload, so Sygnal
 * puts the route and the kind in the push.
 */
export function pushDevices(pushers: Pusher[], kind: PushKind, exceptDeviceId: string | null): GatewayDevice[] {
  return pushers.flatMap((p) => {
    const data = p.data ?? {};
    const payload = data.default_payload;
    if (p.kind !== "http" || p.enabled === false) return [];
    if (typeof p.device_id !== "string" || p.device_id === "" || p.device_id === exceptDeviceId) return [];
    if (data.format !== "event_id_only") return [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    if (typeof (payload as Record<string, unknown>).account_route !== "string") return [];
    return [{ app_id: p.app_id, pushkey: p.pushkey, data: { ...data, default_payload: { ...payload, bipe_push_kind: kind } } }];
  });
}

export interface DevicePushDeps {
  /** Null without SYNAPSE_ADMIN_TOKEN: nothing is sent. */
  pushers: ((userId: string) => Promise<Pusher[]>) | null;
  /** Null without SYGNAL_URL. */
  sygnalUrl: string | null;
}

/**
 * Sends one push of `kind` to the account's Bipe Next devices, except `exceptDeviceId`. Never throws: a pusher lookup
 * or gateway failure is logged with the kind only.
 */
export async function pushToDevices(deps: DevicePushDeps | undefined, userId: string, kind: PushKind, exceptDeviceId: string | null): Promise<void> {
  if (!deps?.pushers || !deps.sygnalUrl) return;
  let devices: GatewayDevice[];
  try {
    devices = pushDevices(await deps.pushers(userId), kind, exceptDeviceId);
  } catch (e) {
    console.error(`push ${kind}: pusher lookup ${(e as Error).name}`);
    return;
  }
  if (devices.length === 0) return;
  const res = await fetch(`${deps.sygnalUrl.replace(/\/$/, "")}/_matrix/push/v1/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notification: { event_id: pushEventId(kind), prio: "high", devices } }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => {
    console.error(`push ${kind}: gateway ${e.name}`);
    return null;
  });
  if (res && !res.ok) console.error(`push ${kind}: gateway HTTP ${res.status}`);
  else if (res) console.log(`push ${kind}: sent to ${devices.length}`);
}
