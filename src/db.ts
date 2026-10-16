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
