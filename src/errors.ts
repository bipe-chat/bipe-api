// Error ids match bipe-shared/api/openapi.yaml components.schemas.Error.
export type ErrorId =
  | "bad_request"
  | "invite_invalid"
  | "invite_quota_exhausted"
  | "email_taken"
  | "handle_invalid"
  | "handle_taken"
  | "handle_cooldown"
  | "password_weak"
  | "attestation_invalid"
  | "profile_invalid"
  | "photo_invalid"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "internal"
  | "cnpj_invalid"
  | "cnpj_not_active"
  | "cnpj_taken"
  | "signature_invalid"
  | "pin_weak"
  | "pin_wrong"
  | "pin_blocked"
  | "pin_not_set"
  | "recovery_invalid"
  | "email_unavailable"
  | "terms_required"
  | "support_unavailable"
  // Business tools (bipe-shared api/business-schemas.json AgendaError, BusinessToolError).
  | "slot_taken"
  | "hold_expired"
  | "too_many_open_bookings"
  | "outside_notice"
  | "outside_horizon"
  | "agenda_not_published"
  | "cancellation_window_closed"
  | "queue_closed"
  | "already_in_queue"
  | "place_not_active"
  | "quote_expired"
  | "quote_version_changed"
  | "quote_not_open"
  | "order_already_open"
  | "order_not_open"
  | "item_unavailable"
  | "price_not_fixed"
  | "orders_closed"
  | "payment_requires_verified_business"
  | "pix_charge_unavailable";

const STATUS: Record<ErrorId, 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503> = {
  bad_request: 400,
  invite_invalid: 403,
  invite_quota_exhausted: 403,
  email_taken: 409,
  handle_invalid: 400,
  handle_taken: 409,
  handle_cooldown: 429,
  password_weak: 400,
  attestation_invalid: 403,
  profile_invalid: 400,
  photo_invalid: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
  cnpj_invalid: 400,
  cnpj_not_active: 403,
  cnpj_taken: 409,
  signature_invalid: 403,
  pin_weak: 400,
  pin_wrong: 403,
  pin_blocked: 403,
  pin_not_set: 409,
  recovery_invalid: 403,
  email_unavailable: 503,
  terms_required: 403,
  support_unavailable: 503,
  slot_taken: 409,
  hold_expired: 409,
  too_many_open_bookings: 422,
  outside_notice: 422,
  outside_horizon: 422,
  agenda_not_published: 422,
  cancellation_window_closed: 422,
  queue_closed: 422,
  already_in_queue: 409,
  place_not_active: 409,
  quote_expired: 422,
  quote_version_changed: 409,
  quote_not_open: 409,
  order_already_open: 409,
  order_not_open: 409,
  item_unavailable: 422,
  price_not_fixed: 422,
  orders_closed: 422,
  payment_requires_verified_business: 422,
  pix_charge_unavailable: 422,
};

export class ApiError extends Error {
  constructor(
    readonly id: ErrorId,
    readonly reason?: string,
    readonly extra?: Record<string, string | number>,
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
