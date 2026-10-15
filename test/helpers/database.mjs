import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../dist/db.js";

export function testDatabaseUrl(raw, nodeEnv = process.env.NODE_ENV) {
  const refused = () => { throw new Error("Integration tests require BIPE_TEST_DATABASE_URL: a loopback database named bipe_test, owned by bipe_test. Production databases are refused."); };
  if (!raw || nodeEnv === "production") refused();
  let url;
  try { url = new URL(raw); } catch { refused(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/bipe_test" || url.username !== "bipe_test" || !url.password || url.search || url.hash) refused();
  return url;
}

export function isLoopbackPeer(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

export async function isolatedDatabase(t) {
  const url = testDatabaseUrl(process.env.BIPE_TEST_DATABASE_URL);
  const admin = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000 });
  let db;
  let created = false;
  const schema = `bipe_test_${randomBytes(8).toString("hex")}`;
  t.after(async () => {
    if (db) await db.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  const connection = await admin.connect();
  try {
    const { rows: [identity] } = await connection.query("SELECT current_database() AS db, current_user AS owner");
    // The server sees a bridge IP behind Docker port forwarding. Check the client's socket instead.
    if (identity.db !== "bipe_test" || identity.owner !== "bipe_test" || !isLoopbackPeer(connection.connection.stream.remoteAddress)) {
      throw new Error("Integration database identity check failed; no schema was created.");
    }
  } finally {
    connection.release();
  }
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  db = new pg.Pool({ connectionString: url.href, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 10000, options: `-c search_path=${schema}` });
  await migrate(db);
  return db;
}
