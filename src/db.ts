import pg from "pg";

export type Db = pg.Pool;

export function openDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

// Forward-only migrations, applied in order at startup.
const MIGRATIONS = [
  `CREATE TABLE invites (
     id bigserial PRIMARY KEY,
     code_hash text NOT NULL UNIQUE,
     uses_left integer NOT NULL CHECK (uses_left >= 0),
     expires_at timestamptz NOT NULL,
     note text,
     created_at timestamptz NOT NULL DEFAULT now(),
     revoked_at timestamptz
   );
   CREATE TABLE signups (
     user_id text PRIMARY KEY,
     invite_id bigint NOT NULL REFERENCES invites(id),
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE handles (
     user_id text PRIMARY KEY,
     handle text NOT NULL UNIQUE,
     skeleton text NOT NULL UNIQUE,
     set_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE handle_holds (
     skeleton text PRIMARY KEY,
     user_id text NOT NULL,
     hold_until timestamptz NOT NULL
   );`,
  `ALTER TABLE signups ALTER COLUMN invite_id DROP NOT NULL;`,
  // Personal invites (docs/growth.md "Throttle"): created_by is NULL for admin invites.
  `ALTER TABLE invites ADD COLUMN created_by text;
   CREATE INDEX invites_created_by ON invites (created_by) WHERE created_by IS NOT NULL;
   CREATE TABLE invite_grants (
     user_id text PRIMARY KEY,
     extra integer NOT NULL CHECK (extra >= 0)
   );`,
  // Waitlist (ADR 0025): one row per address and platform, deleted after the launch email.
  `CREATE TABLE waitlist (
     email text NOT NULL,
     platform text NOT NULL CHECK (platform IN ('android', 'ios', 'other')),
     lang text NOT NULL CHECK (lang IN ('pt', 'en')),
     source text,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (email, platform)
   );`,
  // Experiment counters (ADR 0032): aggregate numbers only.
  `CREATE TABLE experiment_counts (
     experiment text NOT NULL,
     arm text NOT NULL,
     event text NOT NULL CHECK (event IN ('assign', 'install_click')),
     day date NOT NULL,
     n integer NOT NULL CHECK (n >= 0),
     PRIMARY KEY (experiment, arm, event, day)
   );`,
  // Phone-number discovery, phase 0 (bipe/docs/phone-link.md). Numbers only as HMAC.
  `CREATE TABLE phone_links (
     user_id text PRIMARY KEY,
     phone_hmac text NOT NULL UNIQUE,
     method text NOT NULL CHECK (method IN ('admin', 'pix', 'sms')),
     linked_at timestamptz NOT NULL DEFAULT now(),
     confirmed_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE discovery_settings (
     user_id text PRIMARY KEY,
     by_phone boolean NOT NULL
   );`,
  // Who can message me (docs/usernames.md "First contact"). No row means "everyone".
  `CREATE TABLE messaging_policies (
     user_id text PRIMARY KEY,
     policy text NOT NULL CHECK (policy IN ('everyone', 'verified', 'contacts')),
     updated_at timestamptz NOT NULL DEFAULT now()
   );`,
  // CNPJ verification (ADR 0042). One claim per account; one verified account per CNPJ.
  `CREATE TABLE business_claims (
     user_id text PRIMARY KEY,
     cnpj text NOT NULL,
     status text NOT NULL CHECK (status IN ('registry_pending', 'awaiting_proof', 'verified', 'rejected', 'revoked')),
     reason text,
     challenge text NOT NULL,
     method text CHECK (method IN ('ecnpj', 'partner', 'staff')),
     created_at timestamptz NOT NULL DEFAULT now(),
     verified_at timestamptz,
     ended_at timestamptz
   );
   CREATE UNIQUE INDEX business_claims_one_verified ON business_claims (cnpj) WHERE status = 'verified';
   CREATE INDEX business_claims_cnpj ON business_claims (cnpj);
   CREATE TABLE business_domains (
     user_id text NOT NULL REFERENCES business_claims(user_id) ON DELETE CASCADE,
     domain text NOT NULL,
     token text NOT NULL,
     verified_at timestamptz,
     last_checked_at timestamptz,
     PRIMARY KEY (user_id, domain)
   );
   -- Rows copied from the Receita release for claimed CNPJs only. Public open data.
   CREATE TABLE cnpj_registry (
     cnpj text PRIMARY KEY,
     active boolean NOT NULL,
     status_code integer,
     legal_name text,
     trade_name text,
     release_month text NOT NULL,
     checked_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE cnpj_partners (
     root text NOT NULL,
     kind integer NOT NULL,
     name text NOT NULL,
     doc text NOT NULL,
     qualification integer,
     release_month text NOT NULL
   );
   CREATE INDEX cnpj_partners_root ON cnpj_partners (root);`,
  // Public profiles (ADR 0041): opt-in, separate from the Matrix profile. Photo without metadata.
  `CREATE TABLE public_profiles (
     user_id text PRIMARY KEY,
     enabled boolean NOT NULL DEFAULT false,
     name text NOT NULL DEFAULT '',
     bio text NOT NULL DEFAULT '',
     photo bytea,
     photo_version text,
     updated_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Device-first accounts (ADR 0057, ADR 0059). No password and no PIN in clear: the hidden MAS password is
  // never stored; the PIN is a peppered scrypt hash; tokens, links and claim secrets are SHA-256 hashes.
  // Beta accounts have no row until they set a PIN or move (device_first false).
  `CREATE TABLE account_secrets (
     user_id text PRIMARY KEY,
     device_first boolean NOT NULL DEFAULT false,
     pin_hash text,
     pin_wrong_tries integer NOT NULL DEFAULT 0 CHECK (pin_wrong_tries >= 0),
     pin_blocked_at timestamptz,
     pin_set_at timestamptz,
     token_hash text UNIQUE,
     token_set_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   -- Recovery fallback, not a login. email is the verified address; pending_* waits for its link.
   CREATE TABLE recovery_emails (
     user_id text PRIMARY KEY,
     email text UNIQUE,
     verified_at timestamptz,
     pending_email text,
     pending_hash text UNIQUE,
     pending_expires_at timestamptz,
     lang text NOT NULL DEFAULT 'pt' CHECK (lang IN ('pt', 'en'))
   );
   -- link_sent: email link out, factor not passed yet (old devices do not see it).
   -- waiting: factor and PIN passed, delay running. completed, cancelled: ended.
   CREATE TABLE recoveries (
     id text PRIMARY KEY,
     user_id text NOT NULL,
     method text NOT NULL CHECK (method IN ('token', 'email', 'guardian', 'cpf')),
     purpose text CHECK (purpose IN ('access', 'pin_reset')),
     state text NOT NULL CHECK (state IN ('link_sent', 'waiting', 'completed', 'cancelled')),
     link_hash text UNIQUE,
     link_expires_at timestamptz,
     claim_hash text,
     new_pin_hash text,
     created_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     ready_at timestamptz,
     ended_at timestamptz,
     ended_by text
   );
   CREATE INDEX recoveries_user ON recoveries (user_id, created_at DESC);`,
  // Handle change history (ADR 0066). old_handle NULL: first set. new_handle NULL: removal.
  // old_set_at: when the old handle was set, so a removal does not reset the change cooldown.
  `CREATE TABLE handle_changes (
     id bigserial PRIMARY KEY,
     user_id text NOT NULL,
     old_handle text,
     new_handle text,
     old_set_at timestamptz,
     source text NOT NULL CHECK (source IN ('user', 'staff')),
     changed_at timestamptz NOT NULL DEFAULT now(),
     CHECK (old_handle IS NOT NULL OR new_handle IS NOT NULL)
   );
   CREATE INDEX handle_changes_user ON handle_changes (user_id, changed_at);`,
  // Partner requests from the site (ADR 0067, bipe#177). Deleted after PARTNER_KEEP_DAYS.
  `CREATE TABLE partner_requests (
     id bigserial PRIMARY KEY,
     organisation text NOT NULL,
     name text NOT NULL,
     email text NOT NULL,
     kind text NOT NULL,
     message text,
     lang text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Waitlist release (ADR 0089): the invite an entry got. The entry goes when that invite is used, expires or is revoked.
  `ALTER TABLE waitlist ADD COLUMN invite_id bigint REFERENCES invites(id), ADD COLUMN invited_at timestamptz;`,
  // Sign-up retry (ADR 0094): credentials sealed under a key only the phone has. Gone on first account read or after 7 days.
  `CREATE TABLE signup_replays (
     key_hash text PRIMARY KEY,
     user_id text NOT NULL,
     sealed bytea NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX signup_replays_user ON signup_replays (user_id);`,
  // Growth events (ADR 0098, bipe#67): uid is HMAC-SHA256 of the Matrix ID, never the ID. No content.
  // growth_sync: how far each Synapse source was read, and per-user counts that Synapse keeps no time for.
  `CREATE TABLE growth_events (
     uid text NOT NULL,
     event text NOT NULL,
     day date NOT NULL,
     n integer NOT NULL CHECK (n > 0),
     PRIMARY KEY (uid, event, day)
   );
   CREATE INDEX growth_events_event_day ON growth_events (event, day);
   CREATE TABLE growth_sync (
     source text PRIMARY KEY,
     position bigint NOT NULL
   );`,
  // Clickwrap terms (ADR 0113): one row per account and accepted legalVersion. No IP and no device data.
  `CREATE TABLE terms_acceptances (
     user_id text NOT NULL,
     version text NOT NULL,
     source text NOT NULL CHECK (source IN ('signup', 'app')),
     accepted_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, version)
   );`,
  // Company mode (ADR 0087, bipe#269): a company account is a second account of its owner's phone.
  `ALTER TABLE signups ADD COLUMN account_type text NOT NULL DEFAULT 'personal' CHECK (account_type IN ('personal', 'company'));`,
  // Organisation form (ADR 0126, bipe#410): the partner table becomes the organisation table, with the
  // questions on how many customers an organisation talks to and what it pays today. No email notice.
  `ALTER TABLE partner_requests RENAME TO organisation_requests;
   ALTER TABLE organisation_requests
     ADD COLUMN role text,
     ADD COLUMN cnpj text,
     ADD COLUMN customers_band text,
     ADD COLUMN channels text[] NOT NULL DEFAULT '{}',
     ADD COLUMN spend_band text,
     ADD COLUMN spend_note text;`,
  // Problem reports (bipe#367): files on disk under BUG_REPORTS_DIR/<id>/, 90 days. The outbox holds a Starlings
  // intake line only until Starlings takes it.
  `CREATE TABLE bug_reports (
     id uuid PRIMARY KEY,
     user_id text NOT NULL,
     text text NOT NULL,
     platform text NOT NULL CHECK (platform IN ('ios', 'android', 'other')),
     app_version text,
     build integer,
     os text,
     labels text[] NOT NULL DEFAULT '{}',
     files text[] NOT NULL DEFAULT '{}',
     intake_id text,
     relayed_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX bug_reports_user ON bug_reports (user_id);
   CREATE INDEX bug_reports_created ON bug_reports (created_at);
   CREATE TABLE intake_outbox (
     message_id text PRIMARY KEY,
     body jsonb NOT NULL,
     tries integer NOT NULL DEFAULT 0,
     next_at timestamptz NOT NULL DEFAULT now(),
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Support DM (ADR 0114, ADR 0115): one room per user, the bot's sync position, and member replies already sent.
  // User texts go to Starlings through intake_outbox.
  `CREATE TABLE support_rooms (
     user_id text PRIMARY KEY,
     room_id text NOT NULL UNIQUE,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE support_sync (
     id integer PRIMARY KEY CHECK (id = 1),
     since text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE support_replies (
     message_id text PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Remote critical banner (ADR 0117, bipe#386): at most one row.
  `CREATE TABLE remote_banner (
     singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
     body jsonb NOT NULL,
     set_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Organisation requests moved to the Bipe workspace on Starlings (bipe#273). The table was empty
  // when this was written (19 October 2026, after the one test row was deleted).
  `DROP TABLE IF EXISTS organisation_requests;`,
  // The name a user gives a personal invite, so it survives a new phone or a reinstall (bipe-shared openapi).
  `ALTER TABLE invites ADD COLUMN name text;`,
  // Person verification, trust step 5 (bipe#543). A challenge is single use and bound to one device key.
  // The result keeps the verified name and a keyed CPF hash, never the CPF, the PDF or the certificate.
  `CREATE TABLE govbr_challenges (
     id uuid PRIMARY KEY,
     user_id text NOT NULL,
     device_key text NOT NULL,
     code text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     used_at timestamptz
   );
   CREATE INDEX govbr_challenges_user ON govbr_challenges (user_id);
   CREATE TABLE person_verifications (
     user_id text PRIMARY KEY,
     level text NOT NULL CHECK (level IN ('pix', 'govbr')),
     verified_name text NOT NULL,
     cpf_hash text NOT NULL UNIQUE,
     device_key text NOT NULL,
     verified_at timestamptz NOT NULL DEFAULT now()
   );`,
  // Recovery that survives the App Store transfer (bipe#531): an iPhone moved its keychain items into the
  // app-group keychain group. One row per device; the device comes from the access token.
  `CREATE TABLE keychain_moves (
     user_id text NOT NULL,
     device_id text NOT NULL,
     moved_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, device_id)
   );`,
  // Novidades do Bipe (ADR 0117, bipe#383): one read-only room per user, news items, the delivery log, the bot's sync
  // position and the backfill request. opted_out: the user left the room or turned news off in Settings.
  `CREATE TABLE news_rooms (
     user_id text PRIMARY KEY,
     room_id text NOT NULL UNIQUE,
     opted_out boolean NOT NULL DEFAULT false,
     left_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE news_items (
     id text PRIMARY KEY,
     body text NOT NULL,
     link text,
     importance text NOT NULL CHECK (importance IN ('normal', 'important')),
     created_at timestamptz NOT NULL DEFAULT now(),
     done_at timestamptz
   );
   CREATE TABLE news_deliveries (
     item_id text NOT NULL REFERENCES news_items(id),
     user_id text NOT NULL,
     failed boolean NOT NULL DEFAULT false,
     sent_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (item_id, user_id)
   );
   CREATE INDEX news_deliveries_user ON news_deliveries (user_id);
   CREATE TABLE news_sync (
     id integer PRIMARY KEY CHECK (id = 1),
     since text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE news_state (
     id integer PRIMARY KEY CHECK (id = 1),
     backfill_requested_at timestamptz,
     backfill_done_at timestamptz
   );
   INSERT INTO news_state (id) VALUES (1);`,
  // Work side opening hours (ADR 0138 rule 4, bipe#511): one row per company account; days as the contract's WorkDay list.
  `CREATE TABLE work_hours (
     user_id text PRIMARY KEY,
     enabled boolean NOT NULL,
     time_zone text NOT NULL,
     days jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );`,
];

export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7140101)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)");
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_version");
    let version = rows[0]?.version ?? 0;
    if (rows.length === 0) await client.query("INSERT INTO schema_version VALUES (0)");
    for (; version < MIGRATIONS.length; version++) {
      await client.query("BEGIN");
      await client.query(MIGRATIONS[version]!);
      await client.query("UPDATE schema_version SET version = $1", [version + 1]);
      await client.query("COMMIT");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7140101)").catch(() => {});
    client.release();
  }
}
