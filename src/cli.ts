// Admin commands, run inside the container:
//   node dist/cli.js invite create --uses 10 --days 12 [--note "amigos"]
//   node dist/cli.js invite list
//   node dist/cli.js invite revoke <id>
//   node dist/cli.js invite grant <user_id> <n>      (n extra personal invites)
//   node dist/cli.js invite revoke-user <user_id>    (all pending invites of a user)
//   node dist/cli.js invite top [--limit 50]         (inviters: sent, joined, rate, downstream tree)
//   node dist/cli.js phone link <user_id> <number> [--force]   (phase 0: no proof yet; never prints the number)
//   node dist/cli.js phone unlink <user_id>
//   node dist/cli.js waitlist count
//   node dist/cli.js waitlist export <platform>      (CSV email,lang for the launch email)
//   node dist/cli.js waitlist clear <platform>       (after the launch email: deletes those rows)
//   node dist/cli.js waitlist forget <email>         (LGPD deletion request)
//   node dist/cli.js waitlist release <platform> --count N [--days 14]   (ADR 0089: oldest entries first, one invite email each)
//   node dist/cli.js support status                  (ADR 0114: support rooms, Starlings lines waiting, last sync)
//   node dist/cli.js news send <file.json>           (ADR 0117: queues a news item {id, text, link?, importance}; text through the humanizer first)
//   node dist/cli.js news list                       (items with sent and failed counts; rooms and opted-out users)
//   node dist/cli.js news backfill                   (a news room for every user who signed up before the news bot)
//   node dist/cli.js bugreports list                 (problem reports, newest first: id, platform, version, files; no text)
//   node dist/cli.js bugreports show <id>            (one report with its text and file names)
//   node dist/cli.js bugreports forget <user_id>     (LGPD deletion request: rows and files)
//   node dist/cli.js registry fetch [YYYY-MM]          (download a Receita CNPJ release; newest when no month)
//   node dist/cli.js registry scan [--all]             (scan the newest release for claims; --all re-checks verified ones)
//   node dist/cli.js cvm refresh                     (ADR 0077: download CVM's provider register and stop orders now)
//   node dist/cli.js cvm status                      (last refresh, last error, row counts)
//   node dist/cli.js cvm show <cnpj>                 (the badge's CVM line for one CNPJ)
//   node dist/cli.js business list
//   node dist/cli.js business claim <user_id> <cnpj>  (staff: starts the claim as POST /v1/me/business does; then business verify)
//   node dist/cli.js business verify <user_id>         (staff path, ADR 0042; registry must show the CNPJ active)
//   node dist/cli.js business revoke <user_id>
//   node dist/cli.js handle set <user_id> <handle>    (staff: skips the 30-day cooldown; still validates, holds the old handle, refuses a taken one)
//   node dist/cli.js experiment report <experiment>  (for example headline-77: visitors, clicks, sign-ups per arm)
//   node dist/cli.js banner set <file.json>          (ADR 0117: the remote critical banner; text through the humanizer first)
//   node dist/cli.js banner show
//   node dist/cli.js banner clear
//   node dist/cli.js growth report [--since YYYY-MM-DD]   (ADR 0098: syncs first, then funnel and D1/D7/D30 by sign-up week)
//   node dist/cli.js transfer report [--days 30]     (bipe#531: active iOS accounts with a way back that survives the App Store transfer)
//   node dist/cli.js proposta password [--password-stdin]   (ADR 0158: the one shared password; prints a new one once, or reads yours; ends every session)
//   node dist/cli.js proposta visits [--days 30]       (per visitor email, then the visits, newest first)
//   node dist/cli.js proposta sessions [--days 30]     (ADR 0160: each sitting with the time on each page and slide)
//   node dist/cli.js proposta forget <email>          (LGPD deletion request: visitor, sessions and visits)
import { parseArgs } from "node:util";
import { migrate, openDb } from "./db.js";
import { createInvite, grantInvites, inviterReport, revokeAllOf } from "./invites.js";
import { Mailer } from "./mailer.js";
import { releaseWaitlist, WaitlistBody } from "./waitlist.js";
import { linkPhone, PhoneHasher, unlinkPhone } from "./phones.js";
import { experimentReport } from "./experiments.js";
import { Growth, growthReport } from "./growth.js";
import { ApiError } from "./errors.js";
import { setHandle } from "./handles.js";
import { createClaim, revokeByStaff, runScan, verifyByStaff } from "./business.js";
import { downloadRelease, newestMonth } from "./cnpj-registry.js";
import { type Config, loadMailConfig } from "./config.js";
import { forgetBugReports, getBugReport, listBugReports } from "./bug-reports.js";
import { clearBanner, currentBanner, setBanner } from "./banner.js";
import { newsList, queueNewsItem, requestNewsBackfill } from "./news.js";
import { cvmField, refreshCvm } from "./cvm.js";
import { validCnpj } from "./registry.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import { transferReadiness } from "./transfer.js";
import { clock, forgetVisitor, propostaReport, setSharedPassword, sittings } from "./proposta.js";
import { newSecret } from "./secrets.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = openDb(url);
await migrate(db);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { uses: { type: "string", default: "1" }, days: { type: "string", default: "14" }, count: { type: "string" }, note: { type: "string" }, force: { type: "boolean", default: false }, all: { type: "boolean", default: false }, limit: { type: "string", default: "50" }, since: { type: "string", default: "2026-01-01" }, "password-stdin": { type: "boolean", default: false } },
});
const [group, command, arg, arg2] = positionals;

