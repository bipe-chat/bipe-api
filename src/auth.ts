import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import type { Mas } from "./mas.js";
import { isBipeServer } from "./registry.js";

const TTL_MS = 60_000;

// Resolves a Matrix access token to its user ID (and device ID) through Synapse whoami (Synapse asks MAS).
export class MatrixAuth {
  private cache = new Map<string, { userId: string; deviceId: string | null; until: number }>();

  private openIdCache = new Map<string, { userId: string; until: number }>();

  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * Core routes (ADR 0168, bipe-chat/bipe#646). Without `serverName` this is ``session``: an access token of this
   * homeserver through whoami. With `serverName` (header X-Matrix-Server-Name), the token is a Matrix OpenID token
   * from `POST /_matrix/client/v3/user/{userId}/openid/request_token` on that server. The server must be in
   * registries/bipe-servers.json; it answers who the token belongs to through federation `openid/userinfo`, and only
   * for its own users. deviceId is null: an OpenID token names no device.
   */
  async coreSession(authorization: string | undefined, serverName: string | undefined): Promise<{ userId: string; deviceId: string | null }> {
    if (serverName === undefined) return this.session(authorization);
    const token = authorization?.match(/^Bearer ([\x21-\x7e]{8,4096})$/)?.[1];
    if (!token || !isBipeServer(serverName)) throw new ApiError("unauthorized");
    const key = createHash("sha256").update(`${serverName}\n${token}`).digest("hex");
    const hit = this.openIdCache.get(key);
    if (hit && hit.until > Date.now()) return { userId: hit.userId, deviceId: null };

    const base = await this.federationBase(serverName);
    const res = await this.fetcher(`${base}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new ApiError("unauthorized");
    if (!res.ok) {
      console.error(`openid userinfo ${serverName}: HTTP ${res.status}`);
      throw new ApiError("internal");
    }
    const { sub } = (await res.json()) as { sub?: unknown };
    // A server vouches only for its own users.
    if (typeof sub !== "string" || serverOf(sub) !== serverName) throw new ApiError("unauthorized");
    if (this.openIdCache.size > 10_000) this.openIdCache.clear();
    this.openIdCache.set(key, { userId: sub, until: Date.now() + TTL_MS });
    return { userId: sub, deviceId: null };
  }

  async coreUserId(authorization: string | undefined, serverName: string | undefined): Promise<string> {
    return (await this.coreSession(authorization, serverName)).userId;
  }

  /**
   * Where to reach a server's federation API. This homeserver: SYNAPSE_URL, inside the cluster. Another server: the
   * delegation in https://<server>/.well-known/matrix/server, else <server>:8448 (Matrix spec, server discovery).
   */
  private async federationBase(serverName: string): Promise<string> {
    if (serverName === this.config.SERVER_NAME) return this.config.SYNAPSE_URL.replace(/\/$/, "");
    try {
      const res = await this.fetcher(`https://${serverName}/.well-known/matrix/server`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const delegated = ((await res.json()) as { "m.server"?: unknown })["m.server"];
        if (typeof delegated === "string" && /^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(delegated)) {
          return `https://${delegated.includes(":") ? delegated : `${delegated}:8448`}`;
        }
      }
    } catch {
      // No delegation: the default port.
    }
    return `https://${serverName}:8448`;
  }

  async userId(authorization: string | undefined): Promise<string> {
    return (await this.session(authorization)).userId;
  }

  /** The user and the device of the token. deviceId is null for a token without a device. */
  async session(authorization: string | undefined): Promise<{ userId: string; deviceId: string | null }> {
    const token = authorization?.match(/^Bearer ([\x21-\x7e]{8,4096})$/)?.[1];
    if (!token) throw new ApiError("unauthorized");
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return { userId: hit.userId, deviceId: hit.deviceId };

    const res = await fetch(`${this.config.SYNAPSE_URL.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new ApiError("unauthorized");
    if (!res.ok) {
      console.error(`synapse whoami: HTTP ${res.status}`);
      throw new ApiError("internal");
    }
    const { user_id: userId, device_id } = (await res.json()) as { user_id: string; device_id?: string };
    const deviceId = typeof device_id === "string" && device_id.length > 0 ? device_id : null;
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { userId, deviceId, until: Date.now() + TTL_MS });
    return { userId, deviceId };
  }
}

/** The server name of a Matrix user ID: everything after the first ':', or null. */
function serverOf(userId: string): string | null {
  const colon = userId.indexOf(":");
  return userId.startsWith("@") && colon >= 2 ? userId.slice(colon + 1) : null;
}

// Staff routes (ADR 0056): the caller must be a MAS admin, the same gate as Element Admin (ADR 0027).
// Everyone else gets not_found, so the routes do not show that they exist.
export class StaffGate {
  private cache = new Map<string, { admin: boolean; until: number }>();

  constructor(private readonly auth: MatrixAuth, private readonly mas: Mas) {}

  async userId(authorization: string | undefined): Promise<string> {
    const userId = await this.auth.userId(authorization);
    const hit = this.cache.get(userId);
    const admin = hit && hit.until > Date.now() ? hit.admin : await this.mas.isAdmin(userId.slice(1).split(":")[0]!);
    if (!hit || hit.until <= Date.now()) this.cache.set(userId, { admin, until: Date.now() + TTL_MS });
    if (!admin) throw new ApiError("not_found");
    return userId;
  }
}
