// The Trabalho tab step by step (ADR 0194, bipe#799; contract: bipe-shared api/openapi.yaml). Each tool has a state:
// off, setup or live. Customers see only live tools. The Agenda keeps its own record: activation is setup and
// publication is live, so there is one source of truth; agenda_settings.tool_off marks a turned-off Agenda whose
// settings stay. Steps and suggestions come from records only, never from chats (ADR 0194 point 15).
import { readFileSync } from "node:fs";
import { z } from "zod";
import * as agenda from "./agenda.js";
import { businessTimeZone, localParts, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type {
  BusinessLiveTools,
  BusinessToday,
  BusinessToolId,
  BusinessTools,
  BusinessToolState,
  BusinessToolStatus,
  WebSettings,
  WorkSetup,
  WorkSetupStep,
  WorkSuggestions,
} from "./generated/business-api.js";
import * as orders from "./orders.js";
import * as queue from "./queue.js";
import * as quotes from "./quotes.js";

type Registry = {
  tools: { id: BusinessToolId; needs?: "catalog_service" | "catalog_product" }[];
  catalogMinItems: number;
  generic: { first_tool: BusinessToolId; step_order: WorkSetupStep["id"][] };
  sectors: { id: string; first_tool: BusinessToolId; step_order: WorkSetupStep["id"][] }[];
  suggestionDismissDays: number;
  suggestions: { id: string; tool: BusinessToolId }[];
};
const registry = JSON.parse(
  readFileSync(new URL("../src/generated/registries/business-tools.json", import.meta.url), "utf8"),
) as Registry;

const STATE = z.enum(["off", "setup", "live"]);
export const ToolChangeBody = z.object({ state: STATE }).strict();
export const SectorBody = z.object({ sector: z.string().min(1).max(40).optional() }).strict();
export const ToolId = z.enum(["agenda", "catalog", "orders", "quotes", "queue"]);

/** Growth events of the steps, from the server's own computation (registries/growth-events.json). */
export type StepEvents = { record(userId: string, event: "work_step_shown" | "work_step_done" | "work_sector_skipped" | "web_booking" | "web_order" | "web_claim"): void };

type CatalogFacts = { items: number; services: number; products: number; onRequest: number };

async function catalogFacts(db: Queryable, businessId: string): Promise<CatalogFacts> {
  const { rows } = await db.query<{ items: string; services: string; products: string; on_request: string }>(
    `SELECT count(*) AS items,
            count(*) FILTER (WHERE kind = 'service') AS services,
            count(*) FILTER (WHERE kind = 'product' AND price->>'mode' = 'fixed' AND price ? 'amount_cents') AS products,
            count(*) FILTER (WHERE price->>'mode' = 'on_request') AS on_request
       FROM catalog_items WHERE business_id = $1 AND archived_at IS NULL AND active`,
    [businessId],
  );
  const row = rows[0]!;
  return { items: Number(row.items), services: Number(row.services), products: Number(row.products), onRequest: Number(row.on_request) };
}

async function states(db: Queryable, businessId: string): Promise<Record<BusinessToolId, BusinessToolState>> {
  const result: Record<BusinessToolId, BusinessToolState> = { agenda: "off", catalog: "off", orders: "off", quotes: "off", queue: "off" };
  const { rows } = await db.query<{ tool: BusinessToolId; state: BusinessToolState }>(
    "SELECT tool, state FROM business_tool_states WHERE business_id = $1",
    [businessId],
  );
  for (const row of rows) result[row.tool] = row.state;
  const { rows: settings } = await db.query<{ published: boolean; tool_off: boolean }>(
    "SELECT published, tool_off FROM agenda_settings WHERE business_id = $1",
    [businessId],
  );
  const s = settings[0];
  result.agenda = !s || s.tool_off ? "off" : s.published ? "live" : "setup";
  return result;
}

async function sectorOf(db: Queryable, businessId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ sector: string | null }>("SELECT sector FROM business_work_settings WHERE business_id = $1", [businessId]);
  return rows[0]?.sector ?? undefined;
}

export async function tools(db: Queryable, businessId: string): Promise<BusinessTools> {
  const [current, facts, sector] = await Promise.all([states(db, businessId), catalogFacts(db, businessId), sectorOf(db, businessId)]);
  const { rows: activated } = await db.query("SELECT 1 FROM agenda_settings WHERE business_id = $1", [businessId]);
  const list: BusinessToolStatus[] = registry.tools.map(({ id, needs }) => {
    const state = current[id];
    // Activating the Agenda makes its services from a template, so only an activated Agenda can lack one.
    const lacking =
      (needs === "catalog_product" && facts.products === 0) ||
      (needs === "catalog_service" && facts.services === 0 && activated.length > 0);
    return { id, state, ...(lacking && needs ? { missing: needs } : {}) };
  });
  return { tools: list, ...(sector ? { sector } : {}) };
}

