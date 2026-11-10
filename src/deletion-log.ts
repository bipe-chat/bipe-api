import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Deletion log outside the database (bipe#1355). Backups keep the database up to 37 days, so a restore brings back
// accounts that were deleted after the dump. The deletion job appends one line here before it marks a request done.
// After a restore, `deletion replay --since <dump time>` queues each logged account again (deletion.ts requeueLogged).
// The file lives on the node (bipe-infra k8s/bipe/api.yaml) and the keys backup copies it to another bucket with
// another key than the data dump, so a lost node keeps it. It is personal data: each line holds only what the replay
// needs, and lines older than DELETION_LOG_KEEP_DAYS go.

export interface LoggedDeletion {
  user_id: string;
  /** ISO time the deletion job finished. */
  done_at: string;
  /** The person asked to redact their messages: the replay redacts the restored copies again. */
  redact: boolean;
}

/** The backup window (37 days) plus margin. */
export const DELETION_LOG_KEEP_DAYS = 40;

const FILE = "deletions.jsonl";

// The API process appends and prunes. One queue keeps a prune from dropping a line appended while it rewrites the file.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Appends one line and syncs it to disk. A throw keeps the request open, so the job tries again. */
export function appendDeletionLog(dir: string, entry: LoggedDeletion): Promise<void> {
  return serial(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fh = await open(join(dir, FILE), "a", 0o600);
    try {
      await fh.appendFile(`${JSON.stringify(entry)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

function parse(line: string): LoggedDeletion | null {
  try {
    const v = JSON.parse(line) as Partial<LoggedDeletion>;
    if (typeof v.user_id !== "string" || !v.user_id.startsWith("@")) return null;
    if (typeof v.done_at !== "string" || Number.isNaN(Date.parse(v.done_at))) return null;
    if (typeof v.redact !== "boolean") return null;
    return { user_id: v.user_id, done_at: v.done_at, redact: v.redact };
  } catch {
    return null;
  }
}

/** All lines, oldest first. `unreadable` counts lines that do not parse (for example a line cut by a crash). */
export async function readDeletionLog(dir: string): Promise<{ entries: LoggedDeletion[]; unreadable: number }> {
  let text: string;
  try {
    text = await readFile(join(dir, FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], unreadable: 0 };
    throw e;
  }
  const entries: LoggedDeletion[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parse(line);
    if (entry) entries.push(entry);
    else unreadable++;
  }
  return { entries, unreadable };
}

/** Drops lines older than DELETION_LOG_KEEP_DAYS. Writes a new file and renames it over the old one. */
export function pruneDeletionLog(dir: string, now = Date.now()): Promise<number> {
  return serial(async () => {
    const { entries } = await readDeletionLog(dir);
    const cutoff = now - DELETION_LOG_KEEP_DAYS * 86_400_000;
    const kept = entries.filter((e) => Date.parse(e.done_at) >= cutoff);
    const dropped = entries.length - kept.length;
    if (dropped === 0) return 0;
    const tmp = join(dir, `${FILE}.tmp`);
    await writeFile(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    const fh = await open(tmp, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, join(dir, FILE));
    return dropped;
  });
}
