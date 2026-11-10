// Site header, footer and head links for the pages this service renders on bipe.chat (public feed, ADR 0280).
// bipe-web writes them to <site>/site-chrome.json at each site build (scripts/build.mjs). This service fetches the
// file, keeps it for TTL_MS, and keeps the last good copy when a fetch fails. With no copy, the pages use their own
// standalone style: a site outage never breaks a feed page.
import { z } from "zod";

const TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_FIELD = 200_000;

const ChromeFile = z.object({
  v: z.literal(1),
  head: z.string().max(MAX_FIELD),
  before: z.string().min(1).max(MAX_FIELD),
  after: z.string().min(1).max(MAX_FIELD),
  companySeal: z.string().max(10_000),
});
export type SiteChrome = z.infer<typeof ChromeFile>;

export class SiteChromeCache {
  private value: SiteChrome | null = null;
  private fetchedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly siteUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** The chrome, or null when no fetch has worked yet. Never throws. */
  async get(): Promise<SiteChrome | null> {
    if (Date.now() - this.fetchedAt >= TTL_MS) {
      this.pending ??= this.refresh().finally(() => {
        this.pending = null;
      });
      // The first request waits for the fetch. Later ones get the last copy while the refresh runs.
      if (!this.value) await this.pending;
    }
    return this.value;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(`${this.siteUrl.replace(/\/$/, "")}/site-chrome.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      this.value = ChromeFile.parse(await res.json());
    } catch (err) {
      console.warn(`site chrome: fetch failed, ${this.value ? "keeping last copy" : "using standalone pages"}: ${(err as Error).message}`);
    } finally {
      // A failed fetch waits for the next TTL too, so a site outage costs one fetch per TTL, not one per request.
      this.fetchedAt = Date.now();
    }
  }
}
