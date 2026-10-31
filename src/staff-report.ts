// Rules for aggregate staff reports (bipe#371). A count below MIN_CELL can point to a person,
// so staff routes never return one: they fold small rows together or return null.
import type { GrowthNumbers } from "./growth.js";

export const MIN_CELL = 3;

/** The count, or null when it is 1 or 2. Zero stays zero: it points to nobody. */
export const cell = (n: number): number | null => (n > 0 && n < MIN_CELL ? null : n);

/** Growth numbers for /v1/admin/growth: small weeks hide everything but their week, small counts become null. */
export function staffGrowth(g: GrowthNumbers, since: string) {
  return {
    since,
    min_cell: MIN_CELL,
    funnel: g.funnel.map((f) => ({ step: f.step, users: cell(f.users) })),
    retention: g.retention.map((w) => w.signups < MIN_CELL
      ? { week: w.week, signups: null, days: [] }
      : { week: w.week, signups: w.signups, days: w.days.map((d) => ({ day: d.day, kept: cell(d.kept), due: d.due })) }),
    totals: g.totals.map((t) => ({ event: t.event, users: cell(t.users), count: t.users < MIN_CELL ? null : t.count })),
    // bipe-chat/bipe#752. A quantile over fewer than MIN_CELL people who reached it can point to a person.
    contacts: g.contacts.map((w) => w.signups < MIN_CELL
      ? { week: w.week, signups: null, reached: null, median_days: null, p75_days: null, invites_accepted_per_member: null }
      : {
          week: w.week,
          signups: w.signups,
          reached: cell(w.reached),
          median_days: w.reached < MIN_CELL ? null : w.medianDays,
          p75_days: w.reached < MIN_CELL ? null : w.p75Days,
          invites_accepted_per_member: w.invitesAcceptedPerMember,
        }),
  };
}
