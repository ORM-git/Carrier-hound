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
  status: "healthy" | "degraded" | "no_data" | "invalid" | "in_progress";
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
    if (r.status !== "success") {
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
  // "in progress", not failed; evaluate the most recent FINALIZED cycle.
  if (latestCycle.isInProgress) {
    const mostRecentFinalized = completedCycles[0];

    if (!mostRecentFinalized) {
      return {
        status: "in_progress",
        reason: latestCycle.reason || `Cycle ${latestCycle.cycleId} is in progress; no completed cycle exists.`,
      };
    }

    if (!mostRecentFinalized.isHealthy) {
      return {
        status: "degraded",
        reason: mostRecentFinalized.reason || "Previous finalized cycle failed.",
        lastSuccessAt: lastSuccessCycle ? new Date(lastSuccessCycle.latestFinishedAt).toISOString() : undefined,
        lastFailureAt: new Date(mostRecentFinalized.latestFinishedAt).toISOString(),
        consecutiveFailures: failureCount,
      };
    }

    const staleAfterMs = policy.staleAfterHours * 60 * 60 * 1000;
    if (now - mostRecentFinalized.latestFinishedAt > staleAfterMs) {
      return {
        status: "degraded",
        reason: `Last success is older than ${policy.staleAfterHours}h.`,
        lastSuccessAt: new Date(mostRecentFinalized.latestFinishedAt).toISOString(),
        staleAfterHours: policy.staleAfterHours,
      };
    }

    return {
      status: "healthy",
      lastSuccessAt: new Date(mostRecentFinalized.latestFinishedAt).toISOString(),
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

// =============================================================================
// PER-SOURCE FRESHNESS (checklist #46). Separate from evaluateSourceHealth, opt-in via expectedSources.
//
// Evidence shape (scripts/ingest.ts, ingest_runs insert): per_source_counts = { [sourceId]: inserted+updated,
// coverage: {...} }. Every processed source is written, failed ones included (count usually 0), and any
// source failure turns the row status to "warning"/"failed". So:
//   - a source key in a status "success" row is successful evidence, even with a count of 0;
//   - a source key in any other row is ambiguous (0 may be a failure): neither success nor failure;
//   - a row without per-source keys could hide any source: ambiguous for every expected source.
// A row's time is finished_at, else started_at; an unparseable time is ambiguous, never fresh.
// =============================================================================

export interface SourceFreshnessPolicy {
  expectedSources?: string[] | null;
  sourceStaleAfterHours: number;
}

export interface SourceFreshnessResult {
  status: "not_configured" | "invalid" | "healthy" | "degraded" | "insufficient_evidence";
  referenceTime: string;
  staleSources: Array<{ source: string; lastSuccessAt: string }>;
  neverSeenSources: string[];
  unknownSources: string[];
  insufficientEvidenceSources: string[];
}

// "python_run" is the Python pipeline's run metadata (scripts/scraper/health_record.py), never a source.
const NON_SOURCE_KEYS = new Set(["coverage", "python_run"]);

function perSourceEntries(run: IngestRunSnapshot): Map<string, unknown> | null {
  const psc = run?.per_source_counts;
  if (!psc || typeof psc !== "object" || Array.isArray(psc)) return null;
  const entries = new Map(Object.entries(psc as Record<string, unknown>).filter(([k]) => !NON_SOURCE_KEYS.has(k)));
  return entries.size > 0 ? entries : null;
}

/**
 * Pure per-source freshness at an explicit referenceTime. A source is stale when its newest successful
 * evidence is MORE than sourceStaleAfterHours old (exactly at the window is still fresh) and no ambiguous
 * row could be newer evidence; neverSeen when no row could contain it; insufficient otherwise.
 * Without expectedSources it returns "not_configured" and judges nothing.
 */
export function evaluateSourceFreshness(
  runs: IngestRunSnapshot[],
  policy: SourceFreshnessPolicy,
  referenceTime: string
): SourceFreshnessResult {
  const empty = { staleSources: [], neverSeenSources: [], unknownSources: [], insufficientEvidenceSources: [] };
  const expected = Array.from(new Set((policy.expectedSources || []).filter((s) => typeof s === "string" && s.trim())));
  if (expected.length === 0) return { status: "not_configured", referenceTime, ...empty };
  const ref = Date.parse(referenceTime);
  if (!Number.isFinite(ref) || !Number.isFinite(policy.sourceStaleAfterHours) || policy.sourceStaleAfterHours <= 0) {
    return { status: "invalid", referenceTime, ...empty };
  }
  const windowMs = policy.sourceStaleAfterHours * 3600_000;

  const lastSuccess = new Map<string, number>();
  const newestAmbiguous = new Map<string, number>(); // Infinity = undated, could be newer than anything
  const seen = new Set<string>();
  let blindRowAt = -Infinity; // newest row with no per-source detail (could hide any source)
  const noteAmbiguous = (s: string, at: number) => newestAmbiguous.set(s, Math.max(newestAmbiguous.get(s) ?? -Infinity, at));

  for (const run of Array.isArray(runs) ? runs : []) {
    const parsed = Date.parse(run?.finished_at || run?.started_at || "");
    const at = Number.isFinite(parsed) ? parsed : Infinity;
    const entries = perSourceEntries(run);
    if (!entries) {
      blindRowAt = Math.max(blindRowAt, at);
      continue;
    }
    for (const [source, count] of Array.from(entries)) {
      seen.add(source);
      const validCount = typeof count === "number" && Number.isFinite(count) && count >= 0;
      if (run.status === "success" && validCount && Number.isFinite(at) && at <= ref) {
        lastSuccess.set(source, Math.max(lastSuccess.get(source) ?? -Infinity, at));
      } else {
        noteAmbiguous(source, at);
      }
    }
  }

  const staleSources: SourceFreshnessResult["staleSources"] = [];
  const neverSeenSources: string[] = [];
  const insufficientEvidenceSources: string[] = [];
  for (const source of expected) {
    const last = lastSuccess.get(source);
    const ambiguousAt = Math.max(newestAmbiguous.get(source) ?? -Infinity, blindRowAt);
    if (last !== undefined && ref - last <= windowMs) continue; // fresh
    if (last !== undefined && ambiguousAt <= last) {
      staleSources.push({ source, lastSuccessAt: new Date(last).toISOString() });
    } else if (last === undefined && !seen.has(source) && blindRowAt === -Infinity) {
      neverSeenSources.push(source);
    } else {
      insufficientEvidenceSources.push(source);
    }
  }
  const unknownSources = Array.from(seen).filter((s) => !expected.includes(s)).sort();

  const status: SourceFreshnessResult["status"] =
    staleSources.length || neverSeenSources.length ? "degraded" : insufficientEvidenceSources.length ? "insufficient_evidence" : "healthy";
  return { status, referenceTime, staleSources, neverSeenSources, unknownSources, insufficientEvidenceSources };
}

// =============================================================================
// PIPELINE-AWARE MONITORING (rows 46/78): TypeScript shard cycles + per-source freshness, and Python cohorts.
//
// Python rows (scripts/scraper/health_record.py) carry per_source_counts.python_run = { pipeline: "python",
// cohort, outcome, sources: { [id]: { state } }, deferred: { [id]: { reason } } } and no "coverage", so they are
// kept out of the TypeScript cycle logic entirely and judged per cohort here. Pure: rows and time are inputs.
// =============================================================================

export const PYTHON_RUN_KEY = "python_run";

export interface PythonRunMeta {
  pipeline: "python";
  cohort: string;
  outcome?: string | null;
  exit_code?: string | null;
  sources?: Record<string, { state?: string | null } | null> | null;
  deferred?: Record<string, { reason?: string | null; next_eligible_at?: string | null } | null> | null;
}

export function pythonRunMeta(run: IngestRunSnapshot): PythonRunMeta | null {
  const psc = run?.per_source_counts;
  if (!psc || typeof psc !== "object" || Array.isArray(psc)) return null;
  const meta = (psc as Record<string, unknown>)[PYTHON_RUN_KEY];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  return m.pipeline === "python" && typeof m.cohort === "string" && m.cohort ? (m as unknown as PythonRunMeta) : null;
}

export function partitionRunsByPipeline(runs: readonly IngestRunSnapshot[]): {
  typescript: IngestRunSnapshot[];
  python: IngestRunSnapshot[];
} {
  const typescript: IngestRunSnapshot[] = [];
  const python: IngestRunSnapshot[] = [];
  for (const run of Array.isArray(runs) ? runs : []) (pythonRunMeta(run) ? python : typescript).push(run);
  return { typescript, python };
}

export type MonitoringSeverity = "ok" | "degraded" | "unavailable";

export interface CohortExpectation {
  expectedSources: string[];
  sourceStaleAfterHours: number;
  overdueAfterHours: number;
}

export type PythonSourceState =
  | "healthy" | "stale" | "never_seen" | "failed" | "incomplete" | "deferred" | "insufficient_evidence";

const SOURCE_STATE_SEVERITY: Record<PythonSourceState, MonitoringSeverity> = {
  healthy: "ok",
  stale: "degraded",
  never_seen: "degraded",
  failed: "degraded",
  incomplete: "unavailable", // fetched, but one page of a larger board: partial evidence, never success
  deferred: "unavailable", // deliberate cooldown/budget: not a failure, not fresh evidence either
  insufficient_evidence: "unavailable",
};

export interface PythonCohortResult {
  cohort: string;
  state: "ok" | "not_configured" | "missing" | "overdue" | "failed" | "deferred_noop";
  severity: MonitoringSeverity;
  reason: string;
  latestRunAt?: string;
  latestOutcome?: string | null;
  sources: Record<PythonSourceState, string[]>;
  unknownSources: string[];
}

function rowTime(run: IngestRunSnapshot): number {
  const t = Date.parse(String(run?.finished_at || run?.started_at || ""));
  return Number.isFinite(t) ? t : -Infinity;
}

function worst(a: MonitoringSeverity, b: MonitoringSeverity): MonitoringSeverity {
  if (a === "degraded" || b === "degraded") return "degraded";
  return a === "unavailable" || b === "unavailable" ? "unavailable" : "ok";
}

function emptyPythonSources(): Record<PythonSourceState, string[]> {
  return { healthy: [], stale: [], never_seen: [], failed: [], incomplete: [], deferred: [], insufficient_evidence: [] };
}

export function evaluatePythonCohort(
  cohort: string,
  pythonRuns: readonly IngestRunSnapshot[],
  expectation: CohortExpectation | null | undefined,
  nowIso: string
): PythonCohortResult {
  const sources = emptyPythonSources();
  const expected = Array.from(new Set((expectation?.expectedSources || []).filter((s) => typeof s === "string" && s.trim())));
  if (!expectation || expected.length === 0) {
    return { cohort, state: "not_configured", severity: "unavailable", reason: `No expected sources configured for Python cohort ${cohort}.`, sources, unknownSources: [] };
  }
  const now = Date.parse(nowIso);
  const rows = pythonRuns.filter((r) => pythonRunMeta(r)?.cohort === cohort).sort((a, b) => rowTime(b) - rowTime(a));
  if (rows.length === 0) {
    sources.insufficient_evidence.push(...expected.slice().sort());
    return { cohort, state: "missing", severity: "degraded", reason: `No Python ${cohort} run is recorded in the lookback window.`, sources, unknownSources: [] };
  }
  const latest = rows[0];
  const latestAt = rowTime(latest);
  const meta = pythonRunMeta(latest)!;
  let state: PythonCohortResult["state"] = "ok";
  let severity: MonitoringSeverity = "ok";
  let reason = `Latest Python ${cohort} run outcome: ${meta.outcome ?? "unknown"}.`;
  if (!Number.isFinite(latestAt) || !Number.isFinite(now) || now - latestAt > expectation.overdueAfterHours * 3600_000) {
    state = "overdue";
    severity = "degraded";
    reason = `Latest Python ${cohort} run is older than ${expectation.overdueAfterHours}h (or undated).`;
  } else if (meta.outcome !== "ok" && meta.outcome !== "deferred_noop") {
    state = "failed";
    severity = "degraded";
    reason = `Latest Python ${cohort} run did not succeed (outcome ${meta.outcome ?? "unknown"}, exit ${meta.exit_code ?? "n/a"}).`;
  } else if (meta.outcome === "deferred_noop") {
    state = "deferred_noop"; // deliberate: every board on cooldown/budget; per-source freshness decides below
    reason = `Latest Python ${cohort} run deferred every board (cooldown/budget); nothing was written.`;
  }

  const freshness = evaluateSourceFreshness(rows, { expectedSources: expected, sourceStaleAfterHours: expectation.sourceStaleAfterHours }, nowIso);
  const stale = new Set(freshness.staleSources.map((s) => s.source));
  const never = new Set(freshness.neverSeenSources);
  const insufficient = new Set(freshness.insufficientEvidenceSources);
  const metas = rows.map((r) => pythonRunMeta(r)!);
  for (const s of expected) {
    if (!stale.has(s) && !never.has(s) && !insufficient.has(s)) {
      sources.healthy.push(s);
      continue;
    }
    const mention = metas.find((m) => (m.sources && m.sources[s]) || (m.deferred && m.deferred[s]));
    const st = mention?.sources?.[s]?.state;
    const bucket: PythonSourceState =
      st === "failed" ? "failed"
        : st === "incomplete" ? "incomplete"
          : mention?.deferred?.[s] ? "deferred"
            : stale.has(s) ? "stale"
              : never.has(s) ? "never_seen"
                : "insufficient_evidence";
    sources[bucket].push(s);
  }
  for (const [bucket, list] of Object.entries(sources) as Array<[PythonSourceState, string[]]>) {
    list.sort();
    if (list.length) severity = worst(severity, SOURCE_STATE_SEVERITY[bucket]);
  }
  return {
    cohort, state, severity, reason,
    latestRunAt: Number.isFinite(latestAt) ? new Date(latestAt).toISOString() : undefined,
    latestOutcome: meta.outcome ?? null, sources, unknownSources: freshness.unknownSources,
  };
}

export interface MonitoringConfig {
  typescript: { health: SourceHealthPolicy; expectedSources: string[]; sourceStaleAfterHours: number; cycleRowWindow: number } | null;
  python: Record<string, CohortExpectation> | null;
  evidenceTruncated?: boolean;
}

export interface MonitoringCheck {
  pipeline: "typescript" | "python" | "evidence";
  scope: string;
  state: string;
  severity: MonitoringSeverity;
  reason: string;
  sources?: Record<string, string[]>;
}

export interface MonitoringResult {
  status: "healthy" | "degraded" | "unavailable";
  exitCode: 0 | 1 | 2; // 0 healthy, 1 degraded (act), 2 evidence missing/insufficient/not configured
  referenceTime: string;
  checks: MonitoringCheck[];
  python: PythonCohortResult[];
}

/** Both pipelines, one verdict. Degraded wins over unavailable; nothing missing is ever reported healthy. */
export function evaluateIngestionMonitoring(runs: readonly IngestRunSnapshot[], config: MonitoringConfig, nowIso: string): MonitoringResult {
  const { typescript: tsRows, python: pyRows } = partitionRunsByPipeline(runs);
  const checks: MonitoringCheck[] = [];
  if (config.evidenceTruncated) {
    checks.push({ pipeline: "evidence", scope: "ingest_runs", state: "truncated", severity: "unavailable",
      reason: "Row cap reached before the lookback window was covered; older evidence was not read." });
  }

  if (!config.typescript) {
    checks.push({ pipeline: "typescript", scope: "pipeline", state: "not_configured", severity: "unavailable", reason: "No TypeScript expectations configured." });
  } else {
    const ts = config.typescript;
    // Same rows the cycle gate always saw (newest N TS rows), so its verdict is unchanged by Python rows.
    const cycle = evaluateSourceHealth(tsRows.slice(0, ts.cycleRowWindow), ts.health, nowIso);
    checks.push({ pipeline: "typescript", scope: "cycles", state: cycle.status,
      severity: cycle.status === "healthy" ? "ok" : cycle.status === "degraded" ? "degraded" : "unavailable",
      reason: cycle.reason || `TypeScript shard cycles: ${cycle.status}.` });
    const fresh = evaluateSourceFreshness(tsRows, { expectedSources: ts.expectedSources, sourceStaleAfterHours: ts.sourceStaleAfterHours }, nowIso);
    checks.push({ pipeline: "typescript", scope: "sources", state: fresh.status,
      severity: fresh.status === "healthy" ? "ok" : fresh.status === "degraded" ? "degraded" : "unavailable",
      reason: `TypeScript per-source freshness (${ts.sourceStaleAfterHours}h): ${fresh.status}.`,
      sources: { stale: fresh.staleSources.map((s) => s.source), never_seen: fresh.neverSeenSources,
        insufficient_evidence: fresh.insufficientEvidenceSources, unknown: fresh.unknownSources } });
  }

  const python: PythonCohortResult[] = [];
  const cohorts = config.python ? Object.keys(config.python).sort() : [];
  if (cohorts.length === 0) {
    checks.push({ pipeline: "python", scope: "pipeline", state: "not_configured", severity: "unavailable", reason: "No Python cohorts configured." });
  }
  for (const cohort of cohorts) {
    const r = evaluatePythonCohort(cohort, pyRows, config.python![cohort], nowIso);
    python.push(r);
    const { healthy: _healthy, ...problems } = r.sources;
    checks.push({ pipeline: "python", scope: `cohort:${cohort}`, state: r.state, severity: r.severity, reason: r.reason,
      sources: { ...problems, unknown: r.unknownSources } });
  }
  // Python rows for a cohort nobody expects are reported, never silently counted.
  const known = new Set(cohorts);
  const strays = Array.from(new Set(pyRows.map((r) => pythonRunMeta(r)!.cohort).filter((c) => !known.has(c)))).sort();
  if (strays.length) {
    checks.push({ pipeline: "python", scope: "cohorts", state: "unexpected_cohort", severity: "unavailable",
      reason: `Rows for unconfigured Python cohort(s): ${strays.join(", ")}.` });
  }

  const severity = checks.reduce<MonitoringSeverity>((acc, c) => worst(acc, c.severity), "ok");
  return {
    status: severity === "ok" ? "healthy" : severity,
    exitCode: severity === "ok" ? 0 : severity === "degraded" ? 1 : 2,
    referenceTime: nowIso, checks, python,
  };
}

/** Readable per-pipeline/cohort summary: source IDs and states only, never URLs or credentials. */
export function renderMonitoringSummary(result: MonitoringResult, maxIdsPerState = 15): string {
  const lines = [`## Source health: ${result.status.toUpperCase()} (exit ${result.exitCode})`, "",
    `Reference time ${result.referenceTime}.`, "", "| pipeline | scope | state | severity | detail |", "|---|---|---|---|---|"];
  for (const c of result.checks) {
    lines.push(`| ${c.pipeline} | ${c.scope} | ${c.state} | ${c.severity} | ${c.reason.replace(/\|/g, "/")} |`);
  }
  for (const c of result.checks) {
    for (const [state, ids] of Object.entries(c.sources || {})) {
      if (!ids.length) continue;
      const shown = ids.slice(0, maxIdsPerState).join(", ");
      lines.push("", `- ${c.pipeline} ${c.scope} **${state}** (${ids.length}): ${shown}${ids.length > maxIdsPerState ? ", ..." : ""}`);
    }
  }
  lines.push("", "A failed run of this workflow is routed by workflow-failure-alert.yml; that is not proof anyone received an alert.");
  return lines.join("\n");
}
