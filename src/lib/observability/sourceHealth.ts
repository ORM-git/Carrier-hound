/** Source-health classification. Pure and deterministic: caller supplies
 * measured run rows and a sampled time. */
export interface IngestRunSnapshot {
  started_at?: string | null;
  finished_at?: string | null;
  status?: string | null;
  per_source_counts?: unknown;
}

export interface CollapsedBoard {
  board: string;
  previousCount: number;
  currentCount: number;
  dropPercent: number;
}

export interface SourceHealthPolicy {
  maxFailuresInWindow: number;
  staleAfterHours: number;
  volumeCollapseDropThresholdPercent?: number;
  minBaselineJobsForCollapse?: number;
}

export interface SourceHealthResult {
  status: "healthy" | "degraded" | "no_data" | "invalid";
  reason?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  staleAfterHours?: number;
  collapsedBoards?: CollapsedBoard[];
}

export interface RunCoverageMetadata {
  is_partial?: boolean;
  source_filter?: string | null;
  limit?: number | null;
  boards_checked?: string[];
}

export function extractRunCoverage(perSourceCounts: unknown): RunCoverageMetadata | null {
  if (!perSourceCounts || typeof perSourceCounts !== "object") return null;
  const raw = perSourceCounts as Record<string, unknown>;
  if (raw._coverage && typeof raw._coverage === "object") {
    return raw._coverage as RunCoverageMetadata;
  }
  return null;
}

export function extractBoardCounts(perSourceCounts: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!perSourceCounts || typeof perSourceCounts !== "object") return map;

  for (const [key, value] of Object.entries(perSourceCounts as Record<string, unknown>)) {
    if (key.startsWith("_")) continue; // skip metadata keys like _coverage
    if (typeof value === "number" && Number.isFinite(value)) {
      map.set(key, value);
    } else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const count =
        (typeof v.new_canonical === "number" ? v.new_canonical : typeof v.inserted === "number" ? v.inserted : 0) +
        (typeof v.updated === "number" ? v.updated : 0) +
        (typeof v.reopened === "number" ? v.reopened : 0);
      map.set(key, count);
    }
  }
  return map;
}

export function detectPerBoardVolumeCollapse(
  currentCounts: Map<string, number>,
  previousCounts: Map<string, number>,
  options: {
    minBaseline?: number;
    dropThresholdPercent?: number;
    checkedBoards?: Set<string>;
    onlyCheckedBoards?: boolean;
  } = {}
): CollapsedBoard[] {
  const minBaseline = options.minBaseline ?? 5;
  const dropThreshold = options.dropThresholdPercent ?? 80;
  const collapsed: CollapsedBoard[] = [];

  previousCounts.forEach((prevCount, board) => {
    // Only evaluate boards that were actually checked in the current run!
    // A manual --source or limited run must not look like a 100% volume collapse for un-checked boards.
    const isChecked = options.checkedBoards
      ? options.checkedBoards.has(board)
      : options.onlyCheckedBoards !== false
      ? currentCounts.has(board)
      : true;

    if (!isChecked) return;

    if (prevCount >= minBaseline) {
      const currCount = currentCounts.get(board) ?? 0;
      const dropPct = ((prevCount - currCount) / prevCount) * 100;
      if (dropPct >= dropThreshold) {
        collapsed.push({
          board,
          previousCount: prevCount,
          currentCount: currCount,
          dropPercent: Math.round(dropPct),
        });
      }
    }
  });

  return collapsed.sort((a, b) => b.dropPercent - a.dropPercent);
}

export function evaluateSourceHealth(
  runs: readonly IngestRunSnapshot[],
  policy: SourceHealthPolicy,
  nowIso: string
): SourceHealthResult {
  if (!Array.isArray(runs)) return { status: "invalid", reason: "runs must be an array." };
  if (!Number.isSafeInteger(policy.maxFailuresInWindow) || policy.maxFailuresInWindow < 1 ||
      !Number.isFinite(policy.staleAfterHours) || policy.staleAfterHours <= 0) {
    return { status: "invalid", reason: "Policy must have positive failure and staleness thresholds." };
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return { status: "invalid", reason: "nowIso must be a valid timestamp." };
  const runsWithFailure = runs.filter((run) => run?.status === "failed" || run?.status === "warning");
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
  if (lastFailure > lastSuccess && runsWithFailure.length >= policy.maxFailuresInWindow) {
    return { status: "degraded", reason: `Latest outcome is failed/warning and ${runsWithFailure.length} unsuccessful rows meet the threshold.`, lastSuccessAt: new Date(lastSuccess).toISOString(), lastFailureAt: new Date(lastFailure).toISOString(), consecutiveFailures: runsWithFailure.length };
  }
  const staleAfterMs = policy.staleAfterHours * 60 * 60 * 1000;
  if (now - lastSuccess > staleAfterMs) {
    return { status: "degraded", reason: `Last success is older than ${policy.staleAfterHours}h.`, lastSuccessAt: new Date(lastSuccess).toISOString(), staleAfterHours: policy.staleAfterHours };
  }

  // Per-board volume collapse detection across recent runs
  const runsWithCounts = runs
    .filter((r) => r && r.per_source_counts && typeof r.per_source_counts === "object")
    .map((r) => ({
      run: r,
      timestamp: Date.parse(String(r.finished_at || r.started_at || "")),
    }))
    .filter((r) => Number.isFinite(r.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);

  let collapsedBoards: CollapsedBoard[] = [];
  if (runsWithCounts.length >= 2) {
    const latestRun = runsWithCounts[0].run;
    const latestCoverage = extractRunCoverage(latestRun.per_source_counts);

    // Find the most recent compatible previous run
    let previousRun = runsWithCounts[1].run;
    if (latestCoverage && !latestCoverage.is_partial) {
      // If latest is a complete run, compare against the last complete run so intervening partial runs don't distort baseline
      const prevComplete = runsWithCounts.slice(1).find((r) => {
        const cov = extractRunCoverage(r.run.per_source_counts);
        return cov ? !cov.is_partial : true;
      });
      if (prevComplete) {
        previousRun = prevComplete.run;
      }
    }

    const currCounts = extractBoardCounts(latestRun.per_source_counts);
    const prevCounts = extractBoardCounts(previousRun.per_source_counts);

    const checkedBoards = latestCoverage?.boards_checked
      ? new Set(latestCoverage.boards_checked)
      : new Set(currCounts.keys());

    collapsedBoards = detectPerBoardVolumeCollapse(currCounts, prevCounts, {
      minBaseline: policy.minBaselineJobsForCollapse ?? 5,
      dropThresholdPercent: policy.volumeCollapseDropThresholdPercent ?? 80,
      checkedBoards,
    });
  }

  if (collapsedBoards.length > 0) {
    return {
      status: "degraded",
      reason: `Per-board volume collapse detected on ${collapsedBoards.length} board(s): ${collapsedBoards
        .map((b) => `${b.board} (${b.previousCount}->${b.currentCount}, -${b.dropPercent}%)`)
        .join(", ")}`,
      lastSuccessAt: Number.isFinite(lastSuccess) ? new Date(lastSuccess).toISOString() : undefined,
      lastFailureAt: Number.isFinite(lastFailure) ? new Date(lastFailure).toISOString() : undefined,
      collapsedBoards,
    };
  }

  return { status: "healthy", lastSuccessAt: new Date(lastSuccess).toISOString() };
}
