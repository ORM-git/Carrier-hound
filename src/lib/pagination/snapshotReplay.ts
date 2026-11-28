// LOCAL PREP ONLY (row 69). Capture an ordered membership once, then read it with a POSITION cursor.
// Pure: no I/O of its own, no clock, no keys, no storage. A snapshot is an ordered list of unique ids (plus optional
// owner/tier/query binding). A cursor is the offset in that list just after the last id served, never a page number.
// nextPage() reads id windows from the cursor, asks the caller's fetchEligible(ids) which of them are visible and
// eligible NOW, drops the rest, and refills from further windows until the page is full, the snapshot ends, or the
// refill bound is hit. Rows come back in snapshot order. There is deliberately no rows-only replay: every page goes
// through the eligibility callback, and rows the callback was not asked for are ignored.
// Fixture/source-compiled proof only; persistence and transport of a snapshot or cursor are not part of this module.

export interface SnapshotBinding {
  /** User id, or null for a guest. */
  owner?: string | null;
  tier?: string;
  /** Hash of the normalized query/filters the snapshot was taken for. */
  queryHash?: string;
}

export interface Snapshot {
  readonly ids: readonly string[];
  readonly limit: number;
  readonly binding?: Readonly<SnapshotBinding>;
}

/** Recommended pool bound (src/app/api/jobs/recommended/route.ts RECOMMENDED_POOL_SIZE). */
export const RECOMMENDED_POOL_LIMIT = 1000;
/** Largest page nextPage() serves; larger requests throw. */
export const MAX_PAGE_SIZE = 100;
/** Id windows one nextPage() call may read (each of pageSize ids) before it returns a short page. */
export const MAX_REFILL_WINDOWS = 8;

/** Freeze the order of already-ranked rows (the caller's real ranking, unmodified). Throws on caller bugs. */
export function captureOrder(rankedRows: ReadonlyArray<{ id: string }>, limit: number, binding?: SnapshotBinding): Snapshot {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (rankedRows.length > limit) throw new RangeError(`snapshot holds at most ${limit} rows, got ${rankedRows.length}`);
  const ids = rankedRows.map((r) => r.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("every row needs a string id");
  if (new Set(ids).size !== ids.length) throw new Error("snapshot ids must be unique");
  const snap: Snapshot = { ids: Object.freeze(ids.slice()), limit, ...(binding ? { binding: Object.freeze({ ...binding }) } : {}) };
  return Object.freeze(snap);
}

export type BindingMismatch = "owner_mismatch" | "tier_mismatch" | "query_mismatch";

/**
 * Pure data check: a snapshot taken for one owner, tier or query is rejected for another. Every field the caller
 * expects must be present on the snapshot and equal (an unbound snapshot never passes an expectation).
 */
export function verifySnapshot(s: Snapshot, expect: SnapshotBinding): { ok: true } | { ok: false; reason: BindingMismatch } {
  const b = s.binding ?? {};
  if ("owner" in expect && (!("owner" in b) || b.owner !== expect.owner)) return { ok: false, reason: "owner_mismatch" };
  if ("tier" in expect && (!("tier" in b) || b.tier !== expect.tier)) return { ok: false, reason: "tier_mismatch" };
  if ("queryHash" in expect && (!("queryHash" in b) || b.queryHash !== expect.queryHash)) return { ok: false, reason: "query_mismatch" };
  return { ok: true };
}

export type PageEnd = "filled" | "snapshot_end" | "refill_bound";

export interface PageResult<T> {
  rows: T[];
  /** Position just after the last id this call consumed; pass it back for the next page. */
  cursor: number;
  /** From the snapshot position, never from survivors: true while unread ids remain. */
  hasMore: boolean;
  /** Snapshot size (members captured), not survivors. */
  total: number;
  /** Why the page ended: full, end of snapshot, or the refill bound (then it may be short with hasMore). */
  end: PageEnd;
}

export async function nextPage<T extends { id: string }>(
  s: Snapshot,
  cursor: number,
  pageSize: number,
  fetchEligible: (ids: string[]) => Promise<readonly T[]> | readonly T[],
): Promise<PageResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new RangeError(`pageSize must be 1..${MAX_PAGE_SIZE}`);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > s.ids.length) throw new RangeError("cursor out of range");
  if (typeof fetchEligible !== "function") throw new TypeError("fetchEligible is required");
  const rows: T[] = [];
  let pos = cursor;
  let windows = 0;
  while (rows.length < pageSize && pos < s.ids.length && windows < MAX_REFILL_WINDOWS) {
    const window = s.ids.slice(pos, pos + pageSize);
    windows++;
    const wanted = new Set(window);
    const byId = new Map<string, T>();
    for (const r of await fetchEligible(window.slice())) {
      if (r && typeof r.id === "string" && wanted.has(r.id) && !byId.has(r.id)) byId.set(r.id, r); // ignore unrequested ids and duplicates
    }
    for (const id of window) {
      pos++;                                  // consumed whether served or dropped (gone/ineligible)
      const row = byId.get(id);
      if (row) {
        rows.push(row);
        if (rows.length === pageSize) break;  // the rest of this window stays unread: re-checked on the next call
      }
    }
  }
  const end: PageEnd = rows.length === pageSize ? "filled" : pos >= s.ids.length ? "snapshot_end" : "refill_bound";
  return { rows, cursor: pos, hasMore: pos < s.ids.length, total: s.ids.length, end };
}
