// Synapse admin API for account deletion (ADR 0140, bipe#528). The token is SYNAPSE_ADMIN_TOKEN, a MAS compatibility
// token of a dedicated admin account. Errors carry the path name and the HTTP status only: bodies can echo user IDs or
// room names.

export interface StateEvent {
  type: string;
  state_key: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

export type RedactStatus = "scheduled" | "active" | "completed" | "failed";

/** What the deletion job needs from Synapse. Tests give a fake. */
export interface SynapseAdminApi {
  joinedRooms(userId: string): Promise<string[]>;
  roomState(roomId: string): Promise<StateEvent[]>;
  makeRoomAdmin(roomId: string, userId: string): Promise<void>;
  /** Starts the redaction of every event the user sent in the rooms the user is in. Returns the job id. */
  redactUser(userId: string): Promise<string>;
  redactStatus(redactId: string): Promise<{ status: RedactStatus; failed: number }>;
  /** Deactivates and erases the user. Idempotent. */
  deactivate(userId: string): Promise<void>;
}

export class SynapseHttpError extends Error {
  constructor(readonly what: string, readonly status: number) {
    super(`synapse admin ${what}: HTTP ${status}`);
  }
}

export class SynapseAdmin implements SynapseAdminApi {
  constructor(private readonly synapseUrl: string, private readonly token: string) {}

  async joinedRooms(userId: string): Promise<string[]> {
    const body = await this.call("joined_rooms", "GET", `/v1/users/${encodeURIComponent(userId)}/joined_rooms`);
    return Array.isArray(body.joined_rooms) ? body.joined_rooms.filter((r: unknown): r is string => typeof r === "string") : [];
  }

  async roomState(roomId: string): Promise<StateEvent[]> {
    const body = await this.call("room_state", "GET", `/v1/rooms/${encodeURIComponent(roomId)}/state`);
    return Array.isArray(body.state) ? body.state : [];
  }

  async makeRoomAdmin(roomId: string, userId: string): Promise<void> {
    await this.call("make_room_admin", "POST", `/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`, { user_id: userId });
  }

  async redactUser(userId: string): Promise<string> {
    // rooms: [] means every room the user is in. Synapse runs it as a background task.
    const body = await this.call("redact", "POST", `/v1/user/${encodeURIComponent(userId)}/redact`, { rooms: [] });
    if (typeof body.redact_id !== "string") throw new SynapseHttpError("redact", 200);
    return body.redact_id;
  }

  async redactStatus(redactId: string): Promise<{ status: RedactStatus; failed: number }> {
    const body = await this.call("redact_status", "GET", `/v1/user/redact_status/${encodeURIComponent(redactId)}`);
    const failed = body.failed_redactions && typeof body.failed_redactions === "object" ? Object.keys(body.failed_redactions).length : 0;
    return { status: body.status, failed };
  }

  async deactivate(userId: string): Promise<void> {
    await this.call("deactivate", "POST", `/v1/deactivate/${encodeURIComponent(userId)}`, { erase: true });
  }

  private async call(what: string, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.synapseUrl.replace(/\/$/, "")}/_synapse/admin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new SynapseHttpError(what, res.status);
    return res.json();
  }
}
