import type { Config } from "./config.js";

// Synapse admin API with a MAS client_credentials token of the admin-only client (ADR 0140). Only the
// deletion CronJob builds this class: the API server never has SYNAPSE_ADMIN_CLIENT_SECRET.
export class SynapseAdmin {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: Config) {
    if (!config.SYNAPSE_ADMIN_CLIENT_ID || !config.SYNAPSE_ADMIN_CLIENT_SECRET) {
      throw new Error("SYNAPSE_ADMIN_CLIENT_ID and SYNAPSE_ADMIN_CLIENT_SECRET are not set");
    }
  }

  async joinedRooms(userId: string): Promise<string[]> {
    return ((await this.call("GET", `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/joined_rooms`)) as { joined_rooms: string[] }).joined_rooms;
  }

  /** The room's current state events (power levels and memberships, with their timestamps). */
  async roomState(roomId: string): Promise<StateEvent[]> {
    return ((await this.call("GET", `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`)) as { state: StateEvent[] }).state;
  }

  /** Synapse uses a local room admin (here: the leaving owner) to raise the user to the top power level. */
  async makeRoomAdmin(roomId: string, userId: string): Promise<void> {
    await this.call("POST", `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`, { user_id: userId });
  }

  /** Redacts every event the user sent, in every room. Synapse runs it in the background. */
  async redactAll(userId: string): Promise<void> {
    await this.call("POST", `/_synapse/admin/v1/user/${encodeURIComponent(userId)}/redact`, { rooms: [] });
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.config.SYNAPSE_URL.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) this.token = undefined;
    // Status and path only: bodies can name users and rooms.
    if (!res.ok) throw new Error(`synapse admin ${method} ${path.split("/").slice(0, 5).join("/")}: HTTP ${res.status}`);
    return res.json();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${this.config.MAS_URL.replace(/\/$/, "")}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "urn:synapse:admin:*",
        client_id: this.config.SYNAPSE_ADMIN_CLIENT_ID!,
        client_secret: this.config.SYNAPSE_ADMIN_CLIENT_SECRET!,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`synapse admin token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }
}

export interface StateEvent {
  type: string;
  state_key: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, any>;
}
