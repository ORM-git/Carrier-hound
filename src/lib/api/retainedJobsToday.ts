/**
 * Retained job records created today (IST), counted on raw public.jobs.
 *
 * Window: current IST midnight (inclusive) up to the query start (exclusive). NO is_active, status or
 * source filter: this is the same metric as the owner-run 24 Nov (4,530) and 25 Nov (965) counts. It counts
 * rows, not unique vacancies; archived/deleted rows are not included. Only the number leaves the server.
 *
 * Load bounds: one in-flight count per runtime instance (concurrent callers share it), a hard server
 * deadline that also aborts the request, and no caching of failures. Edge caching (s-maxage) is separate.
 * These bound work per instance; they are not a global DB cap.
 */
export const RETAINED_COUNT_DEADLINE_MS = 4_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface RetainedCountResult {
  count: number | null;
  /** UTC ISO instant the query window ended (query start). */
  asOf: string;
  ok: boolean;
}

/** IST midnight (UTC instant) of the IST day containing `now`. */
export function istMidnightOf(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

let inflight: { key: string; promise: Promise<RetainedCountResult> } | null = null;

export function __resetRetainedCountForTests() {
  inflight = null;
}

export function countRetainedJobsToday(supabase: any, now: Date = new Date()): Promise<RetainedCountResult> {
  const midnight = istMidnightOf(now);
  const key = midnight.toISOString();
  // Coalesce only within the same IST day, so a count started before midnight is never shared after it.
  if (inflight && inflight.key === key) return inflight.promise;

  const asOf = now.toISOString();
  const run = async (): Promise<RetainedCountResult> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      let query = supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .gte("created_at", midnight.toISOString())
        .lt("created_at", asOf);
      if (typeof query.abortSignal === "function") query = query.abortSignal(controller.signal);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("retained count deadline exceeded"));
        }, RETAINED_COUNT_DEADLINE_MS);
      });
      const { count, error } = (await Promise.race([query, timeout])) as { count: number | null; error: unknown };
      if (error || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        return { count: null, asOf, ok: false };
      }
      return { count, asOf, ok: true };
    } catch {
      return { count: null, asOf, ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const promise = run().finally(() => {
    if (inflight && inflight.promise === promise) inflight = null;
  });
  inflight = { key, promise };
  return promise;
}
