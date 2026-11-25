/**
 * Next-page loading for the jobs feed (CM mobile item 21), kept out of the page so it can be tested directly.
 */

/** Appends a page in server order, skipping ids already shown and repeats inside the incoming page itself. */
export function appendPage<T extends { id: string }>(prev: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(prev.map((j) => j.id));
  const out = [...prev];
  for (const job of incoming) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
  }
  return out;
}

export type PageLoadOutcome = "applied" | "busy" | "stale" | "error";

/**
 * One request at a time. reset() (list query changed) aborts the in-flight request and makes any late
 * response stale, so it is never applied.
 */
export function createNextPageLoader<R>() {
  let inFlight: AbortController | null = null;
  let generation = 0;
  return {
    get busy() {
      return inFlight !== null;
    },
    reset() {
      inFlight?.abort();
      inFlight = null;
      generation++;
    },
    async load(run: (signal: AbortSignal) => Promise<R>, apply: (result: R) => void): Promise<PageLoadOutcome> {
      if (inFlight) return "busy";
      const controller = new AbortController();
      const gen = generation;
      inFlight = controller;
      try {
        const result = await run(controller.signal);
        if (controller.signal.aborted || gen !== generation) return "stale";
        apply(result);
        return "applied";
      } catch {
        return controller.signal.aborted || gen !== generation ? "stale" : "error";
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
  };
}

/** Jobs per feed request. */
export const FEED_PAGE_SIZE = 25;

/** Pages warmed behind page 1, and fetched per refill once the reader moves down the feed. */
export const PREFETCH_PAGES = 3;

/**
 * Bounded look-ahead. Called when the reader reaches rendered page `reached`; returns the last page to
 * fetch, or null while PREFETCH_PAGES or more pages are already loaded past it. At most
 * 2 * PREFETCH_PAGES - 1 pages are ever ahead of the reader, and nothing is fetched without a crossing.
 */
export function refillTarget(loaded: number, reached: number): number | null {
  return loaded - reached < PREFETCH_PAGES ? loaded + PREFETCH_PAGES : null;
}

/**
 * True when a continuation cannot make progress: the server repeated a cursor (`sent` or one already
 * consumed), or dropped the cursor of a cursor-paged stream while still reporting more. Page-numbered
 * streams (no cursor sent, none returned) always progress.
 */
export function isStalledCursor(
  sent: string | null,
  res: { hasNextPage?: boolean; nextCursor?: string | null },
  seen: ReadonlySet<string>
): boolean {
  if (!res.hasNextPage) return false;
  if (res.nextCursor) return res.nextCursor === sent || seen.has(res.nextCursor);
  return sent !== null;
}
