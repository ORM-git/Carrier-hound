/**
 * Technical readiness of the numeric required-years predicate: can the service identity query
 * jobs.min_experience_years / max_experience_years right now. Bounded read-only probe in the style of
 * /api/health/ready: a head select that returns no rows and no content, a timeout that also aborts the
 * underlying request when the client supports it, and anything other than an explicit success response
 * (an object whose error is null) is false: errors, timeouts, throws, a missing response or a missing client.
 * No cache: each answer belongs to the client that was just probed, so one project or identity can never lend
 * its success to another. It says nothing about data coverage: jobs that state no years are kept by the
 * predicate, so an empty column is technically ready and simply narrows nothing.
 */
export interface YearsProbeBuilder extends PromiseLike<unknown> {
  abortSignal?: (signal: AbortSignal) => YearsProbeBuilder;
}
export interface YearsProbeClient {
  from(table: string): {
    select(columns: string, opts?: { head?: boolean }): { limit(n: number): YearsProbeBuilder };
  };
}

export const YEARS_PROBE_TIMEOUT_MS = 2500;

export async function probeRequiredYearsColumns(
  client: YearsProbeClient | null | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<boolean> {
  if (!client) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  try {
    let builder = client.from("jobs").select("min_experience_years,max_experience_years", { head: true }).limit(1);
    if (ctrl && typeof builder.abortSignal === "function") builder = builder.abortSignal(ctrl.signal);
    const attempt = Promise.resolve(builder).then(
      (r) => typeof r === "object" && r !== null && (r as { error?: unknown }).error === null,
      () => false
    );
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { ctrl?.abort(); resolve(false); }, opts.timeoutMs ?? YEARS_PROBE_TIMEOUT_MS);
    });
    return await Promise.race([attempt, timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
