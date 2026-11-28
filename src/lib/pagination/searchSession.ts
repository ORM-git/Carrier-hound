/**
 * Search listings use the same stable browsing session as the recommended feed (row 69, feedSession.ts).
 *
 * A keyset cursor cannot give stable membership for search: verified and posted_at are mutable, so a row whose key
 * changes between pages crosses the cursor and is skipped or repeated, and an arrival-time fence does not help with
 * that (both shown in the tests). Instead, page 1 fixes the ordered membership:
 *   SELECT id ... WHERE <every search filter + eligibility> ORDER BY searchOrder(sort) LIMIT SEARCH_MEMBERSHIP_LIMIT + 1
 * The first SEARCH_MEMBERSHIP_LIMIT ids open a session (moreBeyondCap when the extra row exists); later pages serve
 * survivors of their own ids only, in that order, whatever happens to verified/posted_at meanwhile.
 *
 * The order is total (every key NULLS LAST, id last):
 *   newest: posted_at DESC, id DESC
 *   match:  verified DESC (true > false > null), posted_at DESC, id DESC
 * Today's route orders verified with Postgres's DESC default (NULLS FIRST); whether to change that is an open owner
 * decision. searchOrder() is the proposal.
 */

import { MAX_MEMBERS } from "./feedSession";

export type SearchSort = "newest" | "match";
/** Rows one search session can hold. Beyond it the session ends explicitly (capped). Open owner decision. */
export const SEARCH_MEMBERSHIP_LIMIT = MAX_MEMBERS;

export interface SortKey {
  verified: boolean | null;
  posted_at: string | null;
  id: string;
}

/** Order for PostgREST `.order()` calls, in sequence. Every key is NULLS LAST, so the order is total with id. */
export function searchOrder(sort: SearchSort): Array<{ column: "verified" | "posted_at" | "id"; ascending: false; nullsFirst: false }> {
  const keys = sort === "match" ? (["verified", "posted_at", "id"] as const) : (["posted_at", "id"] as const);
  return keys.map((column) => ({ column, ascending: false, nullsFirst: false }));
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * An ISO timestamp as [whole-second epoch ms, microseconds], so ordering keeps PostgreSQL timestamptz precision
 * (microseconds; Date.parse alone keeps milliseconds). Accepts at most 6 fractional digits: PostgreSQL output never has
 * more, and an input with more would be rounded by PostgreSQL in a way this does not model, so it is rejected.
 */
export function timestampKey(value: string): [number, number] {
  const m = TS.exec(value);
  if (!m) throw new RangeError(`not an ISO timestamp with <= 6 fractional digits: ${value}`);
  const offset = m[3] === "Z" ? "Z" : m[3].length === 3 ? `${m[3]}:00` : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const seconds = Date.parse(`${m[1]}${offset}`);
  if (Number.isNaN(seconds)) throw new RangeError(`not a valid timestamp: ${value}`);
  return [seconds, Number((m[2] ?? "").padEnd(6, "0"))];
}

/** Reference comparator for searchOrder(sort) (negative = a first), at PostgreSQL microsecond precision. */
export function compareSortKeys(a: SortKey, b: SortKey, sort: SearchSort): number {
  if (sort === "match") {
    const rank = (v: boolean | null) => (v === true ? 0 : v === false ? 1 : 2);
    if (rank(a.verified) !== rank(b.verified)) return rank(a.verified) - rank(b.verified);
  }
  if (a.posted_at !== b.posted_at) {
    if (a.posted_at === null) return 1;
    if (b.posted_at === null) return -1;
    const [as, aus] = timestampKey(a.posted_at);
    const [bs, bus] = timestampKey(b.posted_at);
    if (as !== bs) return bs - as;
    if (aus !== bus) return bus - aus;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