try {
  if (group === "invite" && command === "create") {
    const uses = Number(values.uses), days = Number(values.days);
    if (!(Number.isInteger(uses) && uses > 0 && Number.isInteger(days) && days > 0)) throw new Error("--uses and --days must be positive integers");
    // The code is printed once and stored only as a hash.
    console.log((await createInvite(db, uses, days, values.note)).code);
  } else if (group === "proposta" && command === "password") {
    // A generated password is printed once and stored only as a hash. 16 characters without l, 1, 0 and o.
    const generated = Array.from(Buffer.from(newSecret(), "base64url").subarray(0, 16), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    const password = values["password-stdin"] ? readFileSync(0, "utf8").trim() : generated;
    await setSharedPassword(db, password);
    console.log(values["password-stdin"] ? "password set; every session ended" : password);
  } else if (group === "proposta" && command === "visits") {
    const days = process.argv.includes("--days") ? Number(values.days) : 30;
    if (!(Number.isInteger(days) && days > 0 && days <= 365)) throw new Error("--days must be 1 to 365");
    const report = await propostaReport(db, days);
    console.table(report.visitors.map((r) => ({ id: r.id, email: r.email, last_seen: r.last_seen_at, page_views: r.page_views, max_slide: r.max_slide })));
    console.table(report.visits.map((v) => ({ at: v.at.slice(0, 16), visitor: v.visitor_id, kind: v.kind, path: v.path, slide: v.slide, referrer: v.referrer, utm: Object.values(v.utm).join(" ") || null, place: [v.city, v.region, v.country].filter(Boolean).join(", ") || null })));
  } else if (group === "proposta" && command === "sessions") {
    const days = process.argv.includes("--days") ? Number(values.days) : 30;
    if (!(Number.isInteger(days) && days > 0 && days <= 365)) throw new Error("--days must be 1 to 365");
    for (const s of await sittings(db, days)) {
      console.log(`\n${s.startedAt.toISOString().slice(0, 16)}  ${s.email}  ${clock(s.ms)}  ${s.place ?? "-"}  ${s.referrer ?? "-"}  ${Object.values(s.utm).join(" ")}`);
      for (const t of s.steps) console.log(`  ${clock(t.ms).padStart(5)}  ${t.path}${t.slide === null ? "" : `  ${t.slide} ${t.title ?? ""}`}`);
    }
  } else if (group === "proposta" && command === "forget" && arg) {
    console.log((await forgetVisitor(db, arg)) ? "deleted visitor, sessions and visits" : "no visitor with that email");
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
  } else if (group === "invite" && command === "top") {
    const limit = Number(values.limit);
    if (!(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
    console.table(await inviterReport(db, limit, process.env.SERVER_NAME ?? "bipe.net.br"));
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
  } else if (group === "waitlist" && command === "release" && arg) {
    const platform = WaitlistBody.shape.platform.parse(arg);
    const count = Number(values.count), days = Number(values.days);
    if (!(Number.isInteger(count) && count > 0 && Number.isInteger(days) && days > 0)) throw new Error("--count and --days must be positive integers");
    const mail = loadMailConfig();
    const r = await releaseWaitlist(db, new Mailer(mail), mail.PUBLIC_SITE_URL, platform, count, days);
    console.log(`${r.note}: sent ${r.sent}, failed ${r.failed} (failed entries stay on the list)`);
  } else if (group === "support" && command === "status") {
    const { rows } = await db.query(
      `SELECT (SELECT count(*)::int FROM support_rooms) AS rooms,
              (SELECT count(*)::int FROM intake_outbox) AS waiting,
              (SELECT max(tries) FROM intake_outbox) AS max_tries,
              (SELECT updated_at FROM support_sync WHERE id = 1) AS last_sync`,
    );
    console.table(rows);
  } else if (group === "news" && command === "send" && arg) {
    const item = await queueNewsItem(db, JSON.parse(readFileSync(arg, "utf8")));
    console.log(`news item ${item.id} queued (${item.importance}); the server sends it within a few minutes`);
  } else if (group === "news" && command === "list") {
    const report = await newsList(db);
    console.log(`rooms ${report.rooms}, opted out ${report.opted_out}`);
    for (const i of report.items) console.log(`${i.id}  ${i.importance}  queued ${i.created_at.toISOString().slice(0, 16)}  ${i.done_at ? "done" : "sending"}  sent ${i.sent}  failed ${i.failed}`);
  } else if (group === "news" && command === "backfill") {
    await requestNewsBackfill(db);
    console.log("news backfill requested; the server makes the rooms, rate-limited (news list shows the count)");
  } else if (group === "cvm" && command === "refresh") {
    await refreshCvm(db);
  } else if (group === "cvm" && command === "status") {
    const { rows } = await db.query(
      `SELECT s.refreshed_at, s.last_error, s.last_error_at,
              (SELECT count(*)::int FROM cvm_registrations) AS registrations,
              (SELECT count(*)::int FROM cvm_stop_orders) AS stop_orders
       FROM cvm_state s WHERE s.id = 1`,
    );
    console.table(rows);
  } else if (group === "cvm" && command === "show" && arg) {
    const cnpj = validCnpj(arg);
    if (!cnpj) throw new Error("not a CNPJ");
    const { rows } = await db.query<{ cnae_main: string | null; cnae_secondary: string[] | null }>("SELECT cnae_main, cnae_secondary FROM cnpj_registry WHERE cnpj = $1", [cnpj]);
    console.log(JSON.stringify((await cvmField(db, cnpj, [rows[0]?.cnae_main, ...(rows[0]?.cnae_secondary ?? [])])) ?? null));
  } else if (group === "bugreports" && command === "list") {
    for (const r of (await listBugReports(db)).reports) {
      console.log(`${r.id}  ${r.created_at.slice(0, 16)}  ${r.platform} ${r.app_version ?? "?"} (${r.build ?? "?"})  logs ${r.log_count}  shots ${r.screenshot_count}  ${r.relayed ? "relayed" : "not relayed"}`);
    }
  } else if (group === "bugreports" && command === "show" && arg) {
    const r = await getBugReport(db, arg);
    console.log(`${r.id}  ${r.created_at}  ${r.user_id}\n${r.platform} ${r.app_version ?? "?"} (${r.build ?? "?"}) ${r.os ?? ""}\nlabels: ${r.labels.join(", ") || "-"}\nfiles: ${r.files.join(", ") || "-"}\n\n${r.text}`);
  } else if (group === "bugreports" && command === "forget" && arg) {
    console.log(`deleted ${await forgetBugReports(db, process.env.BUG_REPORTS_DIR ?? "/data/bug-reports", arg.trim())} reports`);
  } else if (group === "banner" && command === "set" && arg) {
    const banner = await setBanner(db, JSON.parse(readFileSync(arg, "utf8")));
    console.log(`banner set: ${banner.id}, until ${banner.expires_at}${banner.min_app_version ? `, update below ${banner.min_app_version}` : ""}`);
  } else if (group === "banner" && command === "show") {
    console.log(JSON.stringify(await currentBanner(db), null, 2));
  } else if (group === "banner" && command === "clear") {
    console.log((await clearBanner(db)) ? "banner cleared" : "no banner");
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
  } else if (group === "handle" && command === "set" && arg?.startsWith("@") && arg2) {
    try {
      const result = await setHandle(db, arg, arg2, { staff: true });
      console.log(`${arg} has handle @${"handle" in result ? result.handle : "?"} (staff)`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      console.error(`refused: ${e.id}${e.reason ? ` (${e.reason})` : ""}`);
      process.exitCode = 1;
    }
  } else if (group === "business" && command === "claim" && arg?.startsWith("@") && arg2) {
    // Same rules as POST /v1/me/business (cnpj_invalid, cnpj_taken, already_verified). A CNPJ not in the registry
    // copy yet waits for a scan, so run one here, like the API does.
    const server = process.env.SERVER_NAME?.trim();
    if (server && !arg.endsWith(`:${server}`)) throw new Error(`${arg} is not a user on ${server}`);
    const cfg = { RECEITA_DIR: process.env.RECEITA_DIR ?? "/data/receita" } as Config;
    try {
      let claim = await createClaim(db, cfg, arg, arg2, () => {});
      if (claim.status === "registry_pending") {
        await runScan(db, cfg, "pending");
        const { rows } = await db.query<{ status: string; reason: string | null }>("SELECT status, reason FROM business_claims WHERE user_id = $1", [arg]);
        claim = { ...claim, status: rows[0]!.status as typeof claim.status, ...(rows[0]!.reason ? { reason: rows[0]!.reason } : {}) };
      }
      console.log(`${arg}: claim ${claim.cnpj} ${claim.status}${claim.reason ? ` (${claim.reason})` : ""}`);
      if (claim.status === "awaiting_proof") console.log(`next: e-CNPJ proof in the app, or staff: node dist/cli.js business verify ${arg}`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      console.error(`refused: ${e.id}${e.reason ? ` (${e.reason})` : ""}`);
      process.exitCode = 1;
    }
  } else if (group === "business" && command === "verify" && arg?.startsWith("@")) {
    await verifyByStaff(db, arg);
    console.log(`verified ${arg} (staff)`);
  } else if (group === "business" && command === "revoke" && arg?.startsWith("@")) {
    await revokeByStaff(db, arg);
    console.log(`revoked ${arg}`);
  } else if (group === "experiment" && command === "report" && arg) {
    console.table(await experimentReport(db, arg));
  } else if (group === "growth" && command === "report") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since!)) throw new Error("--since must be YYYY-MM-DD");
    const env = (k: string) => process.env[k]?.trim() || undefined;
    const growth = new Growth(db, { secret: env("BIPE_GROWTH_HMAC_SECRET"), synapseUrl: env("SYNAPSE_DATABASE_URL"), serverName: process.env.SERVER_NAME ?? "bipe.net.br" });
    try {
      if (!growth.enabled) console.log("BIPE_GROWTH_HMAC_SECRET is not set: no sync, the report shows stored rows only");
      else if (!(await growth.sync())) console.log("another sync is running: the report shows stored rows only");
    } finally {
      await growth.close();
    }
    const report = await growthReport(db, values.since!);
    console.log(`Funnel: sign-ups since ${values.since}; a user counts at a step only with every earlier step`);
    console.table(report.funnel);
    console.log("Retention by sign-up week: active on day N / sign-ups whose day N is over");
    console.table(report.retention);
    console.log("All events: users and count");
    console.table(report.totals);
  } else if (group === "transfer" && command === "report") {
    // --days defaults to 14 for invites; this report's window is 30 days unless --days is given.
    const days = process.argv.includes("--days") ? Number(values.days) : 30;
    if (!(Number.isInteger(days) && days >= 1 && days <= 90)) throw new Error("--days must be 1 to 90");
    const synapseUrl = process.env.SYNAPSE_DATABASE_URL?.trim();
    if (!synapseUrl) throw new Error("SYNAPSE_DATABASE_URL is not set");
    const synapse = new pg.Pool({ connectionString: synapseUrl, max: 1 });
    try {
      console.log(`iOS accounts seen in the last ${days} days. null: a count of 1 or 2 (minimum cell). Shares in percent.`);
      console.table(await transferReadiness(db, synapse, days));
    } finally {
      await synapse.end();
    }
  } else if (group === "phone" && command === "link" && arg?.startsWith("@") && arg2) {
    await linkPhone(db, new PhoneHasher(process.env.PHONE_HMAC_SECRET), arg, arg2, values.force === true);
    console.log(`linked a number to ${arg}`);
  } else if (group === "phone" && command === "unlink" && arg?.startsWith("@")) {
    await unlinkPhone(db, arg);
    console.log(`unlinked ${arg}`);
  } else {
    console.error("usage: invite create --uses N --days N [--note TEXT] | invite list | invite revoke ID | invite grant @user N | invite revoke-user @user | invite top [--limit N] | waitlist count | waitlist export PLATFORM | waitlist clear PLATFORM | waitlist forget EMAIL | waitlist release PLATFORM --count N [--days N] | handle set @user HANDLE | experiment report ID | growth report [--since YYYY-MM-DD] | transfer report [--days N] | registry fetch [YYYY-MM] | registry scan [--all] | business list | business claim @user CNPJ | business verify @user | business revoke @user");
    process.exitCode = 2;
  }
} finally {
  await db.end();
}
