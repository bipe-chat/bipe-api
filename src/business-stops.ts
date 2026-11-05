// Parar de receber (ADR 0237, bipe#1013; contract: bipe-shared api/openapi.yaml). A customer stops a work account in one
// tap. A stopped work account cannot start a chat with that person: mayInvite refuses the invite. In a chat that exists,
// the Synapse module asks mayMessage before a stopped work account sends. bipe-api never sees message content: the
// rule uses only the customer's last message time and the open records.
import { requireCompany, type Queryable } from "./business-common.js";

export async function isStopped(db: Queryable, customerId: string, businessId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM business_stops WHERE customer_id = $1 AND business_id = $2", [customerId, businessId]);
  return (rowCount ?? 0) > 0;
}

export async function setStopped(db: Queryable, customerId: string, businessId: string, stopped: boolean): Promise<{ stopped: boolean }> {
  await requireCompany(db, businessId);
  if (stopped) {
    await db.query("INSERT INTO business_stops (customer_id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [customerId, businessId]);
  } else {
    await db.query("DELETE FROM business_stops WHERE customer_id = $1 AND business_id = $2", [customerId, businessId]);
  }
  return { stopped };
}

/** ADR 0237: a reply within this time of the customer's last message is not a promotion. */
export const REPLY_WINDOW_MS = 24 * 3_600_000;

/** Work accounts with at least one stop. The module asks about a send only for these. */
export async function stoppedBusinesses(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ business_id: string }>("SELECT DISTINCT business_id FROM business_stops");
  return rows.map((r) => r.business_id);
}

/**
 * ADR 0237: whether a stopped work account may send in its DM with this customer. It may reply within the window after
 * the customer's last message, and write while a booking, order, queue place or quote is open. Any other message counts
 * as a promotion. A customer who did not stop this account is never refused.
 */
export async function mayMessage(db: Queryable, businessId: string, customerId: string, customerLastMs: number | null, now = Date.now()): Promise<boolean> {
  if (!(await isStopped(db, customerId, businessId))) return true;
  if (customerLastMs !== null && now - customerLastMs < REPLY_WINDOW_MS) return true;
  const { rows } = await db.query<{ open: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM bookings WHERE business_id = $1 AND customer_id = $2 AND status IN ('held', 'requested', 'confirmed') AND end_at > now())
         OR EXISTS (SELECT 1 FROM orders WHERE business_id = $1 AND customer_id = $2 AND status IN ('sent', 'accepted', 'ready'))
         OR EXISTS (SELECT 1 FROM queue_places WHERE business_id = $1 AND customer_id = $2 AND status IN ('waiting', 'called'))
         OR EXISTS (SELECT 1 FROM quotes WHERE business_id = $1 AND customer_id = $2 AND status = 'offered') AS open`,
    [businessId, customerId],
  );
  return rows[0]!.open;
}
