import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { MessagingResearch } from "../generated/internal-research.js";

// Content is operator-managed private data, mounted from a Kubernetes Secret. Never bundle it
// into this public repository, the image, or the public website.
const document = z.object({
  version: z.number().int().positive(), reviewed: z.iso.date(), reviewAfter: z.iso.date(),
  title: z.string(), summary: z.string(), methodology: z.array(z.string()),
  groups: z.array(z.object({ id: z.string(), title: z.string(), question: z.string() })),
  platforms: z.array(z.object({ id: z.string() }).passthrough()),
  strategy: z.array(z.object({}).passthrough()), priorities: z.array(z.object({}).passthrough()),
  watchlist: z.array(z.object({}).passthrough()), sources: z.array(z.object({}).passthrough()),
  features: z.array(z.object({}).passthrough()), snapshot: z.object({}).passthrough(),
});

export async function loadMessagingResearch(path = process.env.BIPE_RESEARCH_FILE ?? "/run/bipe-research/messaging.json"): Promise<MessagingResearch> {
  // Validation errors deliberately contain no document values in logs.
  try {
    const data = document.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!data.success) throw new Error("invalid research");
    return data.data as MessagingResearch;
  } catch {
    throw new Error("Internal research is unavailable");
  }
}