export async function liveTools(db: Queryable, businessId: string): Promise<BusinessLiveTools> {
  const current = await states(db, businessId);
  const web = await webSettings(db, businessId);
  return {
    tools: registry.tools.map((t) => t.id).filter((id) => current[id] === "live"),
    web_booking: current.agenda === "live" && web.web_booking,
    web_orders: current.orders === "live" && web.web_orders,
  };
}

export const WebSettingsBody = z.object({ web_booking: z.boolean(), web_orders: z.boolean() }).strict();

/** The owner's web switches, on by default (ADR 0195 points 12 and 16). */
export async function webSettings(db: Queryable, businessId: string): Promise<WebSettings> {
  const { rows } = await db.query<WebSettings>("SELECT web_booking, web_orders FROM business_work_settings WHERE business_id = $1", [businessId]);
  return rows[0] ?? { web_booking: true, web_orders: true };
}

export async function setWebSettings(db: Queryable, businessId: string, body: WebSettings): Promise<WebSettings> {
  await db.query(
    `INSERT INTO business_work_settings (business_id, web_booking, web_orders) VALUES ($1, $2, $3)
     ON CONFLICT (business_id) DO UPDATE SET web_booking = EXCLUDED.web_booking, web_orders = EXCLUDED.web_orders`,
    [businessId, body.web_booking, body.web_orders],
  );
  return webSettings(db, businessId);
}

/** Customer routes of a tool that is not live are refused (ADR 0194 point 2). Records that exist stay readable. */
export async function requireLive(db: Queryable, businessId: string, tool: BusinessToolId): Promise<void> {
  if ((await states(db, businessId))[tool] !== "live") throw new ApiError("tool_not_live", tool);
}

/** The public catálogo shows when the catálogo or Pedidos, which orders from it, is live. */
export async function catalogIsPublic(db: Queryable, businessId: string): Promise<boolean> {
  const current = await states(db, businessId);
  return current.catalog === "live" || current.orders === "live";
}

