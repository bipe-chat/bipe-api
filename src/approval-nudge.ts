import type { Pusher } from "./synapse-admin.js";

// Approval nudge (bipe-chat/bipe#628, bipe-shared spec device-verification). A new device asks the other devices of
// the account for approval with a Matrix to-device event, and Synapse does not push to-device events. So the new
// device calls POST /v1/me/approval-nudge, and this sends one content-free push through Sygnal to each other Bipe Next
// device of the account. The push only opens Bipe there; the sync then delivers the request. It approves nothing.
// Logs carry counts and HTTP statuses only: never a user ID, a device ID or a pushkey.

/** The marker the apps read (spec notification-service, kind deviceApproval). */
export const NUDGE_KIND = "device_approval";
/** APNs format event_id_only needs an event ID, else Sygnal builds a full payload. Not a real event. */
export const NUDGE_EVENT_ID = "$device_approval";

/** One device in a Sygnal notify request (push gateway API). */
export interface GatewayDevice {
  app_id: string;
  pushkey: string;
  data: Record<string, unknown>;
}

/**
 * The pushers that get the nudge: enabled HTTP pushers with format event_id_only and an account_route in their
 * default_payload (Bipe Next registers only these, spec push-registration), of a known device other than the caller's.
 * Each keeps its own data, with the marker added to the default_payload, so Sygnal puts the route and the marker in
 * the push.
 */
export function nudgeDevices(pushers: Pusher[], callerDeviceId: string): GatewayDevice[] {
  return pushers.flatMap((p) => {
    const data = p.data ?? {};
    const payload = data.default_payload;
    if (p.kind !== "http" || p.enabled === false) return [];
    if (typeof p.device_id !== "string" || p.device_id === "" || p.device_id === callerDeviceId) return [];
    if (data.format !== "event_id_only") return [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    if (typeof (payload as Record<string, unknown>).account_route !== "string") return [];
    return [{ app_id: p.app_id, pushkey: p.pushkey, data: { ...data, default_payload: { ...payload, bipe_push_kind: NUDGE_KIND } } }];
  });
}

export interface NudgeDeps {
  /** Null without SYNAPSE_ADMIN_TOKEN: the route answers 204 and sends nothing. */
  pushers: ((userId: string) => Promise<Pusher[]>) | null;
  /** Null without SYGNAL_URL. */
  sygnalUrl: string | null;
}

/** Sends the nudge. Best effort: a gateway failure is logged and the caller still gets 204. */
export async function sendApprovalNudge(deps: NudgeDeps, userId: string, callerDeviceId: string): Promise<void> {
  if (!deps.pushers || !deps.sygnalUrl) return;
  const devices = nudgeDevices(await deps.pushers(userId), callerDeviceId);
  if (devices.length === 0) return;
  const res = await fetch(`${deps.sygnalUrl.replace(/\/$/, "")}/_matrix/push/v1/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notification: { event_id: NUDGE_EVENT_ID, prio: "high", devices } }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => {
    console.error(`approval nudge: gateway ${e.name}`);
    return null;
  });
  if (res && !res.ok) console.error(`approval nudge: gateway HTTP ${res.status}`);
}
