// Data export (LGPD art. 18, ADR 0112): everything this API stores about the caller, as one JSON file.
// Hashes, sealed secrets and other people's data stay out. Messages live on the devices, not here.
import { bugReportsOf } from "./bug-reports.js";
import type { Db } from "./db.js";
import type { Growth } from "./growth.js";
import { inviteConnections } from "./invites.js";
import type { PhoneHasher } from "./phones.js";

const one = async <T extends Record<string, unknown>>(db: Db, sql: string, userId: string): Promise<T | null> =>
  (await db.query<T>(sql, [userId])).rows[0] ?? null;

async function phoneLink(db: Db, userId: string, phones: PhoneHasher | undefined) {
  const row = await one<{ method: string; linked_at: Date; confirmed_at: Date; number_enc: Buffer | null }>(
    db,
    "SELECT method, linked_at, confirmed_at, number_enc FROM phone_links WHERE user_id = $1",
    userId,
  );
  if (!row) return null;
  const { number_enc, ...rest } = row;
  return { ...rest, number: phones?.open(number_enc) ?? null };
}

const all = async <T extends Record<string, unknown>>(db: Db, sql: string, userId: string): Promise<T[]> =>
  (await db.query<T>(sql, [userId])).rows;

export async function exportData(db: Db, growth: Growth, userId: string, now = new Date(), phones?: PhoneHasher) {
  const profile = await one<{ enabled: boolean; name: string; bio: string; photo: Buffer | null; updated_at: Date }>(
    db,
    "SELECT enabled, name, bio, photo, updated_at FROM public_profiles WHERE user_id = $1",
    userId,
  );
  return {
    format: "bipe-data-export",
    version: 1,
    generated_at: now.toISOString(),
    user_id: userId,
    not_included: ["messages", "contacts", "media"],
    sign_up: await one(db, "SELECT created_at, account_type, attested FROM signups WHERE user_id = $1", userId),
    account: await one(
      db,
      `SELECT device_first, pin_hash IS NOT NULL AS pin_set, pin_set_at, pin_wrong_tries, pin_blocked_at,
              token_hash IS NOT NULL AS recovery_token_set, token_set_at AS recovery_token_set_at, created_at
       FROM account_secrets WHERE user_id = $1`,
      userId,
    ),
    recovery_email: await one(
      db,
      "SELECT email, verified_at, pending_email, pending_expires_at, lang FROM recovery_emails WHERE user_id = $1",
      userId,
    ),
    recoveries: await all(
      db,
      `SELECT id, method, purpose, state, created_at, started_at, ready_at, ended_at, ended_by
       FROM recoveries WHERE user_id = $1 ORDER BY created_at`,
      userId,
    ),
    // ADR 0140: a waiting account deletion request.
    account_deletion: await one(
      db,
      "SELECT id, device_id, redact_messages, state, created_at, due_at FROM account_deletions WHERE user_id = $1 AND state IN ('waiting', 'running')",
      userId,
    ),
    // bipe#531: the iPhones that moved their keychain items before the App Store transfer.
    keychain_moves: await all(db, "SELECT device_id, moved_at FROM keychain_moves WHERE user_id = $1 ORDER BY moved_at", userId),
    work_hours: await one(db, "SELECT enabled, time_zone, days, updated_at FROM work_hours WHERE user_id = $1", userId),
    // ADR 0096: the provider and the dates only. The subject hash is keyed and stays out.
    linked_accounts: await all(db, "SELECT provider, linked_at FROM account_links WHERE user_id = $1 ORDER BY provider", userId),
    link_events: await all(db, "SELECT provider, change, at FROM link_events WHERE user_id = $1 ORDER BY at", userId),
    handle: await one(db, "SELECT handle, set_at FROM handles WHERE user_id = $1", userId),
    handle_holds: await all(db, "SELECT hold_until FROM handle_holds WHERE user_id = $1 ORDER BY hold_until", userId),
    handle_changes: await all(
      db,
      "SELECT old_handle, new_handle, source, changed_at FROM handle_changes WHERE user_id = $1 ORDER BY changed_at",
      userId,
    ),
    theft: await theftExport(db, userId),
    profile_changes: await all(db, "SELECT kind, source, changed_at FROM profile_changes WHERE user_id = $1 ORDER BY changed_at", userId),
    public_profile: profile && {
      enabled: profile.enabled,
      name: profile.name,
      bio: profile.bio,
      photo_jpeg_base64: profile.photo ? profile.photo.toString("base64") : null,
      updated_at: profile.updated_at,
    },
    messaging: await one(db, "SELECT policy AS who_can_message, updated_at FROM messaging_policies WHERE user_id = $1", userId),
    discovery: await one(db, "SELECT by_phone FROM discovery_settings WHERE user_id = $1", userId),
    // The owner's own number, opened from number_enc (ADR 0191); null for a link made before. The HMAC stays out.
    phone_link: await phoneLink(db, userId, phones),
    invites_created: await all(
      db,
      "SELECT id, uses_left, expires_at, created_at, revoked_at FROM invites WHERE created_by = $1 ORDER BY created_at",
      userId,
    ),
    invite_grants: await one(db, "SELECT extra FROM invite_grants WHERE user_id = $1", userId),
    invite_connections: (await inviteConnections(db, userId)).user_ids,
    business: await one(
      db,
      "SELECT cnpj, status, reason, method, created_at, verified_at, ended_at FROM business_claims WHERE user_id = $1",
      userId,
    ),
    // The CPF hash stays out (a hash); the CPF, the signed PDF and the certificate are never stored.
    person_verification: await one(
      db,
      "SELECT level, verified_name, verified_at FROM person_verifications WHERE user_id = $1",
      userId,
    ),
    govbr_challenges: await all(
      db,
      "SELECT id, created_at, expires_at, used_at FROM govbr_challenges WHERE user_id = $1 ORDER BY created_at",
      userId,
    ),
    business_domains: await all(
      db,
      "SELECT domain, verified_at, last_checked_at FROM business_domains WHERE user_id = $1 ORDER BY domain",
      userId,
    ),
    terms_accepted: await all(
      db,
      "SELECT version, source, accepted_at FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at",
      userId,
    ),
    growth_events: await growth.rowsOf(userId),
    // First contacts the caller started (bipe#845): room and time only. The recipient hash stays out, and so does what
    // the recipient did with each one: a block is the recipient's private choice, so the daily counts fold blocked
    // into not_answered.
    first_contacts: await all(db, "SELECT room_id, sent_at FROM first_contacts WHERE inviter = $1 ORDER BY sent_at", userId),
    first_contact_days: await all(
      db,
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, sent, accepted, declined, ignored + blocked AS not_answered, reported
         FROM reach_daily WHERE user_id = $1 ORDER BY day`,
      userId,
    ),
    // Problem reports (bipe#367): text and metadata. The log and screenshot files stay on the server.
    problem_reports: await bugReportsOf(db, userId),
    // Support DM (ADR 0114): the room ID only. The messages are in the room; the bot keeps no copy.
    support_room: await one(db, "SELECT room_id, created_at FROM support_rooms WHERE user_id = $1", userId),
    // Novidades do Bipe (ADR 0117): the room, whether news is off, and which items reached the user.
    news_room: await one(db, "SELECT room_id, opted_out, left_at, created_at FROM news_rooms WHERE user_id = $1", userId),
    news_deliveries: await all(db, "SELECT item_id, failed, sent_at FROM news_deliveries WHERE user_id = $1 ORDER BY sent_at", userId),
    // Agenda (ADR 0102): bookings the caller made as a customer. A company's own records come with its catálogo.
    bookings: await all(
      db,
      `SELECT id, business_id, service_id, start_at, end_at, status, source, created_at FROM bookings WHERE customer_id = $1 ORDER BY start_at`,
      userId,
    ),
    catalog_items: await all(
      db,
      `SELECT id, kind, name, price, description, category, active, archived_at, created_at FROM catalog_items WHERE business_id = $1 ORDER BY sort, id`,
      userId,
    ),
    queue_places: await all(db, "SELECT id, business_id, status, joined_at, called_at, served_at FROM queue_places WHERE customer_id = $1 ORDER BY joined_at", userId),
    quote_requests: await all(db, "SELECT id, business_id, created_at FROM quote_requests WHERE customer_id = $1 ORDER BY created_at", userId),
    quotes: await all(db, "SELECT id, business_id, status, current_version, created_at, updated_at FROM quotes WHERE customer_id = $1 OR business_id = $1 ORDER BY created_at", userId),
    orders: await all(
      db,
      "SELECT id, business_id, source, lines, total_amount_cents, fulfilment, payment, status, refuse_reason, created_at FROM orders WHERE customer_id = $1 OR business_id = $1 ORDER BY created_at",
      userId,
    ),
    // Assistants (ADR 0210): rows where the caller is the assistant or its operator.
    assistant_accounts: await all(
      db,
      "SELECT user_id, operator_user_id, model_location, registered_at, ended_at FROM assistant_accounts WHERE user_id = $1 OR operator_user_id = $1 ORDER BY registered_at",
      userId,
    ),
    // Brand marks (ADR 0162): marks the caller holds or granted, the caller's own invites (no code hash) and the steps
    // the caller took. The other party appears as an account ID, as both sides already see it.
    brand_marks: await all(
      db,
      "SELECT id, brand_user_id, reseller_user_id, label, granted_at, ended_at, ended_by FROM brand_marks WHERE brand_user_id = $1 OR reseller_user_id = $1 ORDER BY granted_at",
      userId,
    ),
    brand_mark_invites: await all(
      db,
      "SELECT id, label, created_at, expires_at, ended_at, outcome FROM brand_mark_invites WHERE brand_user_id = $1 ORDER BY created_at",
      userId,
    ),
    brand_mark_events: await all(db, "SELECT mark_id, invite_id, action, at FROM brand_mark_events WHERE actor_user_id = $1 ORDER BY at", userId),
    // Voice audio expiry (ADR 0164): the caller's registered uploads and the audio the caller keeps.
    voice_media: await all(db, "SELECT media_id, transcript, uploaded_at, expires_at FROM voice_media WHERE user_id = $1 ORDER BY uploaded_at", userId),
    kept_media: await all(db, "SELECT media_id, reason, kept_at FROM kept_media WHERE user_id = $1 ORDER BY kept_at", userId),
    business_bookings: await all(
      db,
      `SELECT id, service_id, agenda_id, start_at, end_at, status, source, created_at FROM bookings WHERE business_id = $1 ORDER BY start_at`,
      userId,
    ),
  };
}

/** Guardians the caller chose, the caller's marks and phone records (bipe#600). */
async function theftExport(db: Db, userId: string) {
  return {
    guardians: await all(db, "SELECT guardian_id, added_at FROM guardians WHERE owner_id = $1 ORDER BY added_at", userId),
    marks: await all(db, "SELECT stolen_at, cleared_at FROM theft_marks WHERE user_id = $1 ORDER BY stolen_at", userId),
    phones: await all(db, "SELECT device_id, seen_at FROM account_phones WHERE user_id = $1 ORDER BY seen_at", userId),
  };
}

