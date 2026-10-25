// Data export (LGPD art. 18, ADR 0112): everything this API stores about the caller, as one JSON file.
// Hashes, sealed secrets and other people's data stay out. Messages live on the devices, not here.
import { bugReportsOf } from "./bug-reports.js";
import type { Db } from "./db.js";
import type { Growth } from "./growth.js";
import { inviteConnections } from "./invites.js";

const one = async <T extends Record<string, unknown>>(db: Db, sql: string, userId: string): Promise<T | null> =>
  (await db.query<T>(sql, [userId])).rows[0] ?? null;

const all = async <T extends Record<string, unknown>>(db: Db, sql: string, userId: string): Promise<T[]> =>
  (await db.query<T>(sql, [userId])).rows;

export async function exportData(db: Db, growth: Growth, userId: string, now = new Date()) {
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
    sign_up: await one(db, "SELECT created_at, account_type FROM signups WHERE user_id = $1", userId),
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
    // bipe#531: the iPhones that moved their keychain items before the App Store transfer.
    keychain_moves: await all(db, "SELECT device_id, moved_at FROM keychain_moves WHERE user_id = $1 ORDER BY moved_at", userId),
    handle: await one(db, "SELECT handle, set_at FROM handles WHERE user_id = $1", userId),
    handle_holds: await all(db, "SELECT hold_until FROM handle_holds WHERE user_id = $1 ORDER BY hold_until", userId),
    handle_changes: await all(
      db,
      "SELECT old_handle, new_handle, source, changed_at FROM handle_changes WHERE user_id = $1 ORDER BY changed_at",
      userId,
    ),
    public_profile: profile && {
      enabled: profile.enabled,
      name: profile.name,
      bio: profile.bio,
      photo_jpeg_base64: profile.photo ? profile.photo.toString("base64") : null,
      updated_at: profile.updated_at,
    },
    messaging: await one(db, "SELECT policy AS who_can_message, updated_at FROM messaging_policies WHERE user_id = $1", userId),
    discovery: await one(db, "SELECT by_phone FROM discovery_settings WHERE user_id = $1", userId),
    // The number itself is never stored, only a keyed hash (docs/phone-link.md), so it is not in the file.
    phone_link: await one(db, "SELECT method, linked_at, confirmed_at FROM phone_links WHERE user_id = $1", userId),
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
    business_bookings: await all(
      db,
      `SELECT id, service_id, agenda_id, start_at, end_at, status, source, created_at FROM bookings WHERE business_id = $1 ORDER BY start_at`,
      userId,
    ),
  };
}
