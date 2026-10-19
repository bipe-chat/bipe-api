import type { Db } from "./db.js";

// Organisation requests from the site's organisation form (ADR 0126, bipe#410; was the partner form,
// ADR 0067, bipe#177). Since bipe#273 the form posts to the Bipe workspace on Starlings, and the API
// takes no new requests. The rows already stored stay on the server in Brazil until they age out
// after ORGANISATION_KEEP_DAYS or are deleted on request. Never log a request field.

export const ORGANISATION_KEEP_DAYS = 365;

export async function pruneOrganisationRequests(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM organisation_requests WHERE created_at <= now() - make_interval(days => $1)", [ORGANISATION_KEEP_DAYS]);
  return rowCount ?? 0;
}
