// Problem reports from the apps (bipe#367): "Avisar sobre um problema". The apps send the rageshake multipart form.
// The text, the logs and the screenshots stay on the server in Brazil for RETENTION_DAYS. Starlings gets the text and
// metadata only, with a staff-only link back here. The support bot (ADR 0114) posts a notice into the user's support
// room. Never log the text, a file, or a user ID next to the text.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Intake } from "./intake.js";
import { appString } from "./registry.js";
import type { SupportBot } from "./support.js";

export const RETENTION_DAYS = 90;
export const BODY_MAX_BYTES = 50 * 1024 * 1024;
const TEXT_MAX = 5000;
// The Starlings intake line: a long report is cut, the full text stays in the staff view.
const INTAKE_TEXT_MAX = 4000;
// Element X sends one gzip part per log file, and a phone can hold many rotated logs. Over the limit the report
// keeps the first MAX_LOGS and is not refused: BODY_MAX_BYTES caps the size.
const MAX_LOGS = 100;
const MAX_SHOTS = 10;
const MAX_LABELS = 10;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const FILE_NAME_PATTERN = /^(log|shot)-[0-9]{2,3}\.[a-z0-9]{1,8}$/;

type FormValue = string | File | (string | File)[];
type Form = Record<string, FormValue>;

const list = (v: FormValue | undefined): (string | File)[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const field = (form: Form, key: string, max: number): string | undefined => {
  const v = list(form[key]).find((x): x is string => typeof x === "string")?.trim();
  return v ? v.slice(0, max) : undefined;
};
const files = (form: Form, key: string): File[] => list(form[key]).filter((x): x is File => typeof x !== "string" && x.size > 0);

/** The file extension from the upload name, lower case, letters and digits only; else "bin". */
function extensionOf(file: File, fallback: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1]?.toLowerCase();
  return ext ?? fallback;
}

// iOS sends "iOS"; Android sends its full user agent, which names Android.
function platformOf(userAgent: string | undefined): "ios" | "android" | "other" {
  const ua = userAgent?.toLowerCase() ?? "";
  if (ua.startsWith("ios")) return "ios";
  if (ua.includes("android")) return "android";
  return "other";
}

export type BugReportDeps = { db: Db; intake: Intake; dir: string; publicApiUrl: string; support?: SupportBot };

