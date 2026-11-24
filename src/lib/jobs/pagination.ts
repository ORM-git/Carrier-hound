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
