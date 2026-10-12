// Admin commands, run inside the container:
//   node dist/cli.js invite create --uses 10 --days 12 [--note "amigos"]
//   node dist/cli.js invite list
//   node dist/cli.js invite revoke <id>
//   node dist/cli.js invite grant <user_id> <n>      (n extra personal invites)
//   node dist/cli.js invite revoke-user <user_id>    (all pending invites of a user)
//   node dist/cli.js phone link <user_id> <number> [--force]   (phase 0: no proof yet; never prints the number)
//   node dist/cli.js phone unlink <user_id>
//   node dist/cli.js waitlist count
//   node dist/cli.js waitlist export <platform>      (CSV email,lang for the launch email)
//   node dist/cli.js waitlist clear <platform>       (after the launch email: deletes those rows)
//   node dist/cli.js waitlist forget <email>         (LGPD deletion request)
//   node dist/cli.js registry fetch [YYYY-MM]          (download a Receita CNPJ release; newest when no month)
//   node dist/cli.js registry scan [--all]             (scan the newest release for claims; --all re-checks verified ones)
//   node dist/cli.js business list
//   node dist/cli.js business verify <user_id>         (staff path, ADR 0042; registry must show the CNPJ active)
//   node dist/cli.js business revoke <user_id>
//   node dist/cli.js experiment report <experiment>  (for example headline-77: visitors, clicks, sign-ups per arm)
import { parseArgs } from "node:util";
import { migrate, openDb } from "./db.js";
import { createInvite, grantInvites, revokeAllOf } from "./invites.js";
import { linkPhone, PhoneHasher, unlinkPhone } from "./phones.js";
import { experimentReport } from "./experiments.js";
import { revokeByStaff, runScan, verifyByStaff } from "./business.js";
import { downloadRelease, newestMonth } from "./cnpj-registry.js";
import type { Config } from "./config.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = openDb(url);
await migrate(db);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { uses: { type: "string", default: "1" }, days: { type: "string", default: "14" }, note: { type: "string" }, force: { type: "boolean", default: false }, all: { type: "boolean", default: false } },
});
const [group, command, arg, arg2] = positionals;

try {
  if (group === "invite" && command === "create") {
    const uses = Number(values.uses), days = Number(values.days);
    if (!(Number.isInteger(uses) && uses > 0 && Number.isInteger(days) && days > 0)) throw new Error("--uses and --days must be positive integers");
    // The code is printed once and stored only as a hash.
    console.log(await createInvite(db, uses, days, values.note));
  } else if (group === "invite" && command === "list") {
    const { rows } = await db.query(
      "SELECT id, created_by, uses_left, expires_at, revoked_at, note, (SELECT count(*) FROM signups s WHERE s.invite_id = i.id) AS signups FROM invites i ORDER BY id",
    );
    console.table(rows);
  } else if (group === "invite" && command === "revoke" && arg) {
    await db.query("UPDATE invites SET revoked_at = now() WHERE id = $1", [Number(arg)]);
    console.log(`revoked ${arg}`);
  } else if (group === "invite" && command === "grant" && arg?.startsWith("@") && arg2) {
    const n = Number(arg2);
    if (!(Number.isInteger(n) && n > 0)) throw new Error("n must be a positive integer");
    await grantInvites(db, arg, n);
    console.log(`granted ${n} to ${arg}`);
  } else if (group === "invite" && command === "revoke-user" && arg?.startsWith("@")) {
    console.log(`revoked ${await revokeAllOf(db, arg)} pending invites of ${arg}`);
  } else if (group === "waitlist" && command === "count") {
    const { rows } = await db.query("SELECT platform, lang, count(*)::int AS n FROM waitlist GROUP BY 1, 2 ORDER BY 1, 2");
    console.table(rows);
  } else if (group === "waitlist" && command === "export" && arg) {
    const { rows } = await db.query<{ email: string; lang: string }>("SELECT email, lang FROM waitlist WHERE platform = $1 ORDER BY created_at", [arg]);
    console.log("email,lang");
    for (const r of rows) console.log(`${r.email},${r.lang}`);
  } else if (group === "waitlist" && command === "clear" && arg) {
    const { rowCount } = await db.query("DELETE FROM waitlist WHERE platform = $1", [arg]);
    console.log(`deleted ${rowCount} ${arg} rows`);
  } else if (group === "waitlist" && command === "forget" && arg) {
    const { rowCount } = await db.query("DELETE FROM waitlist WHERE email = $1", [arg.trim().toLowerCase()]);
    console.log(`deleted ${rowCount} rows`);
  } else if (group === "registry" && command === "fetch") {
    // Same defaults as config.ts; the CLI does not need the MAS settings.
    const base = process.env.RECEITA_WEBDAV_URL ?? "https://arquivos.receitafederal.gov.br/public.php/webdav";
    const token = process.env.RECEITA_SHARE_TOKEN ?? "YggdBLfdninEJX9";
    const month = arg ?? (await newestMonth(base, token));
    console.log(`release ${month} in ${await downloadRelease(base, token, process.env.RECEITA_DIR ?? "/data/receita", month, console.log)}`);
  } else if (group === "registry" && command === "scan") {
    await runScan(db, { RECEITA_DIR: process.env.RECEITA_DIR ?? "/data/receita" } as Config, values.all ? "all" : "pending");
  } else if (group === "business" && command === "list") {
    const { rows } = await db.query(
      `SELECT c.user_id, c.cnpj, c.status, c.reason, c.method, c.verified_at, r.legal_name, r.release_month,
              (SELECT count(*) FROM business_domains d WHERE d.user_id = c.user_id AND d.verified_at IS NOT NULL) AS domains
         FROM business_claims c LEFT JOIN cnpj_registry r ON r.cnpj = c.cnpj ORDER BY c.created_at`,
    );
    console.table(rows);
  } else if (group === "business" && command === "verify" && arg?.startsWith("@")) {
    await verifyByStaff(db, arg);
    console.log(`verified ${arg} (staff)`);
  } else if (group === "business" && command === "revoke" && arg?.startsWith("@")) {
    await revokeByStaff(db, arg);
    console.log(`revoked ${arg}`);
  } else if (group === "experiment" && command === "report" && arg) {
    console.table(await experimentReport(db, arg));
  } else if (group === "phone" && command === "link" && arg?.startsWith("@") && arg2) {
    await linkPhone(db, new PhoneHasher(process.env.PHONE_HMAC_SECRET), arg, arg2, values.force === true);
    console.log(`linked a number to ${arg}`);
  } else if (group === "phone" && command === "unlink" && arg?.startsWith("@")) {
    await unlinkPhone(db, arg);
    console.log(`unlinked ${arg}`);
  } else {
    console.error("usage: invite create --uses N --days N [--note TEXT] | invite list | invite revoke ID | invite grant @user N | invite revoke-user @user | waitlist count | waitlist export PLATFORM | waitlist clear PLATFORM | waitlist forget EMAIL | experiment report ID | registry fetch [YYYY-MM] | registry scan [--all] | business list | business verify @user | business revoke @user");
    process.exitCode = 2;
  }
} finally {
  await db.end();
}
