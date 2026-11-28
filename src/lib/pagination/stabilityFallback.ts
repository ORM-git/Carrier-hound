// LOCAL PREP ONLY (row 69). When no snapshot can be captured (capture unavailable, rejected, or not wired on a host),
// the listing falls back to its CURRENT behaviour and says so: the result is explicitly marked not stable. A
// fallback never claims stability. Snapshot-served pages are the only results that may say `stable: true`.

export type ListingPage<T> =
  | { kind: "snapshot"; stable: true; rows: T[] }
  | { kind: "live"; stable: false; reason: FallbackReason; rows: T[] };

export type FallbackReason = "capture_unavailable" | "capture_rejected" | "host_not_wired";

export const UNSTABLE_NOTICE = "order is not stable across pages: rows may repeat or be skipped if jobs change";

/** Current behaviour, unchanged rows, explicitly unstable. */
export function liveFallback<T>(currentRows: T[], reason: FallbackReason): ListingPage<T> & { notice: string } {
  return { kind: "live", stable: false, reason, rows: currentRows, notice: UNSTABLE_NOTICE };
}

/** A snapshot-served page (from snapshotReplay.replayPage). */
export function snapshotPage<T>(rows: T[]): ListingPage<T> {
  return { kind: "snapshot", stable: true, rows };
}

/** True only for snapshot-served pages; use this, never a caller-set flag, to decide whether to promise stability. */
export function isStable<T>(p: ListingPage<T>): boolean {
  return p.kind === "snapshot" && p.stable === true;
}