export async function setToolState(db: Db, apiUrl: string, businessId: string, tool: BusinessToolId, state: BusinessToolState): Promise<BusinessTools> {
  if (tool === "agenda") await setAgendaState(db, apiUrl, businessId, state);
  else {
    if (tool === "orders" && state !== "off" && (await catalogFacts(db, businessId)).products === 0) {
      throw new ApiError("tool_needs_catalog", "catalog_product");
    }
    await db.query(
      `INSERT INTO business_tool_states (business_id, tool, state) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, tool) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [businessId, tool, state],
    );
  }
  return tools(db, businessId);
}

async function setAgendaState(db: Db, apiUrl: string, businessId: string, state: BusinessToolState): Promise<void> {
  const { rows } = await db.query<{ time_zone: string }>("SELECT time_zone FROM agenda_settings WHERE business_id = $1", [businessId]);
  const settings = rows[0];
  if (state === "live") {
    if (!settings) throw new ApiError("tool_needs_catalog", "catalog_service");
    try {
      await agenda.saveSettings(db, apiUrl, businessId, { published: true, time_zone: settings.time_zone });
    } catch (e) {
      if (e instanceof ApiError && e.id === "bad_request") throw new ApiError("tool_needs_catalog", "catalog_service");
      throw e;
    }
    return;
  }
  // Without settings the Agenda stays off until the owner activates it with a template (spec agenda-setup).
  if (settings) {
    await db.query("UPDATE agenda_settings SET published = false, tool_off = $2 WHERE business_id = $1", [businessId, state === "off"]);
  }
}

export async function setSector(db: Queryable, businessId: string, body: z.infer<typeof SectorBody>, events?: StepEvents): Promise<BusinessTools> {
  if (body.sector && !registry.sectors.some((s) => s.id === body.sector)) throw new ApiError("bad_request", "sector");
  const before = await sectorOf(db, businessId);
  await db.query(
    `INSERT INTO business_work_settings (business_id, sector) VALUES ($1, $2)
     ON CONFLICT (business_id) DO UPDATE SET sector = EXCLUDED.sector`,
    [businessId, body.sector ?? null],
  );
  if (!body.sector && !before) events?.record(businessId, "work_sector_skipped");
  return tools(db, businessId);
}

export async function markLinkOpened(db: Queryable, businessId: string): Promise<void> {
  await db.query(
    `INSERT INTO business_work_settings (business_id, link_opened_at) VALUES ($1, now())
     ON CONFLICT (business_id) DO UPDATE SET link_opened_at = COALESCE(business_work_settings.link_opened_at, now())`,
    [businessId],
  );
}

function pathOf(sector: string | undefined) {
  return registry.sectors.find((s) => s.id === sector) ?? registry.generic;
}

export async function setup(db: Queryable, businessId: string, events?: StepEvents): Promise<WorkSetup> {
  const { rows } = await db.query<{ profile: boolean; handle: boolean; seal: boolean; link_opened: boolean; steps_done: string[] | null; sector: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM public_profiles p JOIN work_hours w ON w.user_id = p.user_id
                     WHERE p.user_id = $1 AND p.photo_version IS NOT NULL AND btrim(p.bio) <> '') AS profile,
            EXISTS (SELECT 1 FROM handles WHERE user_id = $1) AS handle,
            EXISTS (SELECT 1 FROM business_claims WHERE user_id = $1 AND status = 'verified') AS seal,
            COALESCE((SELECT link_opened_at IS NOT NULL FROM business_work_settings WHERE business_id = $1), false) AS link_opened,
            (SELECT steps_done FROM business_work_settings WHERE business_id = $1) AS steps_done,
            (SELECT sector FROM business_work_settings WHERE business_id = $1) AS sector`,
    [businessId],
  );
  const row = rows[0]!;
  const [facts, live] = await Promise.all([catalogFacts(db, businessId), liveTools(db, businessId)]);
  const done: Partial<Record<WorkSetupStep["id"], boolean>> = {
    profile: row.profile,
    link: row.handle && row.link_opened,
    catalog: facts.items >= registry.catalogMinItems,
    first_tool: live.tools.length > 0,
    seal: row.seal,
  };
  const path = pathOf(row.sector ?? undefined);
  // Seats do not exist yet (ADR 0087 owner case): second_seat stays out until the owner can add one.
  const steps: WorkSetupStep[] = path.step_order.filter((id) => id !== "second_seat").map((id) => ({ id, done: done[id] === true }));
  const doneNow = steps.filter((s) => s.done).map((s) => s.id as string);
  const known = row.steps_done ?? [];
  const fresh = doneNow.filter((id) => !known.includes(id));
  if (fresh.length > 0) {
    await db.query(
      `INSERT INTO business_work_settings (business_id, steps_done) VALUES ($1, $2)
       ON CONFLICT (business_id) DO UPDATE SET steps_done = EXCLUDED.steps_done`,
      [businessId, [...known, ...fresh]],
    );
    for (const _ of fresh) events?.record(businessId, "work_step_done");
  }
  if (doneNow.length < steps.length) events?.record(businessId, "work_step_shown");
  return { steps, done_count: doneNow.length, first_tool: path.first_tool };
}

export async function suggestions(db: Queryable, businessId: string): Promise<WorkSuggestions> {
  const [facts, current, dismissed] = await Promise.all([
    catalogFacts(db, businessId),
    states(db, businessId),
    db.query<{ suggestion: string }>(
      "SELECT suggestion FROM business_suggestion_dismissals WHERE business_id = $1 AND dismissed_at > now() - make_interval(days => $2)",
      [businessId, registry.suggestionDismissDays],
    ),
  ]);
  const gone = new Set(dismissed.rows.map((r) => r.suggestion));
  const fits: Record<string, boolean> = {
    quotes_for_on_request: facts.onRequest > 0,
    agenda_for_services: facts.services > 0,
    orders_for_products: facts.products > 0,
  };
  return {
    suggestions: registry.suggestions
      .filter((r) => fits[r.id] && current[r.tool] === "off" && !gone.has(r.id))
      .map((r) => ({ id: r.id, tool: r.tool })),
  };
}

export async function dismissSuggestion(db: Queryable, businessId: string, suggestion: string): Promise<WorkSuggestions> {
  if (!registry.suggestions.some((r) => r.id === suggestion)) throw new ApiError("not_found");
  await db.query(
    `INSERT INTO business_suggestion_dismissals (business_id, suggestion) VALUES ($1, $2)
     ON CONFLICT (business_id, suggestion) DO UPDATE SET dismissed_at = now()`,
    [businessId, suggestion],
  );
  return suggestions(db, businessId);
}

/** The Hoje section in one call. Each part reads what the owner screen reads. */
export async function today(db: Queryable, businessId: string): Promise<BusinessToday> {
  const date = localParts(await businessTimeZone(db, businessId), Date.now()).date;
  const { rows: activated } = await db.query("SELECT 1 FROM agenda_settings WHERE business_id = $1", [businessId]);
  const [bookings, open, queueToday, places, requests] = await Promise.all([
    activated.length > 0 ? agenda.ownerBookings(db, businessId, { date_from: date, date_to: date }).then((r) => r.bookings) : [],
    orders.ownerOrders(db, businessId),
    queue.ownerQueue(db, businessId),
    queue.ownerPlaces(db, businessId),
    quotes.ownerRequests(db, businessId),
  ]);
  return {
    bookings: bookings.filter((b) => b.status !== "cancelled" && b.status !== "no_show"),
    orders: open.orders.filter((o) => o.status === "sent" || o.status === "accepted" || o.status === "ready"),
    queue_open: queueToday.open,
    queue_waiting: places.places.filter((p) => p.status === "waiting").length,
    quote_requests: requests.requests,
  };
}
