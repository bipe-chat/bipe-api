import { RateLimiter } from "./ratelimit.js";

const HOUR_MS = 3_600_000;

/**
 * Sign-up limits (bipe#395). Two kinds:
 * - Attempts per IP, checked before any proof. They are cheap and bound the cost of bad requests.
 * - Account creations in total, taken in createAccount() only after the attestation, terms, PIN and invite checks
 *   pass, and given back when the sign-up fails. Rejected attempts never use a creation, so they cannot block
 *   sign-ups from other IPs.
 */
export class SignupLimits {
  // Brazilian carriers put many phones behind one IP (CGNAT), so a request with an attestation gets more attempts.
  // A forged attestation fails first in createAccount(), before the invite check and before a creation is taken.
  private readonly attempts = new RateLimiter(5, HOUR_MS);
  private readonly attemptsAttested = new RateLimiter(30, HOUR_MS);
  private readonly creations: RateLimiter;

  constructor(maxCreationsPerHour: number) {
    this.creations = new RateLimiter(maxCreationsPerHour, HOUR_MS);
  }

  attempt(ip: string, attested: boolean): void {
    (attested ? this.attemptsAttested : this.attempts).check(ip);
  }

  /** One account creation. Throws rate_limited when the hour is full; returns the give-back. */
  readonly creation = (): (() => void) => this.creations.take("all");
}
