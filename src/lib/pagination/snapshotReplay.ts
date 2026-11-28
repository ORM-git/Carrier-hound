// LOCAL PREP ONLY (row 69). Capture an ordered membership once, then read it with a POSITION cursor.
// Pure: no I/O of its own, no clock, no keys, no storage. A snapshot is an ordered list of unique ids plus the binding
// (owner, tier, queryHash) it was captured for. A cursor is the offset in that list just after the last id consumed,
// never a page number.
//
// nextPage() is the ONLY way to page, and it enforces the binding first: the caller must state the full expectation
// (owner = a verified user id, or a server-verified guest-session id such as "guest:<id>"; tier; queryHash; none empty),
// the snapshot must carry the same full
// binding, and every part must be equal. Missing/empty parts or an unbound snapshot throw (SnapshotBindingError).
// There is no fail-open path: no paging function without the check is exported.
//
// Reading: nextPage() reads id windows from the cursor, asks the caller's fetchEligible(ids) which of them are visible
// and eligible NOW, drops the rest, and refills from further windows until the page is full, the snapshot ends, or the
// refill bound is hit. Rows come back in snapshot order; rows the callback was not asked for are ignored.
// Consumed-ineligible semantics: an id that is gone or ineligible when a page reads it is CONSUMED (the cursor moves past
// it) and is never revisited, even if it becomes eligible again later in the same snapshot. Ids after the last served
// row of a window are NOT consumed: they stay unread and are re-checked by the next call.
// fetchEligible must apply the same current visibility and entitlement rules as a first page; this module cannot prove
// that, it only guarantees it never returns a row the callback did not return for a requested id.
// Fixture/source-compiled proof only; persistence and transport of a snapshot or cursor are not part of this module.

/**
 * What a snapshot is bound to. All three parts are required. owner is a verified user id, or a server-verified
 * guest-SESSION id (e.g. "guest:<id>"). The bare literal "guest" is refused everywhere: it would be one owner shared
 * by every guest, so any guest could page any other guest's snapshot. A guest without a verified session id must get
 * stabilityFallback.liveFallback instead of a snapshot.
 */
export interface SnapshotBinding {
  owner: string;
  tier: string;
  /** Hash of the normalized query/filters the snapshot was taken for. */
  queryHash: string;
}

export interface Snapshot {
  readonly ids: readonly string[];
  readonly limit: number;
  /** Absent for a snapshot captured without a binding: such a snapshot can never be paged. */
  readonly binding?: Readonly<SnapshotBinding>;
}

/** Recommended pool bound (src/app/api/jobs/recommended/route.ts RECOMMENDED_POOL_SIZE). */
export const RECOMMENDED_POOL_LIMIT = 1000;
/** Largest page nextPage() serves; larger requests throw. */
export const MAX_PAGE_SIZE = 100;
/** Id windows one nextPage() call may read (each of pageSize ids) before it returns a short page. */
export const MAX_REFILL_WINDOWS = 8;

export type BindingFailure = "invalid_expectation" | "shared_guest_owner" | "unbound_snapshot" | "owner_mismatch" | "tier_mismatch" | "query_mismatch";

export class SnapshotBindingError extends Error {
  constructor(readonly reason: BindingFailure) {
    super(`snapshot binding rejected: ${reason}`);
    this.name = "SnapshotBindingError";
  }
}

const isPart = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/** The shared-guest literal ("guest", any case/spacing) or an empty "guest:" prefix: never a valid owner. */
const isSharedGuest = (v: unknown): boolean => typeof v === "string" && /^\s*guest\s*(:\s*)?$/i.test(v);
const isFullBinding = (b: unknown): b is SnapshotBinding =>
  !!b && typeof b === "object" && isPart((b as SnapshotBinding).owner) && isPart((b as SnapshotBinding).tier) && isPart((b as SnapshotBinding).queryHash);

/** Freeze the order of already-ranked rows (the caller's real ranking, unmodified). Throws on caller bugs. */
export function captureOrder(rankedRows: ReadonlyArray<{ id: string }>, limit: number, binding?: SnapshotBinding): Snapshot {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (rankedRows.length > limit) throw new RangeError(`snapshot holds at most ${limit} rows, got ${rankedRows.length}`);
  const ids = rankedRows.map((r) => r.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("every row needs a string id");
  if (new Set(ids).size !== ids.length) throw new Error("snapshot ids must be unique");
  if (binding !== undefined && isSharedGuest(binding.owner)) throw new SnapshotBindingError("shared_guest_owner");
  if (binding !== undefined && !isFullBinding(binding)) throw new SnapshotBindingError("invalid_expectation");
  const snap: Snapshot = { ids: Object.freeze(ids.slice()), limit, ...(binding ? { binding: Object.freeze({ owner: binding.owner, tier: binding.tier, queryHash: binding.queryHash }) } : {}) };
  return Object.freeze(snap);
}

/**
 * Pure data check, the same one nextPage() enforces: the expectation must be complete (owner, tier, queryHash, none
 * empty), the snapshot must carry a complete binding, and all three parts must be equal.
 */
export function verifySnapshot(s: Snapshot, expect: SnapshotBinding): { ok: true } | { ok: false; reason: BindingFailure } {
  if (expect && typeof expect === "object" && isSharedGuest(expect.owner)) return { ok: false, reason: "shared_guest_owner" };
  if (!isFullBinding(expect)) return { ok: false, reason: "invalid_expectation" };
  const b = s.binding;
  if (!isFullBinding(b) || isSharedGuest(b.owner)) return { ok: false, reason: "unbound_snapshot" };
  if (b.owner !== expect.owner) return { ok: false, reason: "owner_mismatch" };
  if (b.tier !== expect.tier) return { ok: false, reason: "tier_mismatch" };
  if (b.queryHash !== expect.queryHash) return { ok: false, reason: "query_mismatch" };
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

/** The only paging entry point. Throws SnapshotBindingError unless `expect` fully matches the snapshot's binding. */
export async function nextPage<T extends { id: string }>(
  s: Snapshot,
  expect: SnapshotBinding,
  cursor: number,
  pageSize: number,
  fetchEligible: (ids: string[]) => Promise<readonly T[]> | readonly T[],
): Promise<PageResult<T>> {
  const bound = verifySnapshot(s, expect);
  if (!bound.ok) throw new SnapshotBindingError(bound.reason);
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
