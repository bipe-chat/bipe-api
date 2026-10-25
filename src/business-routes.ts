// Routes of the business tools (contract: bipe-shared api/openapi.yaml, tags Catálogo and Agenda).
// Owner routes (/v1/me/business/...) need the company account's own token. Customer routes
// (/v1/businesses/{handle}/...) take the business handle or its Matrix ID; reads are public, writes need a token.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import * as agenda from "./agenda.js";
import type { MatrixAuth } from "./auth.js";
import { businessOf, requireCompany } from "./business-common.js";
import * as catalog from "./catalog.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { RateLimiter } from "./ratelimit.js";

export type BusinessDeps = {
  db: Db;
  auth: MatrixAuth;
  apiUrl: string;
  siteUrl: string;
  clientIp: (c: Context) => string;
};

export const CATALOG_PHOTO_PATH = /^\/v1\/me\/business\/catalog\/items\/[^/]+\/photo$/;

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

export function businessRoutes({ db, auth, apiUrl, siteUrl, clientIp }: BusinessDeps): Hono {
  const app = new Hono();
  const limits = {
    ownerWrite: new RateLimiter(600, 3_600_000),
    photo: new RateLimiter(60, 3_600_000),
    publicRead: new RateLimiter(120, 60_000),
    publicPhoto: new RateLimiter(240, 60_000),
    hold: new RateLimiter(20, 3_600_000),
    customerWrite: new RateLimiter(60, 3_600_000),
    mine: new RateLimiter(120, 60_000),
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
  const origin = siteUrl.replace(/\/$/, "");
  app.use("/v1/businesses/*", cors({ origin, allowMethods: ["GET", "POST"], allowHeaders: ["authorization", "content-type"] }));

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
  app.get("/v1/businesses/:handle/catalog", async (c) => c.json(await catalog.publicCatalog(db, apiUrl, await publicBusiness(c))));
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
    return c.json(await agenda.ownerMove(db, businessId, c.req.param("bookingId"), await parse(c, agenda.MoveBody)));
  });
  for (const action of ["cancel", "no-show", "accept", "refuse"] as const) {
    app.post(`/v1/me/business/agenda/bookings/:bookingId/${action}`, async (c) =>
      c.json(await agenda.ownerAction(db, await owner(c), c.req.param("bookingId"), action)));
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
    return c.json(await agenda.confirm(db, businessId, userId, c.req.param("bookingId")));
  });
  app.post("/v1/businesses/:handle/agenda/bookings/:bookingId/cancel", async (c) => {
    const { userId, businessId } = await customer(c);
    return c.json(await agenda.customerCancel(db, businessId, userId, c.req.param("bookingId")));
  });
  app.post("/v1/businesses/:handle/agenda/bookings/:bookingId/move", async (c) => {
    const { userId, businessId } = await customer(c);
    limits.hold.check(userId);
    return c.json(await agenda.customerMove(db, businessId, userId, c.req.param("bookingId"), await parse(c, agenda.MoveBody)));
  });
  app.get("/v1/me/bookings", async (c) => {
    const userId = await auth.userId(c.req.header("authorization"));
    limits.mine.check(userId);
    c.header("cache-control", "no-store");
    return c.json(await agenda.myBookings(db, userId));
  });

  return app;
}
