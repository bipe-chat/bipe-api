import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { Config } from "./config.js";

// Minimal SMTP client on node:net and node:tls, so the API needs no mail library (one plain-text message per
// connection). Port 465: implicit TLS. Any other port: the server must offer STARTTLS, else the send fails.
// The client never sends a message or a password in plain text. Certificates are checked against the host name.
// Logs carry the SMTP reply code only: never the address, the body or a server reply text (it can echo input).

const TIMEOUT_MS = 20_000;

class SmtpError extends Error {}

interface Reply {
  code: number;
  lines: string[];
}

class Connection {
  private buffer = "";
  private lines: string[] = [];
  private wake?: () => void;
  private failure?: Error;

  constructor(readonly socket: net.Socket) {
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SmtpError("timeout")));
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  /** Stops reading from the socket, for the STARTTLS upgrade. */
  detach(): net.Socket {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.socket.setTimeout(0);
    return this.socket;
  }

  private onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    let i;
    while ((i = this.buffer.indexOf("\r\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, i));
      this.buffer = this.buffer.slice(i + 2);
    }
    this.wake?.();
  };

  private onError = (err: Error) => {
    this.failure = err instanceof SmtpError ? err : new SmtpError(`socket ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    this.wake?.();
  };

  private onClose = () => {
    this.failure ??= new SmtpError("closed");
    this.wake?.();
  };

  private async line(): Promise<string> {
    while (this.lines.length === 0) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
    return this.lines.shift()!;
  }

  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const m = /^(\d{3})([ -]?)(.*)$/.exec(await this.line());
      if (!m) throw new SmtpError("bad reply");
      lines.push(m[3]!);
      if (m[2] !== "-") return { code: Number(m[1]), lines };
    }
  }

  async expect(codes: number[], command?: string): Promise<Reply> {
    if (command !== undefined) this.socket.write(`${command}\r\n`);
    const reply = await this.reply();
    if (!codes.includes(reply.code)) throw new SmtpError(`reply ${reply.code}${command ? ` to ${command.split(" ")[0]}` : ""}`);
    return reply;
  }
}

function connectTls(options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...options, minVersion: "TLSv1.2" }, () => resolve(socket));
    socket.once("error", (e) => reject(new SmtpError(`tls ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SmtpError("timeout")));
  });
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once("error", (e) => reject(new SmtpError(`connect ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SmtpError("timeout")));
  });
}

/** RFC 2047 encoded words of at most 75 characters each, for a UTF-8 header value. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

const addressOf = (mailbox: string) => /<([^>]+)>\s*$/.exec(mailbox)?.[1] ?? mailbox.trim();

export class Mailer {
  private readonly from: string;
  private readonly domain: string;

  constructor(private readonly config: Config) {
    this.from = config.BIPE_MAIL_FROM;
    this.domain = addressOf(this.from).split("@")[1] ?? "localhost";
  }

  /** False when BIPE_SMTP_HOST is empty: email is off. */
  get enabled(): boolean {
    return this.config.BIPE_SMTP_HOST !== undefined;
  }

  /** Sends in the background. A failure is logged without the address and is not retried. */
  sendLater(to: string, subject: string, text: string, what: string): void {
    if (!this.enabled) return;
    this.send(to, subject, text).catch((e) => console.error(`mail: ${what} not sent: ${e instanceof SmtpError ? e.message : "error"}`));
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const host = this.config.BIPE_SMTP_HOST;
    if (!host) throw new SmtpError("off");
    if (/[\r\n<>\s]/.test(to) || !/^[^@]+@[^@]+$/.test(to)) throw new SmtpError("bad recipient");
    const port = this.config.BIPE_SMTP_PORT;

    let conn: Connection | undefined;
    try {
      if (port === 465) {
        conn = new Connection(await connectTls({ host, port, servername: host }));
        await conn.expect([220]);
        await conn.expect([250], `EHLO ${this.domain}`);
      } else {
        conn = new Connection(await connectPlain(host, port));
        await conn.expect([220]);
        const ehlo = await conn.expect([250], `EHLO ${this.domain}`);
        if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError("server offers no STARTTLS");
        await conn.expect([220], "STARTTLS");
        const raw = conn.detach();
        conn = undefined;
        try {
          conn = new Connection(await connectTls({ socket: raw, servername: host }));
        } catch (e) {
          raw.destroy();
          throw e;
        }
        await conn.expect([250], `EHLO ${this.domain}`);
      }
      const user = this.config.BIPE_SMTP_USER;
      const password = this.config.BIPE_SMTP_PASSWORD;
      if (user && password) {
        conn.socket.write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}\r\n`);
        await conn.expect([235]);
      }
      await conn.expect([250], `MAIL FROM:<${addressOf(this.from)}>`);
      await conn.expect([250, 251], `RCPT TO:<${to}>`);
      await conn.expect([354], "DATA");
      conn.socket.write(this.message(to, subject, text));
      await conn.expect([250]);
      conn.socket.end("QUIT\r\n");
    } catch (e) {
      conn?.socket.destroy();
      throw e;
    }
  }

  /** The DATA payload: headers, a base64 UTF-8 text body, and the end marker. Base64 lines never start with ".". */
  private message(to: string, subject: string, text: string): string {
    const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
    const headers = [
      `From: ${this.from}`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(16).toString("hex")}@${this.domain}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "Auto-Submitted: auto-generated",
    ];
    return `${headers.join("\r\n")}\r\n\r\n${body.replace(/\r\n$/, "")}\r\n.\r\n`;
  }
}
