// Admin commands, run inside the container:
//   node dist/cli.js invite create --uses 10 --days 12 [--note "amigos"]
//   node dist/cli.js invite list
//   node dist/cli.js invite revoke <id>
import { parseArgs } from "node:util";
import { migrate, openDb } from "./db.js";
import { createInvite } from "./invites.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = openDb(url);
await migrate(db);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { uses: { type: "string", default: "1" }, days: { type: "string", default: "14" }, note: { type: "string" } },
});
const [group, command, arg] = positionals;

try {
  if (group === "invite" && command === "create") {
    const uses = Number(values.uses), days = Number(values.days);
    if (!(Number.isInteger(uses) && uses > 0 && Number.isInteger(days) && days > 0)) throw new Error("--uses and --days must be positive integers");
    // The code is printed once and stored only as a hash.
    console.log(await createInvite(db, uses, days, values.note));
  } else if (group === "invite" && command === "list") {
    const { rows } = await db.query(
      "SELECT id, uses_left, expires_at, revoked_at, note, (SELECT count(*) FROM signups s WHERE s.invite_id = i.id) AS signups FROM invites i ORDER BY id",
    );
    console.table(rows);
  } else if (group === "invite" && command === "revoke" && arg) {
    await db.query("UPDATE invites SET revoked_at = now() WHERE id = $1", [Number(arg)]);
    console.log(`revoked ${arg}`);
  } else {
    console.error("usage: invite create --uses N --days N [--note TEXT] | invite list | invite revoke ID");
    process.exitCode = 2;
  }
} finally {
  await db.end();
}
