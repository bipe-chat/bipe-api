// Parar de receber (ADR 0237, bipe#1013; contract: bipe-shared api/openapi.yaml). A customer stops a work account in one
// tap. A stopped work account cannot start a chat with that person: mayInvite refuses the invite. A chat that exists
// stays, because bipe-api never sees message content.
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
