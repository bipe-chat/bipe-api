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
  // Phone-number discovery, phase 0 (proseio docs/phone-link.md). Numbers only as HMAC.
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
