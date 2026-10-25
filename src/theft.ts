import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { MasSession } from "./mas.js";
import { theftRules } from "./registry.js";

// Theft protection (ADR 0044, ADR 0051, bipe#600, bipe#268; contract /v1/me/guardians, /v1/theft/*, /v1/theft-marks).
// A guardian marks an account: the API locks the MAS user first, then ends every active session, so a thief cannot sign
// in again in between. Accounts that reported the same phone (PUT /v1/me/phone) are covered: personal accounts get their
// own mark (root_id points at the first), a company account loses only that phone's sessions (ADR 0087, ADR 0138
// rule 6). A guardian clears the mark (unlock). Clearing by CPF is not built (MZ decision on bipe#538): staff CLI
// `theft clear`. Never log a user ID next to a guardian.

/** The MAS admin calls a mark needs. Mas implements it; tests pass a fake. */
export interface TheftMas {
  userByUsername(username: string): Promise<{ id: string } | null>;
  lockUser(masId: string): Promise<void>;
  unlockUser(masId: string): Promise<void>;
  activeSessions(masId: string): Promise<MasSession[]>;
  finishSession(session: MasSession): Promise<void>;
}

/** Signs theft statements (docs/theft-mark.md). Badges implements it. */
export interface TheftSigner {
  signTheft(userId: string, stolenAt: Date, now?: number): unknown | null;
}

type MarkRow = { id: string; user_id: string; stolen_at: Date; marked_by: string; cleared_at: Date | null };

const PHONE_ID = /^[A-Za-z0-9_-]{16,64}$/;

export class Theft {
  constructor(
    private readonly db: Db,
    private readonly mas: TheftMas,
    private readonly signer: TheftSigner,
    private readonly serverName: string,
  ) {}

  private localpart(userId: string): string | null {
    const m = /^@([^:]+):(.+)$/.exec(userId);
    return m && m[2] === this.serverName ? m[1]! : null;
  }

  private async masId(userId: string): Promise<string> {
    const local = this.localpart(userId);
    const user = local ? await this.mas.userByUsername(local) : null;
    if (!user) throw new ApiError("internal", "theft_unavailable");
    return user.id;
  }

  private static mark(r: MarkRow) {
    return {
      user_id: r.user_id,
      stolen_at: r.stolen_at.toISOString(),
      marked_by: r.marked_by,
      ...(r.cleared_at ? { cleared_at: r.cleared_at.toISOString() } : {}),
    };
  }

  private async openMark(userId: string): Promise<MarkRow | null> {
    const { rows } = await this.db.query<MarkRow>(
      "SELECT id, user_id, stolen_at, marked_by, cleared_at FROM theft_marks WHERE user_id = $1 AND cleared_at IS NULL ORDER BY stolen_at DESC LIMIT 1",
      [userId],
    );
    return rows[0] ?? null;
  }

  async isMarked(userId: string): Promise<boolean> {
    return (await this.openMark(userId)) !== null;
  }

  /** GET /v1/me/guardians. */
  async state(userId: string) {
    const { rows: guardians } = await this.db.query<{ guardian_id: string; added_at: Date }>(
      "SELECT guardian_id, added_at FROM guardians WHERE owner_id = $1 ORDER BY added_at, guardian_id",
      [userId],
    );
    const { rows: guarding } = await this.db.query<{ owner_id: string } & Partial<MarkRow>>(
      `SELECT g.owner_id, m.id, m.user_id, m.stolen_at, m.marked_by, m.cleared_at
         FROM guardians g
         LEFT JOIN LATERAL (SELECT * FROM theft_marks t WHERE t.user_id = g.owner_id AND t.cleared_at IS NULL
                            ORDER BY t.stolen_at DESC LIMIT 1) m ON true
        WHERE g.guardian_id = $1 ORDER BY g.added_at, g.owner_id`,
      [userId],
    );
    const { rows: last } = await this.db.query<MarkRow>(
      "SELECT id, user_id, stolen_at, marked_by, cleared_at FROM theft_marks WHERE user_id = $1 ORDER BY stolen_at DESC LIMIT 1",
      [userId],
    );
    return {
      guardians: guardians.map((g) => ({ user_id: g.guardian_id, added_at: g.added_at.toISOString() })),
      guarding: guarding.map((g) => ({
        user_id: g.owner_id,
        ...(g.id ? { mark: Theft.mark(g as MarkRow) } : {}),
      })),
      ...(last[0] ? { last_mark: Theft.mark(last[0]) } : {}),
    };
  }

