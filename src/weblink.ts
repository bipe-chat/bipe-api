import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { Reader, type CityResponse } from "mmdb-lib";
import { ApiError } from "./errors.js";
import type { Mas } from "./mas.js";

// Web sign-in approval on the phone (ADR 0118 in bipe/docs/adr, bipe#389).

const SINCE_MAX_AGE_MS = 15 * 60_000;
const SINCE_MAX_AHEAD_MS = 2 * 60_000;
const SINCE_SLACK_MS = 60_000;

/**
 * Finishes the MAS browser sessions of the caller that started at or after `since` minus 60 s: the
 * session that the phone's private web view made with the form fill. Older sessions stay, so a staff
 * browser session is not touched. Returns the number finished.
 */
export async function finishWebLink(mas: Mas, userId: string, since: string): Promise<number> {
  const start = Date.parse(since);
  const now = Date.now();
  if (Number.isNaN(start) || start < now - SINCE_MAX_AGE_MS || start > now + SINCE_MAX_AHEAD_MS) throw new ApiError("bad_request", "since");
  const user = await mas.userByUsername(userId.slice(1).split(":")[0]!);
  if (!user) throw new ApiError("unauthorized");
  const ids = await mas.activeBrowserSessionsSince(user.id, new Date(start - SINCE_SLACK_MS));
  for (const id of ids) await mas.finishBrowserSession(id);
  return ids.length;
}

export type Place = { city?: string; region?: string; country?: string };

/**
 * GeoIP city lookup from a database file on the server (DB-IP "IP to City Lite", CC BY 4.0; bipe-infra
 * k8s/bipe/geoip.yaml). The IP goes to no outside service and is never logged. The file is read again
 * when its modification time changes (monthly update job).
 */
export class Geo {
  private reader?: Reader<CityResponse>;
  private mtimeMs = 0;
  private checkedAt = 0;

  constructor(private readonly path: string | undefined) {
    this.reload();
  }

  get enabled(): boolean {
    return this.reader !== undefined;
  }

  place(ip: string): Place {
    if (isIP(ip) === 0) throw new ApiError("bad_request", "ip");
    if (Date.now() - this.checkedAt > 3_600_000) this.reload();
    const r = this.reader?.get(ip);
    if (!r) return {};
    const name = (n?: Record<string, string>) => n?.["pt-BR"] ?? n?.en;
    const place: Place = {};
    const city = name(r.city?.names as Record<string, string> | undefined);
    const region = name(r.subdivisions?.[0]?.names as Record<string, string> | undefined);
    const country = r.country?.iso_code;
    if (city) place.city = city;
    if (region) place.region = region;
    if (country) place.country = country;
    return place;
  }

  private reload(): void {
    this.checkedAt = Date.now();
    if (!this.path) return;
    try {
      const mtimeMs = statSync(this.path).mtimeMs;
      if (this.reader && mtimeMs === this.mtimeMs) return;
      this.reader = new Reader<CityResponse>(readFileSync(this.path));
      this.mtimeMs = mtimeMs;
      console.log(`geoip: loaded (${new Date(this.reader.metadata.buildEpoch).toISOString().slice(0, 10)})`);
    } catch (e) {
      // Keep the old reader when the new file cannot be read (for example during the update).
      if (!this.reader) console.error(`geoip: not loaded (${(e as NodeJS.ErrnoException).code ?? "read failed"})`);
    }
  }
}
