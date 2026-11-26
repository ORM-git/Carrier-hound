/**
 * /api/ticker modes, shared by the Next edge route and the Netlify function.
 * - "default" (no or unknown `mode`): newest by posted_at; posted_at falls back to created_at. Unchanged.
 * - "imported" (`?mode=imported`): newest imports first, by created_at DESC then id DESC.
 *   created_at is the row's DB insert time (column default now(); ingestion never writes it),
 *   returned as added_at. posted_at is the source's own date, or null when missing/invalid/future.
 */
export type TickerMode = "default" | "imported";

export const TICKER_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function parseTickerMode(value: string | null | undefined): TickerMode {
  return value === "imported" ? "imported" : "default";
}

/** ISO string for a parseable timestamp no more than the skew allowance in the future, else null. */
function validIso(raw: string | null | undefined, nowMs: number): string | null {
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  if (isNaN(ms) || ms > nowMs + TICKER_MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

export interface TickerTimes {
  posted_at: string | null;
  added_at?: string;
}

/** Timestamps for one row in the given mode, or null when the row must be dropped. */
export function tickerTimes(
  row: { posted_at?: string | null; created_at?: string | null },
  mode: TickerMode,
  nowMs: number,
): TickerTimes | null {
  if (mode === "default") {
    // Same as before: the first present value decides; an invalid posted_at does not fall back.
    const posted = validIso(row.posted_at || row.created_at, nowMs);
    return posted === null ? null : { posted_at: posted };
  }
  const added = validIso(row.created_at, nowMs);
  if (added === null) return null;
  return { posted_at: validIso(row.posted_at, nowMs), added_at: added };
}

/** Applies the mode's ordering to a PostgREST jobs query builder. */
export function orderTickerQuery<Q extends { order: (column: string, opts: object) => Q }>(query: Q, mode: TickerMode): Q {
  if (mode === "imported") {
    return query.order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false });
  }
  return query.order("posted_at", { ascending: false, nullsFirst: false });
}
