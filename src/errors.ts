// Error ids match proseio-shared/api/openapi.yaml components.schemas.Error.
export type ErrorId =
  | "bad_request"
  | "invite_invalid"
  | "email_taken"
  | "handle_invalid"
  | "handle_taken"
  | "handle_cooldown"
  | "password_weak"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorId, 400 | 401 | 403 | 404 | 409 | 429 | 500> = {
  bad_request: 400,
  invite_invalid: 403,
  email_taken: 409,
  handle_invalid: 400,
  handle_taken: 409,
  handle_cooldown: 429,
  password_weak: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    readonly id: ErrorId,
    readonly reason?: string,
    readonly extra?: Record<string, string>,
  ) {
    super(id);
  }

  get status() {
    return STATUS[this.id];
  }

  body() {
    return { error: this.id, ...(this.reason ? { reason: this.reason } : {}), ...this.extra };
  }
}
