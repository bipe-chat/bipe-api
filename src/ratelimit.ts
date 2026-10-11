import { ApiError } from "./errors.js";

// Fixed-window limits in memory. One API instance only; move to Postgres or Redis before scaling out.
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    const now = Date.now();
    if (this.windows.size > 50_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    if (++w.count > this.limit) throw new ApiError("rate_limited");
  }
}