export async function submitBugReport(deps: BugReportDeps, userId: string, form: Form): Promise<{ report_id: string }> {
  const text = field(form, "text", TEXT_MAX + 1);
  if (!text) throw new ApiError("bad_request", "text");
  if (text.length > TEXT_MAX) throw new ApiError("bad_request", "text");
  const logs = files(form, "compressed-log").slice(0, MAX_LOGS);
  const shots = files(form, "file");
  if (shots.length > MAX_SHOTS) throw new ApiError("bad_request", "file");

  const platform = platformOf(field(form, "user_agent", 64));
  // Android sends "Version".
  const version = field(form, "version", 32) ?? field(form, "Version", 32);
  const buildText = field(form, "build", 16);
  const build = buildText && /^\d{1,9}$/.test(buildText) ? Number(buildText) : null;
  const os = field(form, "os", 64);
  const labels = [...new Set(list(form.label).filter((x): x is string => typeof x === "string").map((l) => l.trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_LABELS);

  const id = randomUUID();
  const folder = join(deps.dir, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  try {
    for (const [prefix, group, fallback] of [["log", logs, "log"], ["shot", shots, "png"]] as const) {
      for (const [i, file] of group.entries()) {
        const name = `${prefix}-${String(i + 1).padStart(2, "0")}.${extensionOf(file, fallback)}`;
        await writeFile(join(folder, name), Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        names.push(name);
      }
    }
    const intakeId = `report:${id}`;
    await deps.db.query(
      `INSERT INTO bug_reports (id, user_id, text, platform, app_version, build, os, labels, files, intake_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, userId, text, platform, version ?? null, build, os ?? null, labels, names, deps.intake.enabled ? intakeId : null],
    );
    if (deps.intake.enabled && platform !== "other") {
      const { rows } = await deps.db.query<{ handle: string }>("SELECT handle FROM handles WHERE user_id = $1", [userId]);
      await deps.intake.enqueue({
        message_id: intakeId,
        kind: "report",
        reporter: { ref: userId, ...(rows[0] ? { handle: rows[0].handle } : {}) },
        text: text.slice(0, INTAKE_TEXT_MAX),
        report: {
          platform,
          ...(version ? { app_version: version } : {}),
          ...(build !== null ? { build } : {}),
          labels,
          has_logs: logs.length > 0,
          screenshot_count: shots.length,
          attachments_url: `${deps.publicApiUrl.replace(/\/$/, "")}/v1/admin/bug-reports/${id}`,
        },
      });
    }
  } catch (e) {
    await rm(folder, { recursive: true, force: true });
    throw e;
  }
  console.log(`bug report stored: ${platform}, ${names.length} files`);
  if (deps.support?.enabled) {
    void deps.support
      .notice(userId, appString("pt", "bipe_support_report_received"))
      .catch((e) => console.error(`bug report notice failed: ${(e as Error).message}`));
  }
  return { report_id: id };
}

type Row = {
  id: string;
  user_id: string;
  text: string;
  platform: "ios" | "android" | "other";
  app_version: string | null;
  build: number | null;
  os: string | null;
  labels: string[];
  files: string[];
  relayed_at: Date | null;
  created_at: Date;
};

function summary(r: Row) {
  return {
    id: r.id,
    created_at: r.created_at.toISOString(),
    platform: r.platform,
    app_version: r.app_version,
    build: r.build,
    labels: r.labels,
    log_count: r.files.filter((f) => f.startsWith("log-")).length,
    screenshot_count: r.files.filter((f) => f.startsWith("shot-")).length,
    relayed: r.relayed_at !== null,
  };
}

export async function listBugReports(db: Db) {
  const { rows } = await db.query<Row>("SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 200");
  return { reports: rows.map(summary) };
}

export async function getBugReport(db: Db, id: string) {
  if (!ID_PATTERN.test(id)) throw new ApiError("not_found");
  const { rows } = await db.query<Row>("SELECT * FROM bug_reports WHERE id = $1", [id]);
  const r = rows[0];
  if (!r) throw new ApiError("not_found");
  return { ...summary(r), user_id: r.user_id, text: r.text, os: r.os, files: r.files };
}

export async function readBugReportFile(db: Db, dir: string, id: string, name: string): Promise<Buffer> {
  if (!ID_PATTERN.test(id) || !FILE_NAME_PATTERN.test(name)) throw new ApiError("not_found");
  const { rows } = await db.query<{ files: string[] }>("SELECT files FROM bug_reports WHERE id = $1", [id]);
  if (!rows[0]?.files.includes(name)) throw new ApiError("not_found");
  return readFile(join(dir, id, name)).catch(() => {
    throw new ApiError("not_found");
  });
}

/** The caller's own reports for the data export (ADR 0112): text and metadata, no files. */
export async function bugReportsOf(db: Db, userId: string) {
  const { rows } = await db.query<Row>("SELECT * FROM bug_reports WHERE user_id = $1 ORDER BY created_at", [userId]);
  return rows.map((r) => ({ ...summary(r), text: r.text, os: r.os }));
}

async function remove(db: Db, dir: string, where: string, args: unknown[]): Promise<number> {
  const { rows } = await db.query<{ id: string; intake_id: string | null }>(`DELETE FROM bug_reports WHERE ${where} RETURNING id, intake_id`, args);
  for (const r of rows) {
    await rm(join(dir, r.id), { recursive: true, force: true });
    if (r.intake_id) await db.query("DELETE FROM intake_outbox WHERE message_id = $1", [r.intake_id]);
  }
  return rows.length;
}

/** Retention: reports and their files go after RETENTION_DAYS. */
export const pruneBugReports = (db: Db, dir: string) => remove(db, dir, "created_at < now() - make_interval(days => $1)", [RETENTION_DAYS]);

/** LGPD deletion request: every report of one account. */
export const forgetBugReports = (db: Db, dir: string, userId: string) => remove(db, dir, "user_id = $1", [userId]);
