// Routes of the business tools (contract: bipe-shared api/openapi.yaml, tags Catálogo, Agenda, Fila virtual,
// Orçamento and Pedidos).
// Owner routes (/v1/me/business/...) need the company account's own token. Customer routes
// (/v1/businesses/{handle}/...) take the business handle or its Matrix ID; reads are public, writes need a token.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import * as agenda from "./agenda.js";
import type { MatrixAuth } from "./auth.js";
import { businessOf, requireCompany } from "./business-common.js";
import type { BusinessPushes } from "./business-pushes.js";
import * as tools from "./business-tools.js";
import * as shopWeb from "./shop-web.js";
import * as catalog from "./catalog.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import * as orders from "./orders.js";
import * as queue from "./queue.js";
import * as quotes from "./quotes.js";
import { RateLimiter } from "./ratelimit.js";

export type BusinessDeps = {
  db: Db;
  auth: MatrixAuth;
  apiUrl: string;
  siteUrl: string;
  /** The own web client origin (ADR 0225); the site only when absent. */
  webOrigin?: string;
  clientIp: (c: Context) => string;
  /** Growth events of the setup steps; absent in tests. */
  stepEvents?: tools.StepEvents;
  /** Reminders and alerts (bipe#320); absent in tests. */
  pushes?: BusinessPushes;
};

export const CATALOG_PHOTO_PATH = /^\/v1\/me\/business\/catalog\/items\/[^/]+\/photo$/;

const userIdOf = (customer: { user_id: string } | { name: string }) => ("user_id" in customer ? customer.user_id : undefined);

async function parse<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("bad_request", parsed.error.issues[0]?.path.join(".") || parsed.error.issues[0]?.message);
  return parsed.data;
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError("bad_request", parsed.error.issues[0]?.path.join("."));
  return parsed.data;
}

