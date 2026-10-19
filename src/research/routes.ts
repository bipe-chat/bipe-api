import { Hono } from "hono";
import type { StaffGate } from "../auth.js";
import { loadMessagingResearch } from "./load.js";

export function researchRoutes(staff: Pick<StaffGate, "userId">, load = loadMessagingResearch) {
  return new Hono().get("/messaging", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Authorization", { append: true });
    await staff.userId(c.req.header("authorization"));
    return c.json(await load());
  });
}
