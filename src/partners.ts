import { z } from "zod";
import type { Db } from "./db.js";
import type { Mailer } from "./mailer.js";

// Partner requests from the site's partner page (ADR 0067, bipe#177). The API stores each request and
// emails a notice to BIPE_PARTNERS_TO. Rows are deleted after PARTNER_KEEP_DAYS or on request.
// Never log a request field.

export const PARTNER_KEEP_DAYS = 365;

const text = (max: number) => z.string().trim().min(1).max(max);

export const PartnerBody = z.object({
  organisation: text(200),
  name: text(120),
  email: z.email().max(254),
  kind: z.enum(["funder", "tech", "bank", "research", "civil", "public", "other"]),
  message: z.string().trim().max(2000).optional(),
  lang: z.enum(["pt", "en"]).default("pt"),
  website: z.string().max(200).optional(),
});
export type PartnerRequest = z.infer<typeof PartnerBody>;

/** Stores the request and sends the notice. Silent on the honeypot. */
export async function askToPartner(db: Db, mailer: Mailer, to: string, req: PartnerRequest): Promise<void> {
  if (req.website) return;
  const email = req.email.trim().toLowerCase();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO partner_requests (organisation, name, email, kind, message, lang) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.organisation, req.name, email, req.kind, req.message || null, req.lang],
  );
  mailer.sendLater(
    to,
    `Bipe: parceria (${req.organisation.replace(/[\r\n]+/g, " ").slice(0, 80)})`,
    [
      `Pedido de parceria #${rows[0]!.id} pelo site.`,
      "",
      `Organização: ${req.organisation}`,
      `Tipo: ${req.kind}`,
      `Contato: ${req.name} <${email}>`,
      `Idioma: ${req.lang}`,
      "",
      req.message || "(sem mensagem)",
      "",
      `Responda para ${email}. O pedido fica guardado por ${PARTNER_KEEP_DAYS} dias. Lista: node dist/cli.js partners list`,
    ].join("\n"),
    "partner notice",
  );
}

export async function prunePartnerRequests(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM partner_requests WHERE created_at <= now() - make_interval(days => $1)", [PARTNER_KEEP_DAYS]);
  return rowCount ?? 0;
}
