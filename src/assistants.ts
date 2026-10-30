// Assistants as chat members (bipe ADR 0210 point 1, bipe#867; registries/assistants.json). Any AI provider can run an
// assistant as a Bipe account. Staff register it (CLI `assistant add`) with its operator, a company account with a
// verified CNPJ claim, and the model location the operator declares. The apps and the site read the facts and label
// the account. The operator's name comes from its seal at read time: an operator that lost its seal shows as not
// verified, and the label stays.
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { assistantRules } from "./registry.js";

export type ModelLocation = "brasil" | "fora" | "desconhecido";
export type OperatorCheck = (userId: string) => Promise<{ name: string; cnpj: string } | null>;
export type AssistantFacts = { user_id: string; operator_verified: boolean; operator_name: string | null; model_location: ModelLocation };

const USER_ID = /^@[^:\s]{1,255}:[^\s]{1,255}$/;

export function isModelLocation(v: string): v is ModelLocation {
  return (assistantRules.modelLocations as string[]).includes(v);
}

/** Staff: registers an assistant account. The operator must hold a verified seal now. */
export async function addAssistant(db: Db, operatorCheck: OperatorCheck, userId: string, operatorUserId: string, location: string) {
  if (!USER_ID.test(userId) || !USER_ID.test(operatorUserId)) throw new Error("both must be Matrix user IDs");
  if (userId === operatorUserId) throw new Error("an assistant cannot be its own operator");
  if (!isModelLocation(location)) throw new Error(`model location must be one of ${assistantRules.modelLocations.join(", ")}`);
  if (!(await operatorCheck(operatorUserId))) throw new Error(`${operatorUserId} has no verified CNPJ seal (ADR 0042)`);
  await db.query(
    `INSERT INTO assistant_accounts (user_id, operator_user_id, model_location) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET operator_user_id = $2, model_location = $3, registered_at = now(), ended_at = NULL`,
    [userId, operatorUserId, location],
  );
}

/** Staff: ends a registration. The account stays; it is no longer labelled as an assistant. */
export async function endAssistant(db: Db, userId: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE assistant_accounts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL", [userId]);
  return (rowCount ?? 0) > 0;
}

export async function listAssistants(db: Db) {
  const { rows } = await db.query<{ user_id: string; operator_user_id: string; model_location: string; registered_at: Date }>(
    "SELECT user_id, operator_user_id, model_location, registered_at FROM assistant_accounts WHERE ended_at IS NULL ORDER BY registered_at",
  );
  return rows;
}

/** The facts of the registered assistants among userIds. IDs that are not registered are left out. */
export async function assistantFacts(db: Db, operatorCheck: OperatorCheck, userIds: string[]): Promise<AssistantFacts[]> {
  const ids = [...new Set(userIds.filter((id) => USER_ID.test(id)))];
  if (!ids.length) return [];
  const { rows } = await db.query<{ user_id: string; operator_user_id: string; model_location: ModelLocation }>(
    "SELECT user_id, operator_user_id, model_location FROM assistant_accounts WHERE user_id = ANY($1) AND ended_at IS NULL ORDER BY user_id",
    [ids],
  );
  const out: AssistantFacts[] = [];
  for (const r of rows) {
    const operator = await operatorCheck(r.operator_user_id).catch(() => null);
    out.push({ user_id: r.user_id, operator_verified: operator !== null, operator_name: operator?.name ?? null, model_location: r.model_location });
  }
  return out;
}

export async function oneAssistant(db: Db, operatorCheck: OperatorCheck, userId: string): Promise<AssistantFacts> {
  const [facts] = await assistantFacts(db, operatorCheck, [userId]);
  if (!facts) throw new ApiError("not_found");
  return facts;
}
