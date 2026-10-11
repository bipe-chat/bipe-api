import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";

const TTL_MS = 60_000;

// Resolves a Matrix access token to its user ID through Synapse whoami (Synapse asks MAS).
export class MatrixAuth {
  private cache = new Map<string, { userId: string; until: number }>();

  constructor(private readonly config: Config) {}

  async userId(authorization: string | undefined): Promise<string> {
    const token = authorization?.match(/^Bearer ([\x21-\x7e]{8,4096})$/)?.[1];
    if (!token) throw new ApiError("unauthorized");
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.userId;

    const res = await fetch(`${this.config.SYNAPSE_URL.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new ApiError("unauthorized");
    if (!res.ok) {
      console.error(`synapse whoami: HTTP ${res.status}`);
      throw new ApiError("internal");
    }
    const { user_id: userId } = (await res.json()) as { user_id: string };
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { userId, until: Date.now() + TTL_MS });
    return userId;
  }
}