  /** PUT /v1/me/guardians: replaces the list (0 to maxGuardians). */
  async setGuardians(userId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length > theftRules.maxGuardians) throw new ApiError("bad_request", "guardian_too_many");
    if (unique.includes(userId)) throw new ApiError("bad_request", "guardian_self");
    for (const id of unique) {
      const local = this.localpart(id);
      if (!local || !(await this.mas.userByUsername(local))) throw new ApiError("bad_request", "guardian_unknown");
    }
    if (await this.isMarked(userId)) throw new ApiError("bad_request", "guardian_marked");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7140212, hashtext($1))", [userId]);
      await client.query("DELETE FROM guardians WHERE owner_id = $1 AND NOT (guardian_id = ANY($2))", [userId, unique]);
      for (const id of unique) {
        await client.query("INSERT INTO guardians (owner_id, guardian_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return this.state(userId);
  }

  /** PUT /v1/me/phone. */
  async recordPhone(userId: string, deviceId: string | null, phoneId: string): Promise<void> {
    if (!deviceId) throw new ApiError("bad_request", "device");
    if (!PHONE_ID.test(phoneId)) throw new ApiError("bad_request", "phone_id");
    await this.db.query(
      `INSERT INTO account_phones (user_id, device_id, phone_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, device_id) DO UPDATE SET phone_id = EXCLUDED.phone_id, seen_at = now()`,
      [userId, deviceId, phoneId],
    );
  }

  private async requireGuardian(guardianId: string, ownerId: string): Promise<void> {
    const { rowCount } = await this.db.query("SELECT 1 FROM guardians WHERE owner_id = $1 AND guardian_id = $2", [ownerId, guardianId]);
    // The same answer as an unknown account: the route never tells who guards whom.
    if (!rowCount) throw new ApiError("not_found");
  }

  /** POST /v1/theft/{userId}/mark. Runs the MAS steps again when the mark is already on, so a retry finishes them. */
  async mark(guardianId: string, ownerId: string) {
    await this.requireGuardian(guardianId, ownerId);
    let root = await this.openMark(ownerId);
    if (!root) {
      const { rows } = await this.db.query<MarkRow>(
        "INSERT INTO theft_marks (user_id, marked_by) VALUES ($1, $2) RETURNING id, user_id, stolen_at, marked_by, cleared_at",
        [ownerId, guardianId],
      );
      root = rows[0]!;
    }
    // The other accounts on the owner's phones (bipe#268).
    const { rows: covered } = await this.db.query<{ user_id: string; device_id: string; company: boolean }>(
      `SELECT DISTINCT p.user_id, p.device_id, COALESCE(s.account_type = 'company', false) AS company
         FROM account_phones p LEFT JOIN signups s ON s.user_id = p.user_id
        WHERE p.phone_id IN (SELECT phone_id FROM account_phones WHERE user_id = $1) AND p.user_id <> $1`,
      [ownerId],
    );
    const personal = [...new Set(covered.filter((c) => !c.company).map((c) => c.user_id))];
    for (const userId of personal) {
      if (!(await this.openMark(userId))) {
        await this.db.query("INSERT INTO theft_marks (user_id, marked_by, root_id) VALUES ($1, $2, $3)", [userId, guardianId, root.id]);
      }
    }
    let failed = false;
    for (const userId of [ownerId, ...personal]) {
      try {
        const id = await this.masId(userId);
        await this.mas.lockUser(id);
        for (const session of await this.mas.activeSessions(id)) await this.mas.finishSession(session);
      } catch {
        failed = true;
      }
    }
    for (const company of covered.filter((c) => c.company)) {
      try {
        const id = await this.masId(company.user_id);
        for (const session of await this.mas.activeSessions(id)) {
          if (session.deviceId === company.device_id) await this.mas.finishSession(session);
        }
      } catch {
        failed = true;
      }
    }
    if (failed) {
      console.error("theft mark: a MAS step failed; the mark is on and a retry runs the steps again");
      throw new ApiError("internal", "theft_unavailable");
    }
    return Theft.mark(root);
  }

  /** POST /v1/theft/{userId}/clear by a guardian, or `byStaff` from the CLI. Unlocks the owner and the accounts it covered. */
  async clear(actorId: string, ownerId: string, byStaff = false): Promise<void> {
    if (!byStaff) await this.requireGuardian(actorId, ownerId);
    const root = await this.openMark(ownerId);
    if (!root) return;
    const { rows } = await this.db.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM theft_marks WHERE (id = $1 OR root_id = $1) AND cleared_at IS NULL",
      [root.id],
    );
    for (const row of rows) {
      await this.mas.unlockUser(await this.masId(row.user_id));
      await this.db.query("UPDATE theft_marks SET cleared_at = now(), cleared_by = $2 WHERE id = $1", [row.id, byStaff ? "staff" : actorId]);
    }
  }

  /** POST /v1/theft-marks: signed statements for the marked accounts among the IDs. */
  async statements(userIds: string[], now = Math.floor(Date.now() / 1000)) {
    const { rows } = await this.db.query<{ user_id: string; stolen_at: Date }>(
      `SELECT DISTINCT ON (user_id) user_id, stolen_at FROM theft_marks
        WHERE user_id = ANY($1) AND cleared_at IS NULL ORDER BY user_id, stolen_at DESC`,
      [[...new Set(userIds)]],
    );
    return { marks: rows.map((r) => this.signer.signTheft(r.user_id, r.stolen_at, now)).filter((e) => e !== null) };
  }

}
