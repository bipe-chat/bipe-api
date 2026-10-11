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
