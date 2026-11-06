/** Source-health classification. Pure and deterministic: caller supplies
 * measured run rows and a sampled time. */
export interface IngestRunSnapshot {
  started_at?: string | null;
  finished_at?: string | null;
  status?: string | null;
  per_source_counts?: unknown;
}

export interface SourceHealthPolicy {
  maxConsecutiveFailures: number;
  staleAfterHours: number;
}

export interface SourceHealthResult {
  status: "healthy" | "degraded" | "no_data" | "invalid";
  reason?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  staleAfterHours?: number;
}

export function evaluateSourceHealth(
  runs: readonly IngestRunSnapshot[],
  policy: SourceHealthPolicy,
  nowIso: string
): SourceHealthResult {
  if (!Number.isSafeInteger(policy.maxConsecutiveFailures) || policy.maxConsecutiveFailures < 1 ||
      !Number.isFinite(policy.staleAfterHours) || policy.staleAfterHours <= 0) {
    return { status: "invalid", reason: "Policy must have positive failure and staleness thresholds." };
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return { status: "invalid", reason: "nowIso must be a valid timestamp." };
  const runsWithFailure = runs.filter((run) => run?.status === "failed" || run?.status === "warning");
  if (!Array.isArray(runs)) return { status: "invalid", reason: "runs must be an array." };
  if (runs.length === 0) return { status: "no_data" };

  let lastSuccess = -Infinity;
  let lastFailure = -Infinity;
  let invalid = false;
  for (const run of runs) {
    const stamp = Date.parse(String(run.finished_at || run.started_at || ""));
    if (!Number.isFinite(stamp)) { invalid = true; continue; }
    if (run.status === "success") lastSuccess = Math.max(lastSuccess, stamp);
    if (run.status === "failed" || run.status === "warning") lastFailure = Math.max(lastFailure, stamp);
  }
  if (invalid && !Number.isFinite(lastSuccess) && !Number.isFinite(lastFailure)) {
    return { status: "invalid", reason: "Run rows lack valid timestamps." };
  }
  if (!Number.isFinite(lastSuccess)) {
    return { status: "degraded", reason: "No successful run in the provided window.", lastFailureAt: Number.isFinite(lastFailure) ? new Date(lastFailure).toISOString() : undefined };
  }
  if (lastFailure > lastSuccess && runsWithFailure.length >= policy.maxConsecutiveFailures) {
    return { status: "degraded", reason: `Latest outcome is failed/warning and ${runsWithFailure.length} unsuccessful rows meet the threshold.`, lastSuccessAt: new Date(lastSuccess).toISOString(), lastFailureAt: new Date(lastFailure).toISOString(), consecutiveFailures: runsWithFailure.length };
  }
  const staleAfterMs = policy.staleAfterHours * 60 * 60 * 1000;
  if (now - lastSuccess > staleAfterMs) {
    return { status: "degraded", reason: `Last success is older than ${policy.staleAfterHours}h.`, lastSuccessAt: new Date(lastSuccess).toISOString(), staleAfterHours: policy.staleAfterHours };
  }
  return { status: "healthy", lastSuccessAt: new Date(lastSuccess).toISOString() };
}
