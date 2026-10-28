import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import type { Mas } from "./mas.js";

// Beta sign-in with an email (bipe#627, bipe-shared api/openapi.yaml /v1/beta/login). The MAS compat login finds users
// by localpart only. This route finds the localpart of the login email, checks the password, and returns the Matrix ID.
// Unknown email and wrong password give the same answer after the same minimum time. Never log the email or password.

/** Every answer takes at least this long, so the time does not tell a known address from an unknown one. */
export const BETA_LOGIN_MIN_MS = 1500;

export async function betaLogin(
  deps: { config: Config; mas: Pick<Mas, "emailOwner" | "usernameOf" | "passwordMatches"> },
  email: string,
  password: string,
  minMs = BETA_LOGIN_MIN_MS,
): Promise<{ user_id: string }> {
  const started = Date.now();
  try {
    const owner = await deps.mas.emailOwner(email.trim().toLowerCase());
    const localpart = owner ? await deps.mas.usernameOf(owner) : null;
    if (localpart && (await deps.mas.passwordMatches(localpart, password))) {
      return { user_id: `@${localpart}:${deps.config.SERVER_NAME}` };
    }
    throw new ApiError("unauthorized");
  } finally {
    const left = minMs - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}
