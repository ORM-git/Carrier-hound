/** Source-health classification. Pure and deterministic: caller supplies
 * measured run rows and a sampled time. */
export interface IngestRunCoverage {
  cycle_id?: string | null;
  shard_id?: number | null;
  expected_shards?: number | null;
}

export interface IngestRunSnapshot {
  started_at?: string | null;
  finished_at?: string | null;
  status?: string | null;
  coverage?: IngestRunCoverage | null;
  per_source_counts?: unknown;
}

export interface SourceHealthPolicy {
  maxFailuresInWindow: number;
  staleAfterHours: number;
  cycleDeadlineMinutes?: number;
}

export interface SourceHealthResult {
  status: "healthy" | "degraded" | "no_data" | "invalid";
  reason?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  staleAfterHours?: number;
}

export function extractRunCoverage(run: IngestRunSnapshot): IngestRunCoverage | null {
  if (run?.coverage && typeof run.coverage === "object") {
    return run.coverage;
  }
  if (run?.per_source_counts && typeof run.per_source_counts === "object") {
    const psc = run.per_source_counts as Record<string, unknown>;
    if (psc.coverage && typeof psc.coverage === "object") {
      return psc.coverage as IngestRunCoverage;
    }
  }
  return null;
}

interface CycleInfo {
  cycleId: string;
  expectedShards: number;
  shards: Map<number, IngestRunSnapshot>;
  latestFinishedAt: number;
  earliestStartedAt: number;
}

export interface CycleEvaluation {
  cycleId: string;
  expectedShards: number;
  isComplete: boolean;
  isInProgress: boolean;
  isOverdue: boolean;
  isHealthy: boolean;
  missingShards: number[];
  failedShards: number[];
  reason?: string;
  latestFinishedAt: number;
  earliestStartedAt: number;
}

export function evaluateCycleHealth(
  c: CycleInfo,
  now: number,
  cycleDeadlineMinutes: number
): CycleEvaluation {
  const missingShards: number[] = [];
  for (let s = 0; s < c.expectedShards; s++) {
    if (!c.shards.has(s)) {
      missingShards.push(s);
    }
  }

  const failedShards: number[] = [];
  c.shards.forEach((r, sId) => {
    if (r.status === "failed" || r.status === "warning") {
      failedShards.push(sId);
    }
  });

  const isComplete = missingShards.length === 0;
  const cycleRefTime = c.earliestStartedAt;
  const elapsedMinutes = (now - cycleRefTime) / (60 * 1000);
  const isOverdue = elapsedMinutes > cycleDeadlineMinutes;

  if (failedShards.length > 0) {
    return {
      cycleId: c.cycleId,
      expectedShards: c.expectedShards,
      isComplete,
      isInProgress: false,
      isOverdue,
      isHealthy: false,
      missingShards,
      failedShards,
      reason: `Cycle ${c.cycleId} had failing shard(s): ${failedShards.join(", ")}.`,
      latestFinishedAt: c.latestFinishedAt,
      earliestStartedAt: c.earliestStartedAt,
    };
  }

  if (isComplete) {
    return {
      cycleId: c.cycleId,
      expectedShards: c.expectedShards,
      isComplete: true,
      isInProgress: false,
      isOverdue: false,
      isHealthy: true,
      missingShards: [],
      failedShards: [],
      latestFinishedAt: c.latestFinishedAt,
      earliestStartedAt: c.earliestStartedAt,
    };
  }

  // Missing shards, no failures
  if (isOverdue) {
    return {
      cycleId: c.cycleId,
      expectedShards: c.expectedShards,
      isComplete: false,
      isInProgress: false,
      isOverdue: true,
      isHealthy: false,
      missingShards,
      failedShards: [],
      reason: `Cycle ${c.cycleId} is overdue (${Math.round(elapsedMinutes)}m > ${cycleDeadlineMinutes}m) and incomplete: expected ${c.expectedShards} shards, received ${c.shards.size} (missing shard(s): ${missingShards.join(", ")}).`,
      latestFinishedAt: c.latestFinishedAt,
      earliestStartedAt: c.earliestStartedAt,
    };
  }

  // Missing shards, no failures, inside allowed deadline window: in progress!
  return {
    cycleId: c.cycleId,
    expectedShards: c.expectedShards,
    isComplete: false,
    isInProgress: true,
    isOverdue: false,
    isHealthy: true,
    missingShards,
    failedShards: [],
    reason: `Cycle ${c.cycleId} is in progress (${c.shards.size}/${c.expectedShards} shards completed).`,
    latestFinishedAt: c.latestFinishedAt,
    earliestStartedAt: c.earliestStartedAt,
  };
}

