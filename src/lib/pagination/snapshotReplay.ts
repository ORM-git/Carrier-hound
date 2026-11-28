// LOCAL PREP ONLY (row 69). Capture an ordered membership once, then serve every page by id from that snapshot.
// Pure: no I/O, no clock, no tokens. A snapshot is an ordered list of unique ids; page N is the N-th window of it,
// keeping only members that are still present and eligible NOW (caller passes current rows); nothing outside the
// snapshot is ever returned and no member moves. Used for the multiword 200-row relevance list and the recommended
// 1000-row pool. Fixture proof only; persistence/transport of the snapshot is not part of this module.

export interface Snapshot {
  readonly ids: readonly string[];
  readonly limit: number;
}

/** Freeze the order of already-ranked rows (the caller's real ranking, unmodified). Throws on caller bugs. */
export function captureOrder(rankedRows: ReadonlyArray<{ id: string }>, limit: number): Snapshot {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (rankedRows.length > limit) throw new RangeError(`snapshot holds at most ${limit} rows, got ${rankedRows.length}`);
  const ids = rankedRows.map((r) => r.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("every row needs a string id");
  if (new Set(ids).size !== ids.length) throw new Error("snapshot ids must be unique");
  return Object.freeze({ ids: Object.freeze(ids.slice()), limit });
}

export function pageCount(s: Snapshot, pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
  return Math.max(1, Math.ceil(s.ids.length / pageSize));
}

/**
 * Page `page` (1-based) of the snapshot: the members in that window, in snapshot order, that appear in `currentRows`
 * (the caller's current, already-eligibility-filtered rows for exactly those ids). Out-of-range pages are empty.
 */
export function replayPage<T extends { id: string }>(s: Snapshot, page: number, pageSize: number, currentRows: readonly T[]): T[] {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer");
  pageCount(s, pageSize);
  const window = s.ids.slice((page - 1) * pageSize, page * pageSize);
  const byId = new Map<string, T>();
  for (const r of currentRows) if (!byId.has(r.id)) byId.set(r.id, r);
  const out: T[] = [];
  for (const id of window) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

/** Ids a page needs loaded (the window), so the caller can fetch `id IN (...)` under current eligibility. */
export function pageIds(s: Snapshot, page: number, pageSize: number): string[] {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer");
  pageCount(s, pageSize);
  return s.ids.slice((page - 1) * pageSize, page * pageSize);
}

/** Recommended pool bound (src/app/api/jobs/recommended/route.ts RECOMMENDED_POOL_SIZE). */
export const RECOMMENDED_POOL_LIMIT = 1000;
