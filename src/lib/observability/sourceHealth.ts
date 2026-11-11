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

function checkCycleHealth(c: CycleInfo): {
  isHealthy: boolean;
  missingShards: number[];
  failedShards: number[];
  reason?: string;
} {
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

  if (failedShards.length > 0) {
    return {
      isHealthy: false,
      missingShards,
      failedShards,
      reason: `Cycle ${c.cycleId} had failing shard(s): ${failedShards.join(", ")}.`,
    };
  }

  if (missingShards.length > 0) {
    return {
      isHealthy: false,
      missingShards,
      failedShards,
      reason: `Cycle ${c.cycleId} is incomplete: expected ${c.expectedShards} shards, received ${c.shards.size} (missing shard(s): ${missingShards.join(", ")}).`,
    };
  }

  return { isHealthy: true, missingShards: [], failedShards: [] };
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
    policy.staleAfterHours <= 0
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
    const stamp = Date.parse(String(run?.finished_at || run?.started_at || ""));
    if (!Number.isFinite(stamp)) return;

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
        earliestStartedAt: stamp,
      };
      cyclesMap.set(cycleId, group);
    } else {
      if (expectedShards > group.expectedShards) {
        group.expectedShards = expectedShards;
      }
      group.latestFinishedAt = Math.max(group.latestFinishedAt, stamp);
      group.earliestStartedAt = Math.min(group.earliestStartedAt, stamp);
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

  let lastSuccessCycle: CycleInfo | null = null;
  let lastFailureCycle: CycleInfo | null = null;
  let failureCount = 0;

  for (const c of sortedCycles) {
    const health = checkCycleHealth(c);
    if (health.isHealthy) {
      if (!lastSuccessCycle) lastSuccessCycle = c;
    } else {
      if (!lastFailureCycle) lastFailureCycle = c;
      failureCount++;
    }
  }

  if (!lastSuccessCycle) {
    const latestHealth = sortedCycles.length > 0 ? checkCycleHealth(sortedCycles[0]) : null;
    return {
      status: "degraded",
      reason: latestHealth && !latestHealth.isHealthy ? latestHealth.reason : "No successful cycle in the provided window.",
      lastFailureAt: lastFailureCycle ? new Date(lastFailureCycle.latestFinishedAt).toISOString() : undefined,
      consecutiveFailures: failureCount,
    };
  }

  const latestCycle = sortedCycles[0];
  const latestHealth = checkCycleHealth(latestCycle);

  if (!latestHealth.isHealthy && failureCount >= policy.maxFailuresInWindow) {
    return {
      status: "degraded",
      reason: latestHealth.reason || "Latest cycle is unhealthy.",
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
