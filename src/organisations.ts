import { z } from "zod";
import type { Db } from "./db.js";
import { validCnpj } from "./registry.js";

// Organisation requests from the site's organisation form (ADR 0126, bipe#410; was the partner form,
// ADR 0067, bipe#177). The API stores each request on the server in Brazil and sends no email.
// Rows are deleted after ORGANISATION_KEEP_DAYS or on request. Never log a request field.

export const ORGANISATION_KEEP_DAYS = 365;

export const ORGANISATION_KINDS = ["company", "institution", "association", "public_body", "partner", "other"] as const;
export const CUSTOMER_BANDS = ["lt_100", "100_1k", "1k_10k", "10k_100k", "gt_100k"] as const;
export const CHANNELS = ["whatsapp_app", "whatsapp_api", "sms", "email", "phone", "own_app", "other"] as const;
export const SPEND_BANDS = ["zero", "lt_500", "500_2k", "2k_10k", "10k_50k", "gt_50k", "unknown"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((s) => s || null);

export const OrganisationBody = z.object({
  organisation: text(200),
  name: text(120),
  email: z.email().max(254),
  role: optionalText(120),
  // Any input normalizeCnpj accepts (test-vectors/cnpj.json); stored as 14 characters.
  cnpj: z.string().trim().max(32).optional().transform((s, ctx) => {
    if (!s) return null;
    const cnpj = validCnpj(s);
    if (!cnpj) ctx.addIssue({ code: "custom", message: "invalid cnpj" });
    return cnpj;
  }),
  kind: z.enum(ORGANISATION_KINDS),
  customers_band: z.enum(CUSTOMER_BANDS).optional(),
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).optional().transform((a) => [...new Set(a ?? [])]),
  spend_band: z.enum(SPEND_BANDS).optional(),
  spend_note: optionalText(500),
  message: optionalText(2000),
  lang: z.enum(["pt", "en"]).default("pt"),
  website: z.string().max(200).optional(),
});
export type OrganisationRequest = z.infer<typeof OrganisationBody>;

/** Stores the request. Silent on the honeypot. */
export async function askAsOrganisation(db: Db, req: OrganisationRequest): Promise<void> {
  if (req.website) return;
  await db.query(
    `INSERT INTO organisation_requests
       (organisation, name, email, role, cnpj, kind, customers_band, channels, spend_band, spend_note, message, lang)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [req.organisation, req.name, req.email.trim().toLowerCase(), req.role, req.cnpj, req.kind,
      req.customers_band ?? null, req.channels, req.spend_band ?? null, req.spend_note, req.message, req.lang],
  );
}

export async function pruneOrganisationRequests(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM organisation_requests WHERE created_at <= now() - make_interval(days => $1)", [ORGANISATION_KEEP_DAYS]);
  return rowCount ?? 0;
}