export function evaluateSourceHealth(
  runs: readonly IngestRunSnapshot[],
  policy: SourceHealthPolicy,
  nowIso: string
): SourceHealthResult {
  if (!Array.isArray(runs)) return { status: "invalid", reason: "runs must be an array." };
  if (
    !Number.isSafeInteger(policy.maxFailuresInWindow) ||
    policy.maxFailuresInWindow < 1 ||
    !Number.isFinite(policy.staleAfterHours) ||
    policy.staleAfterHours <= 0 ||
    (policy.cycleDeadlineMinutes !== undefined &&
      (!Number.isFinite(policy.cycleDeadlineMinutes) || policy.cycleDeadlineMinutes <= 0))
  ) {
    return { status: "invalid", reason: "Policy must have positive failure and staleness thresholds." };
  }
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return { status: "invalid", reason: "nowIso must be a valid timestamp." };
  if (runs.length === 0) return { status: "no_data" };

  let anyValidTimestamp = false;
  for (const run of runs) {
    const stamp = Date.parse(String(run?.finished_at || run?.started_at || ""));
    if (Number.isFinite(stamp)) {
      anyValidTimestamp = true;
      break;
    }
  }
  if (!anyValidTimestamp) {
    return { status: "invalid", reason: "Run rows lack valid timestamps." };
  }

  const cyclesMap = new Map<string, CycleInfo>();

  runs.forEach((run, idx) => {
    const finishStamp = Date.parse(String(run?.finished_at || run?.started_at || ""));
    const startStamp = Date.parse(String(run?.started_at || run?.finished_at || ""));
    const stamp = Number.isFinite(finishStamp) ? finishStamp : startStamp;
    if (!Number.isFinite(stamp)) return;
    const effectiveStart = Number.isFinite(startStamp) ? startStamp : stamp;

    const cov = extractRunCoverage(run);
    const hasExplicitCycle = Boolean(cov?.cycle_id);
    const cycleId = hasExplicitCycle
      ? String(cov!.cycle_id)
      : `standalone-${run?.started_at || run?.finished_at || idx}`;
    const shardId = typeof cov?.shard_id === "number" ? cov.shard_id : 0;
    const expectedShards =
      typeof cov?.expected_shards === "number" && cov.expected_shards > 0
        ? cov.expected_shards
        : 1;

    let group = cyclesMap.get(cycleId);
    if (!group) {
      group = {
        cycleId,
        expectedShards,
        shards: new Map(),
        latestFinishedAt: stamp,
        earliestStartedAt: effectiveStart,
      };
      cyclesMap.set(cycleId, group);
    } else {
      if (expectedShards > group.expectedShards) {
        group.expectedShards = expectedShards;
      }
      group.latestFinishedAt = Math.max(group.latestFinishedAt, stamp);
      group.earliestStartedAt = Math.min(group.earliestStartedAt, effectiveStart);
    }

    const existing = group.shards.get(shardId);
    if (!existing) {
      group.shards.set(shardId, run);
    } else {
      const existingStamp = Date.parse(String(existing.finished_at || existing.started_at || ""));
      // Succeeded retry takes precedence or newer timestamp
      if (run.status === "success" || existing.status !== "success" || stamp >= existingStamp) {
        group.shards.set(shardId, run);
      }
    }
  });

  const sortedCycles = Array.from(cyclesMap.values()).sort(
    (a, b) => b.latestFinishedAt - a.latestFinishedAt
  );

  const deadlineMinutes = policy.cycleDeadlineMinutes ?? 90;
  const evaluatedCycles = sortedCycles.map((c) => evaluateCycleHealth(c, now, deadlineMinutes));

  // Completed cycles are finalized: complete all shards, overdue timeout, or failed
  const completedCycles = evaluatedCycles.filter((c) => !c.isInProgress);

  let lastSuccessCycle: CycleEvaluation | null = null;
  let lastFailureCycle: CycleEvaluation | null = null;
  let failureCount = 0;

  for (const c of completedCycles) {
    if (c.isHealthy && c.isComplete) {
      if (!lastSuccessCycle) lastSuccessCycle = c;
    } else {
      if (!lastFailureCycle) lastFailureCycle = c;
      failureCount++;
    }
  }

  const latestCycle = evaluatedCycles[0];

  // Completion/deadline handling: a cycle still inside its allowed window is
  // "in progress", not failed; evaluate the last COMPLETED cycle meanwhile.
  if (latestCycle.isInProgress) {
    if (lastSuccessCycle) {
      const staleAfterMs = policy.staleAfterHours * 60 * 60 * 1000;
      if (now - lastSuccessCycle.latestFinishedAt > staleAfterMs) {
        return {
          status: "degraded",
          reason: `Last success is older than ${policy.staleAfterHours}h.`,
          lastSuccessAt: new Date(lastSuccessCycle.latestFinishedAt).toISOString(),
          staleAfterHours: policy.staleAfterHours,
        };
      }
      return {
        status: "healthy",
        lastSuccessAt: new Date(lastSuccessCycle.latestFinishedAt).toISOString(),
      };
    }

    if (lastFailureCycle && failureCount >= policy.maxFailuresInWindow) {
      return {
        status: "degraded",
        reason: lastFailureCycle.reason || "Previous completed cycle failed.",
        lastFailureAt: new Date(lastFailureCycle.latestFinishedAt).toISOString(),
        consecutiveFailures: failureCount,
      };
    }

    // No completed cycle at all yet, but current cycle is in progress without failures
    return {
      status: "healthy",
      lastSuccessAt: new Date(latestCycle.latestFinishedAt).toISOString(),
    };
  }

  // Latest cycle is finalized (completed, overdue, or has failing shards)
  if (!lastSuccessCycle) {
    return {
      status: "degraded",
      reason: latestCycle.reason || "No successful cycle in the provided window.",
      lastFailureAt: lastFailureCycle ? new Date(lastFailureCycle.latestFinishedAt).toISOString() : undefined,
      consecutiveFailures: failureCount,
    };
  }

  if (!latestCycle.isHealthy && failureCount >= policy.maxFailuresInWindow) {
    return {
      status: "degraded",
      reason: latestCycle.reason || "Latest cycle is unhealthy.",
      lastSuccessAt: new Date(lastSuccessCycle.latestFinishedAt).toISOString(),
      lastFailureAt: new Date(latestCycle.latestFinishedAt).toISOString(),
      consecutiveFailures: failureCount,
    };
  }

  const staleAfterMs = policy.staleAfterHours * 60 * 60 * 1000;
  if (now - lastSuccessCycle.latestFinishedAt > staleAfterMs) {
    return {
      status: "degraded",
      reason: `Last success is older than ${policy.staleAfterHours}h.`,
      lastSuccessAt: new Date(lastSuccessCycle.latestFinishedAt).toISOString(),
      staleAfterHours: policy.staleAfterHours,
    };
  }

  return {
    status: "healthy",
    lastSuccessAt: new Date(lastSuccessCycle.latestFinishedAt).toISOString(),
  };
}
