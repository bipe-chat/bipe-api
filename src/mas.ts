import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

// Client for the MAS admin API (client_credentials, scope urn:mas:admin).
export class Mas {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: Config) {}

  async userByUsername(username: string): Promise<{ id: string } | null> {
    const res = await this.call("GET", `/users/by-username/${encodeURIComponent(username)}`);
    if (res.status === 404) return null;
    return { id: (await this.json(res)).data.id };
  }

  /** The MAS user and whether MAS already deactivated it (account deletion, ADR 0140). Null when unknown. */
  async userState(username: string): Promise<{ id: string; deactivated: boolean } | null> {
    const res = await this.call("GET", `/users/by-username/${encodeURIComponent(username)}`);
    if (res.status === 404) return null;
    const { id, attributes: a } = (await this.json(res)).data;
    return { id, deactivated: Boolean(a?.deactivated_at) };
  }

  /** True only when MAS marks the user admin (mas-cli manage promote-admin) and the user is active. */
  async isAdmin(username: string): Promise<boolean> {
    const res = await this.call("GET", `/users/by-username/${encodeURIComponent(username)}`);
    if (res.status === 404) return false;
    const { attributes: a } = (await this.json(res)).data;
    return a.admin === true && !a.locked_at && !a.deactivated_at;
  }

  /** Returns the MAS user id, or null when the username already exists. */
  async createUser(username: string, displayname?: string): Promise<string | null> {
    const res = await this.call("POST", "/users", { username, ...(displayname ? { displayname } : {}) });
    if (res.status === 409) return null;
    return (await this.json(res)).data.id;
  }

  /** Returns false when MAS rejects the password (complexity policy). */
  async setPassword(userId: string, password: string): Promise<boolean> {
    const res = await this.call("POST", `/users/${userId}/set-password`, { password });
    if (res.status === 400) return false;
    // 204 No Content on success.
    if (!res.ok) await this.json(res);
    return true;
  }

  async emailInUse(email: string): Promise<boolean> {
    const res = await this.call("GET", `/user-emails?filter[email]=${encodeURIComponent(email)}&page[first]=1`);
    return (await this.json(res)).data.length > 0;
  }

  /** The MAS user id that holds the address as a login email (beta accounts), or null. */
  async emailOwner(email: string): Promise<string | null> {
    const res = await this.call("GET", `/user-emails?filter[email]=${encodeURIComponent(email)}&page[first]=1`);
    const data = (await this.json(res)).data as { attributes: { user_id: string } }[];
    return data[0]?.attributes.user_id ?? null;
  }

  /** Returns false when the address is already attached to a user. */
  async addEmail(userId: string, email: string): Promise<boolean> {
    const res = await this.call("POST", "/user-emails", { user_id: userId, email });
    if (res.status === 409) return false;
    await this.json(res);
    return true;
  }

  /** IDs of the active MAS browser sessions of a user that started after `after` (web sign-in, ADR 0118). */
  async activeBrowserSessionsSince(userId: string, after: Date): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    // A user has few browser sessions; the loop stops at 10 pages in case MAS misbehaves.
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ "filter[user]": userId, "filter[status]": "active", "filter[created-after]": after.toISOString(), "page[first]": "100" });
      if (cursor) q.set("page[after]", cursor);
      const body = await this.json(await this.call("GET", `/user-sessions?${q}`));
      const data = body.data as { id: string; attributes?: { created_at?: string } }[];
      // Check created_at here too: if MAS ignores the filter, older sessions (staff browsers) must stay.
      // A session without a readable created_at is not finished (fail closed).
      ids.push(...data.filter((s) => Date.parse(s.attributes?.created_at ?? "") >= after.getTime()).map((s) => s.id));
      if (data.length < 100) break;
      cursor = data.at(-1)!.id;
    }
    return ids;
  }

  async finishBrowserSession(sessionId: string): Promise<void> {
    const res = await this.call("POST", `/user-sessions/${encodeURIComponent(sessionId)}/finish`, {});
    // 400: the session is already finished.
    if (!res.ok && res.status !== 400) await this.json(res);
  }

  // Theft mark (ADR 0051, bipe#600). Endpoints of the MAS 1.26 admin API; the session filters are unverified against a
  // real MAS until the real stack test covers them (test/real).

  async lockUser(userId: string): Promise<void> {
    const res = await this.call("POST", `/users/${encodeURIComponent(userId)}/lock`, {});
    if (!res.ok) await this.json(res);
  }

  async unlockUser(userId: string): Promise<void> {
    const res = await this.call("POST", `/users/${encodeURIComponent(userId)}/unlock`, {});
    if (!res.ok) await this.json(res);
  }

  /** Every active compatibility, OAuth 2.0 and browser session of a user, with its Matrix device when MAS names one. */
  async activeSessions(userId: string): Promise<MasSession[]> {
    const out: MasSession[] = [];
    for (const kind of ["compat-sessions", "oauth2-sessions", "user-sessions"] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ "filter[user]": userId, "filter[status]": "active", "page[first]": "100" });
        if (cursor) q.set("page[after]", cursor);
        const body = await this.json(await this.call("GET", `/${kind}?${q}`));
        const data = body.data as { id: string; attributes?: { device_id?: string | null; scope?: string | null; finished_at?: string | null } }[];
        for (const s of data) {
          if (s.attributes?.finished_at) continue;
          out.push({ kind, id: s.id, deviceId: deviceOf(s.attributes) });
        }
        if (data.length < 100) break;
        cursor = data.at(-1)!.id;
      }
    }
    return out;
  }

  async finishSession(session: MasSession): Promise<void> {
    const res = await this.call("POST", `/${session.kind}/${encodeURIComponent(session.id)}/finish`, {});
    // 400: the session is already finished.
    if (!res.ok && res.status !== 400) await this.json(res);
  }

  async deactivate(userId: string): Promise<void> {
    const res = await this.call("POST", `/users/${userId}/deactivate`, {});
    if (!res.ok) await this.json(res);
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.config.MAS_ADMIN_URL.replace(/\/$/, "")}/api/admin/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) this.token = undefined;
    return res;
  }

  private async json(res: Response): Promise<any> {
    if (!res.ok) {
      // Status only: MAS error bodies can echo input.
      console.error(`mas admin api: HTTP ${res.status}`);
      throw new ApiError("internal");
    }
    return res.json();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${this.config.MAS_URL.replace(/\/$/, "")}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "urn:mas:admin",
        client_id: this.config.MAS_CLIENT_ID,
        client_secret: this.config.MAS_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`mas token: HTTP ${res.status}`);
      throw new ApiError("internal");
    }
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }
}

export type MasSession = { kind: "compat-sessions" | "oauth2-sessions" | "user-sessions"; id: string; deviceId: string | null };

/** The Matrix device of a MAS session: device_id (compatibility) or the device scope token (OAuth 2.0). */
export function deviceOf(a: { device_id?: string | null; scope?: string | null } | undefined): string | null {
  if (a?.device_id) return a.device_id;
  const m = /(?:^| )urn:matrix:(?:org\.matrix\.msc2967\.)?client:device:(\S+)/.exec(a?.scope ?? "");
  return m?.[1] ?? null;
}

