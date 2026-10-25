// Catálogo (ADR 0104, bipe#328): one list per company of what it sells, services and products. A service is also
// the Agenda's service: the same row, with duration, buffers and agendas (ADR 0104). Removing an item archives it,
// so bookings and orders that name it keep their reference.
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { businessTimeZone, localParts, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { CatalogItem, CatalogItemInput } from "./generated/business-api.js";
import { stripJpeg } from "./profiles.js";

export const MAX_ITEMS = 500;

const Price = z.union([
  z.object({ mode: z.enum(["fixed", "from"]), text: z.string().trim().min(1).max(80), amount_cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  z.object({ mode: z.literal("on_request") }).strict(),
]);

export const CatalogItemBody = z
  .object({
    kind: z.enum(["service", "product"]),
    name: z.string().trim().min(1).max(120),
    price: Price,
    description: z.string().max(500).optional(),
    category: z.string().trim().max(80).optional(),
    active: z.boolean(),
    sort: z.number().int().min(0).max(1_000_000),
    sold_out_today: z.boolean().optional(),
    duration_minutes: z.number().int().min(1).max(1440).optional(),
    buffer_before_minutes: z.number().int().min(0).max(1440).optional(),
    buffer_after_minutes: z.number().int().min(0).max(1440).optional(),
    agenda_ids: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
  })
  .strict()
  .refine(
    (b) => b.kind === "service" || (b.duration_minutes === undefined && b.buffer_before_minutes === undefined && b.buffer_after_minutes === undefined && b.agenda_ids === undefined),
    { message: "product_scheduling_fields", path: ["kind"] },
  )
  .refine((b) => !b.agenda_ids || new Set(b.agenda_ids).size === b.agenda_ids.length, { message: "duplicate_agenda", path: ["agenda_ids"] });

export const CatalogOrderBody = z.object({ item_ids: z.array(z.string().min(1).max(128)).max(MAX_ITEMS) }).strict();

export type ItemRow = {
  id: string;
  business_id: string;
  kind: "service" | "product";
  name: string;
  price: CatalogItem["price"];
  description: string | null;
  category: string | null;
  active: boolean;
  sort: number;
  sold_out_on: string | null;
  duration_minutes: number | null;
  buffer_before_minutes: number | null;
  buffer_after_minutes: number | null;
  agenda_ids: string[] | null;
  photo_version: string | null;
};

export const ITEM_COLUMNS = `id, business_id, kind, name, price, description, category, active, sort, sold_out_on::text AS sold_out_on,
  duration_minutes, buffer_before_minutes, buffer_after_minutes, agenda_ids, photo_version`;

const photoUrl = (apiUrl: string, row: ItemRow) =>
  `${apiUrl.replace(/\/$/, "")}/v1/businesses/${encodeURIComponent(row.business_id)}/catalog/items/${encodeURIComponent(row.id)}/photo?v=${row.photo_version}`;

/** today: the business's local date, for sold_out_today. */
export function itemJson(row: ItemRow, apiUrl: string, today: string): CatalogItem {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    price: row.price,
    ...(row.description ? { description: row.description } : {}),
    ...(row.category ? { category: row.category } : {}),
    active: row.active,
    sort: row.sort,
    sold_out_today: row.sold_out_on === today,
    ...(row.kind === "service" && row.duration_minutes !== null ? { duration_minutes: row.duration_minutes } : {}),
    ...(row.kind === "service" && row.buffer_before_minutes !== null ? { buffer_before_minutes: row.buffer_before_minutes } : {}),
    ...(row.kind === "service" && row.buffer_after_minutes !== null ? { buffer_after_minutes: row.buffer_after_minutes } : {}),
    ...(row.kind === "service" && row.agenda_ids?.length ? { agenda_ids: row.agenda_ids } : {}),
    ...(row.photo_version ? { photo: photoUrl(apiUrl, row) } : {}),
  };
}

async function today(db: Queryable, businessId: string): Promise<string> {
  return localParts(await businessTimeZone(db, businessId), Date.now()).date;
}

async function items(db: Queryable, businessId: string, publicOnly: boolean): Promise<ItemRow[]> {
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM catalog_items WHERE business_id = $1 AND archived_at IS NULL ${publicOnly ? "AND active" : ""}
     ORDER BY sort, id`,
    [businessId],
  );
  return rows;
}

export async function ownerCatalog(db: Queryable, apiUrl: string, businessId: string) {
  const day = await today(db, businessId);
  return { items: (await items(db, businessId, false)).map((r) => itemJson(r, apiUrl, day)) };
}

export async function publicCatalog(db: Queryable, apiUrl: string, businessId: string) {
  const day = await today(db, businessId);
  return { items: (await items(db, businessId, true)).map((r) => itemJson(r, apiUrl, day)) };
}

export async function itemRow(db: Queryable, businessId: string, itemId: string): Promise<ItemRow> {
  const { rows } = await db.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM catalog_items WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`, [businessId, itemId]);
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

/** Agenda IDs on a service must name this company's agendas that still exist. */
async function checkAgendas(db: Queryable, businessId: string, ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return;
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agendas WHERE business_id = $1 AND id = ANY($2) AND deleted_at IS NULL",
    [businessId, ids],
  );
  if (rows[0]!.n !== ids.length) throw new ApiError("bad_request", "unknown_agenda");
}

function values(body: CatalogItemInput, day: string) {
  const service = body.kind === "service";
  return [
    body.kind, body.name, JSON.stringify(body.price), body.description || null, body.category || null, body.active, body.sort,
    body.sold_out_today ? day : null,
    service ? body.duration_minutes ?? null : null,
    service ? body.buffer_before_minutes ?? null : null,
    service ? body.buffer_after_minutes ?? null : null,
    service ? body.agenda_ids ?? null : null,
  ];
}

export async function createItem(db: Queryable, apiUrl: string, businessId: string, body: CatalogItemInput): Promise<CatalogItem> {
  const { rows: count } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM catalog_items WHERE business_id = $1 AND archived_at IS NULL", [businessId]);
  if (count[0]!.n >= MAX_ITEMS) throw new ApiError("bad_request", "too_many_items");
  await checkAgendas(db, businessId, body.agenda_ids);
  const day = await today(db, businessId);
  const { rows } = await db.query<ItemRow>(
    `INSERT INTO catalog_items (id, business_id, kind, name, price, description, category, active, sort, sold_out_on,
       duration_minutes, buffer_before_minutes, buffer_after_minutes, agenda_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${ITEM_COLUMNS}`,
    [randomUUID(), businessId, ...values(body, day)],
  );
  return itemJson(rows[0]!, apiUrl, day);
}

export async function replaceItem(db: Queryable, apiUrl: string, businessId: string, itemId: string, body: CatalogItemInput): Promise<CatalogItem> {
  const old = await itemRow(db, businessId, itemId);
  // A service named by bookings stays a service: its kind cannot flip under them.
  if (old.kind !== body.kind) {
    const { rowCount } = await db.query("SELECT 1 FROM bookings WHERE service_id = $1 LIMIT 1", [itemId]);
    if (rowCount) throw new ApiError("bad_request", "kind_in_use");
  }
  await checkAgendas(db, businessId, body.agenda_ids);
  const day = await today(db, businessId);
  const { rows } = await db.query<ItemRow>(
    `UPDATE catalog_items SET kind = $3, name = $4, price = $5, description = $6, category = $7, active = $8, sort = $9,
       sold_out_on = $10, duration_minutes = $11, buffer_before_minutes = $12, buffer_after_minutes = $13, agenda_ids = $14,
       updated_at = now()
     WHERE business_id = $1 AND id = $2 AND archived_at IS NULL RETURNING ${ITEM_COLUMNS}`,
    [businessId, itemId, ...values(body, day)],
  );
  return itemJson(rows[0]!, apiUrl, day);
}

export async function archiveItem(db: Queryable, businessId: string, itemId: string): Promise<void> {
  const { rowCount } = await db.query(
    "UPDATE catalog_items SET archived_at = now(), active = false, photo = NULL, photo_version = NULL, updated_at = now() WHERE business_id = $1 AND id = $2 AND archived_at IS NULL",
    [businessId, itemId],
  );
  if (!rowCount) throw new ApiError("not_found");
}

/** The listed items take sort 0, 1, 2… in that order; items left out keep their place after them. */
export async function reorder(db: Queryable, apiUrl: string, businessId: string, itemIds: string[]) {
  if (new Set(itemIds).size !== itemIds.length) throw new ApiError("bad_request", "duplicate_item");
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM catalog_items WHERE business_id = $1 AND id = ANY($2) AND archived_at IS NULL",
    [businessId, itemIds],
  );
  if (rows[0]!.n !== itemIds.length) throw new ApiError("not_found");
  await db.query(
    `UPDATE catalog_items c SET sort = $3 + r.n - 1, updated_at = now()
     FROM (SELECT id, row_number() OVER (ORDER BY sort, id) AS n FROM catalog_items
           WHERE business_id = $1 AND archived_at IS NULL AND NOT (id = ANY($2))) r
     WHERE c.id = r.id`,
    [businessId, itemIds, itemIds.length],
  );
  await db.query(
    `UPDATE catalog_items c SET sort = o.n - 1, updated_at = now()
     FROM unnest($2::text[]) WITH ORDINALITY AS o(id, n) WHERE c.id = o.id AND c.business_id = $1`,
    [businessId, itemIds],
  );
  return ownerCatalog(db, apiUrl, businessId);
}

export async function setItemPhoto(db: Db, apiUrl: string, businessId: string, itemId: string, body: Uint8Array): Promise<CatalogItem> {
  await itemRow(db, businessId, itemId);
  const photo = stripJpeg(body);
  await db.query("UPDATE catalog_items SET photo = $3, photo_version = $4, updated_at = now() WHERE business_id = $1 AND id = $2", [
    businessId, itemId, photo, randomBytes(6).toString("base64url"),
  ]);
  return itemJson(await itemRow(db, businessId, itemId), apiUrl, await today(db, businessId));
}

export async function deleteItemPhoto(db: Db, businessId: string, itemId: string): Promise<void> {
  await itemRow(db, businessId, itemId);
  await db.query("UPDATE catalog_items SET photo = NULL, photo_version = NULL, updated_at = now() WHERE business_id = $1 AND id = $2", [businessId, itemId]);
}

export async function publicItemPhoto(db: Db, businessId: string, itemId: string): Promise<Buffer> {
  const { rows } = await db.query<{ photo: Buffer }>(
    "SELECT photo FROM catalog_items WHERE business_id = $1 AND id = $2 AND archived_at IS NULL AND active AND photo IS NOT NULL",
    [businessId, itemId],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0].photo;
}
