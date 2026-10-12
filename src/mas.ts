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

  /** Returns false when the address is already attached to a user. */
  async addEmail(userId: string, email: string): Promise<boolean> {
    const res = await this.call("POST", "/user-emails", { user_id: userId, email });
    if (res.status === 409) return false;
    await this.json(res);
    return true;
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
