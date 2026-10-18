// Bipe API to the Starlings app intake (bipe#367). Text and metadata only: logs, screenshots and files stay on the
// server in Brazil. Every request is signed: hex HMAC-SHA256, key = STARLINGS_APP_INTAKE_KEY decoded from hex
// (32 bytes), message = `<direction>.<timestamp ms>.<raw body>`. The direction stops a replay the other way.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";

export type IntakeDirection = "intake" | "reply";

export type IntakeBody = {
  message_id: string;
  kind: "message" | "report";
  reporter: { ref: string; handle?: string; name?: string };
  text: string;
  report?: {
    platform: "ios" | "android";
    app_version?: string;
    build?: number;
    labels: string[];
    has_logs: boolean;
    screenshot_count: number;
    attachments_url: string;
  };
};

/** A receiver refuses a timestamp further off than this. */
export const MAX_SKEW_MS = 5 * 60_000;
const MAX_TRIES = 12;
const KEEP_FAILED_DAYS = 3;

export function intakeSignature(keyHex: string, direction: IntakeDirection, timestamp: string, rawBody: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(`${direction}.${timestamp}.${rawBody}`).digest("hex");
}

/** Checks a signed request from Starlings. Constant-time compare; refuses an old or future timestamp. */
export function verifyIntakeSignature(
  keyHex: string,
  direction: IntakeDirection,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now = Date.now(),
): boolean {
  if (!timestamp || !/^\d{1,16}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  const want = Buffer.from(intakeSignature(keyHex, direction, timestamp, rawBody), "hex");
  return timingSafeEqual(want, Buffer.from(signature, "hex"));
}

/**
 * Outbox to Starlings. A line is stored first, then sent; a failed send retries with backoff from `flush()`.
 * The row holds the text only until Starlings takes it. Starlings answers a repeat message_id with the same result.
 */
export class Intake {
  private flushing = false;

  constructor(
    private readonly db: Db,
    private readonly url: string,
    private readonly keyHex: string | undefined,
  ) {}

  get enabled(): boolean {
    return this.keyHex !== undefined;
  }

  async enqueue(body: IntakeBody): Promise<void> {
    if (!this.enabled) return;
    await this.db.query("INSERT INTO intake_outbox (message_id, body) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING", [
      body.message_id,
      JSON.stringify(body),
    ]);
    void this.flush();
  }

  /** Sends due lines. One flush at a time. Logs the outcome per line, never the body. */
  async flush(): Promise<void> {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      const { rows } = await this.db.query<{ message_id: string; body: string; tries: number }>(
        `SELECT message_id, body::text AS body, tries FROM intake_outbox
          WHERE next_at <= now() AND tries < $1 ORDER BY created_at LIMIT 50`,
        [MAX_TRIES],
      );
      for (const row of rows) {
        const status = await this.send(row.body);
        if (status === "sent") {
          await this.db.query("DELETE FROM intake_outbox WHERE message_id = $1", [row.message_id]);
          await this.db.query("UPDATE bug_reports SET relayed_at = now() WHERE intake_id = $1", [row.message_id]);
        } else {
          // Backoff: 1, 2, 4 ... minutes, at most 6 hours.
          const minutes = Math.min(2 ** row.tries, 360);
          await this.db.query(
            "UPDATE intake_outbox SET tries = tries + 1, next_at = now() + make_interval(mins => $2) WHERE message_id = $1",
            [row.message_id, minutes],
          );
          console.error(`starlings intake: ${status}, try ${row.tries + 1}`);
        }
      }
      // Lines that never got through: the text goes after a few days. The report itself stays for the staff view.
      await this.db.query(`DELETE FROM intake_outbox WHERE tries >= $1 AND created_at < now() - make_interval(days => $2)`, [
        MAX_TRIES,
        KEEP_FAILED_DAYS,
      ]);
    } catch (e) {
      console.error(`starlings intake flush failed: ${(e as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }

  private async send(rawBody: string): Promise<"sent" | string> {
    const timestamp = String(Date.now());
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-starlings-timestamp": timestamp,
          "x-starlings-signature": intakeSignature(this.keyHex!, "intake", timestamp, rawBody),
        },
        body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok ? "sent" : `HTTP ${res.status}`;
    } catch (e) {
      return (e as Error).name;
    }
  }
}