export function businessRoutes({ db, auth, apiUrl, siteUrl, webOrigin, clientIp, stepEvents, pushes }: BusinessDeps): Hono {
  const app = new Hono();
  const limits = {
    ownerWrite: new RateLimiter(600, 3_600_000),
    photo: new RateLimiter(60, 3_600_000),
    publicRead: new RateLimiter(120, 60_000),
    publicPhoto: new RateLimiter(240, 60_000),
    hold: new RateLimiter(20, 3_600_000),
    customerWrite: new RateLimiter(60, 3_600_000),
    mine: new RateLimiter(120, 60_000),
    join: new RateLimiter(20, 3_600_000),
    order: new RateLimiter(20, 3_600_000),
    quoteRequest: new RateLimiter(10, 3_600_000),
    webWrite: new RateLimiter(20, 3_600_000),
  };
  const mine = async (c: Context) => {
    const userId = await auth.userId(c.req.header("authorization"));
    limits.mine.check(userId);
    c.header("cache-control", "no-store");
    return userId;
  };
  const owner = async (c: Context, write = true) => {
    const userId = await requireCompany(db, await auth.userId(c.req.header("authorization")));
    if (write) limits.ownerWrite.check(userId);
    c.header("cache-control", "no-store");
    return userId;
  };
  const customer = async (c: Context) => {
    const userId = await auth.userId(c.req.header("authorization"));
    limits.customerWrite.check(userId);
    c.header("cache-control", "no-store");
    return { userId, businessId: await businessOf(db, c.req.param("handle")!) };
  };
  const publicBusiness = async (c: Context) => {
    limits.publicRead.check(clientIp(c));
    c.header("cache-control", "no-store");
    return businessOf(db, c.req.param("handle")!);
  };
  // The site and the own web client (ADR 0225) both read the public business routes.
  const origin = [siteUrl, ...(webOrigin ? [webOrigin] : [])].map((o) => o.replace(/\/$/, ""));
  app.use("/v1/businesses/*", cors({ origin, allowMethods: ["GET", "POST"], allowHeaders: ["authorization", "content-type", shopWeb.TOKEN_HEADER] }));

  // ---- Tool state, sector, steps, suggestions, Hoje (ADR 0194) ----
  app.get("/v1/me/business/tools", async (c) => c.json(await tools.tools(db, await owner(c, false))));
  app.put("/v1/me/business/tools/:toolId", async (c) => {
    const businessId = await owner(c);
    const tool = tools.ToolId.safeParse(c.req.param("toolId"));
    if (!tool.success) throw new ApiError("not_found");
    const { state } = await parse(c, tools.ToolChangeBody);
    return c.json(await tools.setToolState(db, apiUrl, businessId, tool.data, state));
  });
  app.put("/v1/me/business/sector", async (c) => {
    const businessId = await owner(c);
    return c.json(await tools.setSector(db, businessId, await parse(c, tools.SectorBody), stepEvents));
  });
  app.get("/v1/me/business/setup", async (c) => c.json(await tools.setup(db, await owner(c, false), stepEvents)));
  app.post("/v1/me/business/setup/link-opened", async (c) => {
    const businessId = await owner(c);
    await tools.markLinkOpened(db, businessId);
    return c.json(await tools.setup(db, businessId, stepEvents));
  });
  app.get("/v1/me/business/suggestions", async (c) => c.json(await tools.suggestions(db, await owner(c, false))));
  app.post("/v1/me/business/suggestions/:suggestionId/dismiss", async (c) => {
    const businessId = await owner(c);
    return c.json(await tools.dismissSuggestion(db, businessId, c.req.param("suggestionId")));
  });
  app.get("/v1/me/business/today", async (c) => c.json(await tools.today(db, await owner(c, false))));
  app.get("/v1/businesses/:handle/tools", async (c) => c.json(await tools.liveTools(db, await publicBusiness(c))));

  // ---- The shop on the web, no session (ADR 0195) ----
  // The limit counts per address on each shop; the key stays in memory only.
  const webWrite = async (c: Context) => {
    const businessId = await businessOf(db, c.req.param("handle")!);
    limits.webWrite.check(`${clientIp(c)}|${businessId}`);
    c.header("cache-control", "no-store");
    return businessId;
  };
  const shopToken = (c: Context) => c.req.header(shopWeb.TOKEN_HEADER);
  app.post("/v1/businesses/:handle/web/bookings", async (c) => {
    const businessId = await webWrite(c);
    const body = await parse(c, agenda.WebBookingBody);
    const result = await shopWeb.book(db, businessId, shopToken(c), body);
    pushes?.owner(businessId, "work_new_booking");
    stepEvents?.record(businessId, "web_booking");
    return c.json(result, 201);
  });
  app.post("/v1/businesses/:handle/web/orders", async (c) => {
    const businessId = await webWrite(c);
    const body = await parse(c, orders.WebOrderBody);
    const result = await shopWeb.order(db, businessId, shopToken(c), body);
    pushes?.owner(businessId, "work_new_order");
    stepEvents?.record(businessId, "web_order");
    return c.json(result, 201);
  });
  app.post("/v1/businesses/:handle/web/queue", async (c) => {
    const businessId = await webWrite(c);
    return c.json(await shopWeb.joinQueue(db, businessId, shopToken(c), await parse(c, queue.WebJoinBody)), 201);
  });
  app.post("/v1/businesses/:handle/web/queue/places/:placeId/leave", async (c) => {
    const businessId = await webWrite(c);
    return c.json(await shopWeb.leaveQueue(db, businessId, shopToken(c), c.req.param("placeId")));
  });
  app.get("/v1/businesses/:handle/web/records", async (c) => {
    const businessId = await publicBusiness(c);
    return c.json(await shopWeb.records(db, businessId, shopToken(c)));
  });
  app.post("/v1/businesses/:handle/web/bookings/:bookingId/cancel", async (c) => {
    const businessId = await webWrite(c);
    const booking = await shopWeb.cancelBooking(db, businessId, shopToken(c), c.req.param("bookingId"));
    pushes?.owner(businessId, "work_cancelled");
    return c.json(booking);
  });
  app.post("/v1/businesses/:handle/web/orders/:orderId/cancel", async (c) => {
    const businessId = await webWrite(c);
    const order = await shopWeb.cancelOrder(db, businessId, shopToken(c), c.req.param("orderId"));
    pushes?.owner(businessId, "work_cancelled");
    return c.json(order);
  });
  app.post("/v1/businesses/:handle/web/claim", async (c) => {
    const { userId, businessId } = await customer(c);
    const { token } = await parse(c, shopWeb.ClaimBody);
    const result = await shopWeb.claim(db, businessId, token, userId);
    stepEvents?.record(businessId, "web_claim");
    return c.json(result);
  });
  app.get("/v1/me/business/web-settings", async (c) => c.json(await tools.webSettings(db, await owner(c, false))));
  app.put("/v1/me/business/web-settings", async (c) => {
    const businessId = await owner(c);
    return c.json(await tools.setWebSettings(db, businessId, await parse(c, tools.WebSettingsBody)));
  });

  // ---- Catálogo, owner ----
  app.get("/v1/me/business/catalog", async (c) => c.json(await catalog.ownerCatalog(db, apiUrl, await owner(c, false))));
  app.post("/v1/me/business/catalog/items", async (c) => {
    const businessId = await owner(c);
    return c.json(await catalog.createItem(db, apiUrl, businessId, await parse(c, catalog.CatalogItemBody)), 201);
  });
  app.put("/v1/me/business/catalog/items/:itemId", async (c) => {
    const businessId = await owner(c);
    return c.json(await catalog.replaceItem(db, apiUrl, businessId, c.req.param("itemId"), await parse(c, catalog.CatalogItemBody)));
  });
  app.delete("/v1/me/business/catalog/items/:itemId", async (c) => {
    await catalog.archiveItem(db, await owner(c), c.req.param("itemId"));
    return c.body(null, 204);
  });
  app.put("/v1/me/business/catalog/order", async (c) => {
    const businessId = await owner(c);
    return c.json(await catalog.reorder(db, apiUrl, businessId, (await parse(c, catalog.CatalogOrderBody)).item_ids));
  });
  app.get("/v1/me/business/catalog/items/:itemId/photo", async (c) => {
    const photo = await catalog.ownerItemPhoto(db, await owner(c, false), c.req.param("itemId"));
    return c.body(new Uint8Array(photo), 200, { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  });
  app.put("/v1/me/business/catalog/items/:itemId/photo", async (c) => {
    const businessId = await owner(c);
    limits.photo.check(businessId);
    if (c.req.header("content-type")?.split(";")[0]?.trim() !== "image/jpeg") throw new ApiError("photo_invalid", "not_jpeg");
    return c.json(await catalog.setItemPhoto(db, apiUrl, businessId, c.req.param("itemId"), new Uint8Array(await c.req.arrayBuffer())));
  });
  app.delete("/v1/me/business/catalog/items/:itemId/photo", async (c) => {
    await catalog.deleteItemPhoto(db, await owner(c), c.req.param("itemId"));
    return c.body(null, 204);
  });

  // ---- Catálogo, public ----
  app.get("/v1/businesses/:handle/catalog", async (c) => {
    const businessId = await publicBusiness(c);
    return c.json((await tools.catalogIsPublic(db, businessId)) ? await catalog.publicCatalog(db, apiUrl, businessId) : { items: [] });
  });
  app.get("/v1/businesses/:handle/catalog/items/:itemId/photo", async (c) => {
    limits.publicPhoto.check(clientIp(c));
    const photo = await catalog.publicItemPhoto(db, await businessOf(db, c.req.param("handle")), c.req.param("itemId"));
    return c.body(new Uint8Array(photo), 200, { "content-type": "image/jpeg", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
  });

  // ---- Agenda, owner ----
  app.get("/v1/me/business/agenda", async (c) => c.json(await agenda.agendaState(db, apiUrl, await owner(c, false))));
  app.put("/v1/me/business/agenda", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.saveSettings(db, apiUrl, businessId, await parse(c, agenda.SettingsBody)));
  });
  app.post("/v1/me/business/agenda/activate", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.activate(db, apiUrl, businessId, await parse(c, agenda.ActivationBody)), 201);
  });
  app.get("/v1/me/business/agenda/agendas", async (c) => c.json(await agenda.listAgendas(db, await owner(c, false))));
  app.post("/v1/me/business/agenda/agendas", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.createAgenda(db, businessId, await parse(c, agenda.AgendaBody)), 201);
  });
  app.put("/v1/me/business/agenda/agendas/:agendaId", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.replaceAgenda(db, businessId, c.req.param("agendaId"), await parse(c, agenda.AgendaBody)));
  });
  app.delete("/v1/me/business/agenda/agendas/:agendaId", async (c) => {
    await agenda.deleteAgenda(db, await owner(c), c.req.param("agendaId"));
    return c.body(null, 204);
  });
  app.get("/v1/me/business/agenda/agendas/:agendaId/availability", async (c) => c.json(await agenda.availabilityOf(db, await owner(c, false), c.req.param("agendaId"))));
  app.put("/v1/me/business/agenda/agendas/:agendaId/availability", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.setAvailability(db, businessId, c.req.param("agendaId"), await parse(c, agenda.AvailabilityBody)));
  });
  app.get("/v1/me/business/agenda/overrides", async (c) => {
    const businessId = await owner(c, false);
    const q = query(c, z.object({ date_from: z.iso.date().optional(), date_to: z.iso.date().optional() }));
    return c.json(await agenda.listOverrides(db, businessId, q.date_from, q.date_to));
  });
  app.post("/v1/me/business/agenda/overrides", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.createOverride(db, businessId, await parse(c, agenda.OverrideBody)), 201);
  });
  app.put("/v1/me/business/agenda/overrides/:overrideId", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.replaceOverride(db, businessId, c.req.param("overrideId"), await parse(c, agenda.OverrideBody)));
  });
  app.delete("/v1/me/business/agenda/overrides/:overrideId", async (c) => {
    await agenda.deleteOverride(db, await owner(c), c.req.param("overrideId"));
    return c.body(null, 204);
  });
  app.post("/v1/me/business/agenda/blocks", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.block(db, businessId, await parse(c, agenda.BlockBody)), 201);
  });
  app.post("/v1/me/business/agenda/close-day", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.closeDay(db, businessId, await parse(c, agenda.CloseDayBody)), 201);
  });
  app.get("/v1/me/business/agenda/services", async (c) => c.json(await agenda.listServices(db, apiUrl, await owner(c, false))));
  app.post("/v1/me/business/agenda/services", async (c) => {
    const businessId = await owner(c);
    const body = await parse(c, agenda.ServiceBody);
    return c.json(await catalog.createItem(db, apiUrl, businessId, body), 201);
  });
  app.put("/v1/me/business/agenda/services/:serviceId", async (c) => {
    const businessId = await owner(c);
    const body = await parse(c, agenda.ServiceBody);
    return c.json(await catalog.replaceItem(db, apiUrl, businessId, c.req.param("serviceId"), body));
  });
  app.delete("/v1/me/business/agenda/services/:serviceId", async (c) => {
    await catalog.archiveItem(db, await owner(c), c.req.param("serviceId"));
    return c.body(null, 204);
  });
  app.get("/v1/me/business/agenda/policy", async (c) => c.json(await agenda.policyOf(db, await owner(c, false))));
  app.put("/v1/me/business/agenda/policy", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.setPolicy(db, businessId, await parse(c, agenda.PolicyBody)));
  });
  app.get("/v1/me/business/agenda/bookings", async (c) => {
    const businessId = await owner(c, false);
    return c.json(await agenda.ownerBookings(db, businessId, query(c, agenda.OwnerBookingsQuery)));
  });
  app.post("/v1/me/business/agenda/bookings", async (c) => {
    const businessId = await owner(c);
    return c.json(await agenda.ownerBook(db, businessId, await parse(c, agenda.OwnerBookingBody)), 201);
  });
  app.post("/v1/me/business/agenda/bookings/:bookingId/move", async (c) => {
    const businessId = await owner(c);
    const booking = await agenda.ownerMove(db, businessId, c.req.param("bookingId"), await parse(c, agenda.MoveBody));
    pushes?.customer(userIdOf(booking.customer), "booking_changed");
    return c.json(booking);
  });
  for (const action of ["cancel", "no-show", "accept", "refuse"] as const) {
    app.post(`/v1/me/business/agenda/bookings/:bookingId/${action}`, async (c) => {
      const booking = await agenda.ownerAction(db, await owner(c), c.req.param("bookingId"), action);
      if (action !== "no-show") pushes?.customer(userIdOf(booking.customer), "booking_changed");
      return c.json(booking);
    });
  }

  // ---- Agenda, customer ----
  app.get("/v1/businesses/:handle/agenda/services", async (c) => c.json(await agenda.publicServices(db, apiUrl, await publicBusiness(c))));
  app.get("/v1/businesses/:handle/agenda/agendas", async (c) => {
    const businessId = await publicBusiness(c);
    return c.json(await agenda.publicAgendas(db, businessId, query(c, z.object({ service_id: z.string().min(1).max(128).optional() })).service_id));
  });
  app.get("/v1/businesses/:handle/agenda/slots", async (c) => {
    const businessId = await publicBusiness(c);
    return c.json(await agenda.slots(db, businessId, query(c, agenda.SlotsQuery)));
  });
  app.post("/v1/businesses/:handle/agenda/hold", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.hold.check(userId);
    return c.json(await agenda.hold(db, businessId, userId, await parse(c, agenda.HoldBody)), 201);
  });
  app.post("/v1/businesses/:handle/agenda/bookings/:bookingId/confirm", async (c) => {
    const { userId, businessId } = await customer(c);
    const booking = await agenda.confirm(db, businessId, userId, c.req.param("bookingId"));
    pushes?.owner(businessId, "work_new_booking");
    return c.json(booking);
  });
  app.post("/v1/businesses/:handle/agenda/bookings/:bookingId/cancel", async (c) => {
    const { userId, businessId } = await customer(c);
    const booking = await agenda.customerCancel(db, businessId, userId, c.req.param("bookingId"));
    pushes?.owner(businessId, "work_cancelled");
    return c.json(booking);
  });
  app.post("/v1/businesses/:handle/agenda/bookings/:bookingId/move", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.hold.check(userId);
    return c.json(await agenda.customerMove(db, businessId, userId, c.req.param("bookingId"), await parse(c, agenda.MoveBody)));
  });
  app.get("/v1/me/bookings", async (c) => c.json(await agenda.myBookings(db, await mine(c))));

  // ---- Fila virtual ----
  app.get("/v1/me/business/queue", async (c) => c.json(await queue.ownerQueue(db, await owner(c, false))));
  app.post("/v1/me/business/queue/open", async (c) => c.json(await queue.setOpen(db, await owner(c), true)));
  app.post("/v1/me/business/queue/close", async (c) => c.json(await queue.setOpen(db, await owner(c), false)));
  app.put("/v1/me/business/queue/policy", async (c) => {
    const businessId = await owner(c);
    return c.json(await queue.setPolicy(db, businessId, await parse(c, queue.PolicyBody)));
  });
  app.get("/v1/me/business/queue/places", async (c) => c.json(await queue.ownerPlaces(db, await owner(c, false))));
  app.post("/v1/me/business/queue/places", async (c) => {
    const businessId = await owner(c);
    return c.json(await queue.addPlace(db, businessId, await parse(c, queue.OwnerPlaceBody)), 201);
  });
  app.post("/v1/me/business/queue/call-next", async (c) => {
    const place = await queue.callNext(db, await owner(c));
    pushes?.customer(userIdOf(place.customer), "queue_called");
    return c.json(place);
  });
  for (const action of ["served", "no-show", "recall"] as const) {
    app.post(`/v1/me/business/queue/places/:placeId/${action}`, async (c) => {
      const place = await queue.placeAction(db, await owner(c), c.req.param("placeId"), action);
      if (action === "recall") pushes?.customer(userIdOf(place.customer), "queue_called");
      return c.json(place);
    });
  }
  app.get("/v1/businesses/:handle/queue", async (c) => {
    const businessId = await publicBusiness(c);
    const today = await queue.publicQueue(db, businessId);
    return c.json((await tools.liveTools(db, businessId)).tools.includes("queue") ? today : { ...today, open: false });
  });
  app.post("/v1/businesses/:handle/queue/join", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.join.check(userId);
    await tools.requireLive(db, businessId, "queue");
    return c.json(await queue.join(db, businessId, userId, await parse(c, queue.JoinBody)), 201);
  });
  app.get("/v1/businesses/:handle/queue/me", async (c) => {
    const userId = await mine(c);
    return c.json(await queue.myPlace(db, await businessOf(db, c.req.param("handle")), userId));
  });
  app.post("/v1/businesses/:handle/queue/places/:placeId/leave", async (c) => {
    const { userId, businessId } = await customer(c);
    return c.json(await queue.leave(db, businessId, userId, c.req.param("placeId")));
  });
  app.get("/v1/me/queue-places", async (c) => c.json(await queue.myPlaces(db, await mine(c))));

  // ---- Orçamento ----
  app.get("/v1/me/business/quotes/requests", async (c) => c.json(await quotes.ownerRequests(db, await owner(c, false))));
  app.post("/v1/me/business/quotes/requests/:requestId/quote", async (c) => {
    const businessId = await owner(c);
    return c.json(await quotes.answer(db, businessId, c.req.param("requestId"), await parse(c, quotes.VersionBody)), 201);
  });
  app.get("/v1/me/business/quotes", async (c) => c.json(await quotes.ownerQuotes(db, await owner(c, false))));
  app.get("/v1/me/business/quotes/:quoteId", async (c) => c.json(await quotes.ownerQuote(db, await owner(c, false), c.req.param("quoteId"))));
  app.post("/v1/me/business/quotes/:quoteId/versions", async (c) => {
    const businessId = await owner(c);
    return c.json(await quotes.revise(db, businessId, c.req.param("quoteId"), await parse(c, quotes.VersionBody)), 201);
  });
  // Pix charge cards (ADR 0080) are not built: no charge can be linked yet. Bipe moves no money (ADR 0012).
  app.post("/v1/me/business/quotes/:quoteId/pix-charge", async (c) => {
    await quotes.ownerQuote(db, await owner(c), c.req.param("quoteId"));
    throw new ApiError("pix_charge_unavailable");
  });
  app.post("/v1/businesses/:handle/quotes/requests", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.quoteRequest.check(userId);
    await tools.requireLive(db, businessId, "quotes");
    return c.json(await quotes.request(db, businessId, userId), 201);
  });
  app.get("/v1/businesses/:handle/quotes/:quoteId", async (c) => {
    const userId = await mine(c);
    return c.json(await quotes.customerQuote(db, await businessOf(db, c.req.param("handle")), userId, c.req.param("quoteId")));
  });
  app.post("/v1/businesses/:handle/quotes/:quoteId/accept", async (c) => {
    const { userId, businessId } = await customer(c);
    return c.json(await quotes.accept(db, businessId, userId, c.req.param("quoteId"), await parse(c, quotes.AcceptBody)));
  });
  app.post("/v1/businesses/:handle/quotes/:quoteId/refuse", async (c) => {
    const { userId, businessId } = await customer(c);
    return c.json(await quotes.refuse(db, businessId, userId, c.req.param("quoteId"), await parse(c, quotes.DeclineBody)));
  });
  app.get("/v1/me/quotes", async (c) => c.json(await quotes.myQuotes(db, await mine(c))));

  // ---- Pedidos ----
  app.get("/v1/me/business/orders", async (c) => c.json(await orders.ownerOrders(db, await owner(c, false))));
  app.post("/v1/me/business/orders", async (c) => {
    const businessId = await owner(c);
    return c.json(await orders.ownerOrder(db, businessId, await parse(c, orders.OwnerOrderBody)), 201);
  });
  app.get("/v1/me/business/orders/policy", async (c) => c.json(await orders.policyOf(db, await owner(c, false))));
  app.put("/v1/me/business/orders/policy", async (c) => {
    const businessId = await owner(c);
    return c.json(await orders.setPolicy(db, businessId, await parse(c, orders.PolicyBody)));
  });
  app.get("/v1/me/business/orders/:orderId", async (c) => c.json(await orders.ownerGet(db, await owner(c, false), c.req.param("orderId"))));
  for (const action of ["accept", "ready", "done", "cancel"] as const) {
    app.post(`/v1/me/business/orders/:orderId/${action}`, async (c) => {
      const order = await orders.ownerTransition(db, await owner(c), c.req.param("orderId"), action);
      pushes?.customer(userIdOf(order.customer), "order_updated");
      return c.json(order);
    });
  }
  app.post("/v1/me/business/orders/:orderId/refuse", async (c) => {
    const businessId = await owner(c);
    const { reason } = await parse(c, orders.RefusalBody);
    const order = await orders.ownerTransition(db, businessId, c.req.param("orderId"), "refuse", reason);
    pushes?.customer(userIdOf(order.customer), "order_updated");
    return c.json(order);
  });
  app.post("/v1/me/business/orders/:orderId/pix-charge", async (c) => {
    await orders.ownerGet(db, await owner(c), c.req.param("orderId"));
    throw new ApiError("pix_charge_unavailable");
  });
  app.post("/v1/businesses/:handle/orders", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.order.check(userId);
    await tools.requireLive(db, businessId, "orders");
    const order = await orders.placeOrder(db, businessId, userId, await parse(c, orders.OrderBody));
    pushes?.owner(businessId, "work_new_order");
    return c.json(order, 201);
  });
  app.get("/v1/businesses/:handle/orders/:orderId", async (c) => {
    const userId = await mine(c);
    return c.json(await orders.customerGet(db, await businessOf(db, c.req.param("handle")), userId, c.req.param("orderId")));
  });
  app.post("/v1/businesses/:handle/orders/:orderId/cancel", async (c) => {
    const { userId, businessId } = await customer(c);
    return c.json(await orders.customerCancel(db, businessId, userId, c.req.param("orderId")));
  });
  app.get("/v1/me/orders", async (c) => c.json(await orders.myOrders(db, await mine(c))));

  return app;
}
