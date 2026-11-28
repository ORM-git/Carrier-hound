import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  evaluateIngestionMonitoring,
  evaluatePythonCohort,
  evaluateSourceFreshness,
  evaluateSourceHealth,
  partitionRunsByPipeline,
  pythonHealthRecordingEnabled,
  renderMonitoringSummary,
  type IngestRunSnapshot,
  type MonitoringConfig,
} from "../observability/sourceHealth";
import {
  fetchRunsWindow,
  healthyStatusLine,
  loadMonitoringConfig,
  notMonitoredNotice,
  LOOKBACK_HOURS,
  PY_COHORT_OVERDUE_AFTER_HOURS,
  PY_SOURCE_STALE_AFTER_HOURS,
  runCheck,
  TS_CYCLE_ROW_WINDOW,
  TS_SOURCE_STALE_AFTER_HOURS,
} from "../../../scripts/check-source-health";

const ROOT = path.resolve(__dirname, "../../..");
// Built by scripts/scraper/health_record.py; test_health_record.py asserts the Python side still produces these rows.
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/source_health/python_rows.json"), "utf8"));
const PY: Record<string, IngestRunSnapshot> = FIXTURE.rows;
const NOW = "2026-11-28T12:00:00+00:00";
const at = (hoursFromNow: number) => new Date(Date.parse(NOW) + hoursFromNow * 3600_000).toISOString();

function tsShard(cycle: string, shard: number, finishedHoursAgo: number, sources: Record<string, number>, status = "success"): IngestRunSnapshot {
  return {
    started_at: at(-finishedHoursAgo - 0.2), finished_at: at(-finishedHoursAgo), status,
    per_source_counts: { ...sources, coverage: { cycle_id: cycle, shard_id: shard, expected_shards: 2 } },
  };
}
const TS_ROWS = [tsShard("c1", 0, 2, { "greenhouse-a": 3 }), tsShard("c1", 1, 2, { "lever-b": 0 })];

function config(over: Partial<MonitoringConfig> = {}): MonitoringConfig {
  return {
    typescript: { health: { maxFailuresInWindow: 1, staleAfterHours: 12 }, expectedSources: ["greenhouse-a", "lever-b"],
      sourceStaleAfterHours: 24, cycleRowWindow: 50 },
    python: {
      "non-workday": { expectedSources: ["greenhouse:stripe", "amazon", "adzuna:in"], sourceStaleAfterHours: 24, overdueAfterHours: 12 },
      workday: { expectedSources: ["workday:nvidia", "workday:walmart", "workday:cisco"], sourceStaleAfterHours: 72, overdueAfterHours: 12 },
    },
    pythonRecording: true, // these cases judge Python; the gate itself is tested below
    ...over,
  };
}

describe("pipeline partition", () => {
  it("Python rows are recognised and kept out of the TypeScript cycle verdict", () => {
    const newestPyFailure = { ...PY.non_workday_failed, started_at: at(-0.7), finished_at: at(-0.5) };
    const rows = [newestPyFailure, ...TS_ROWS];
    const { typescript, python } = partitionRunsByPipeline(rows);
    expect(python).toEqual([newestPyFailure]);
    expect(typescript).toEqual(TS_ROWS);
    // Raw rows would hand the TS gate a failed standalone "cycle"; the partitioned rows keep its verdict.
    expect(evaluateSourceHealth(rows, { maxFailuresInWindow: 1, staleAfterHours: 12 }, NOW).status).toBe("degraded");
    const r = evaluateIngestionMonitoring(rows, config(), NOW);
    expect(r.checks.find((c) => c.scope === "cycles")!.state).toBe("healthy");
  });

  it("a success row naming no sources is blind: insufficient evidence, never stale or never-seen", () => {
    const blind = [tsShard("c1", 0, 2, { "greenhouse-a": 3 }), tsShard("c1", 1, 2, {})];
    const f = evaluateSourceFreshness(blind, { expectedSources: ["lever-b"], sourceStaleAfterHours: 24 }, NOW);
    expect([f.status, f.insufficientEvidenceSources]).toEqual(["insufficient_evidence", ["lever-b"]]);
  });

  it("python_run is never treated as a source key", () => {
    const f = evaluateSourceFreshness([PY.non_workday_ok], { expectedSources: ["amazon"], sourceStaleAfterHours: 24 }, NOW);
    expect(f.unknownSources).toEqual(["adzuna:in", "greenhouse:stripe"]);
    expect(f.unknownSources).not.toContain("python_run");
  });
});

describe("Python cohort states", () => {
  const nw = config().python!["non-workday"];
  const wd = config().python!.workday;

  it("healthy: latest run ok and every source has fresh success evidence (0 counts included)", () => {
    const r = evaluatePythonCohort("non-workday", [PY.non_workday_ok], nw, NOW);
    expect([r.state, r.severity]).toEqual(["ok", "ok"]);
    expect(r.sources.healthy).toEqual(["adzuna:in", "amazon", "greenhouse:stripe"]);
  });

  it("missing: no row for the cohort is degraded, never healthy", () => {
    const r = evaluatePythonCohort("workday", [PY.non_workday_ok], wd, NOW);
    expect([r.state, r.severity]).toEqual(["missing", "degraded"]);
  });

  it("overdue: latest run older than the window", () => {
    const r = evaluatePythonCohort("non-workday", [PY.non_workday_ok], nw, at(13));
    expect([r.state, r.severity]).toEqual(["overdue", "degraded"]);
  });

  it("failed: latest run failed; its failed source is named", () => {
    const r = evaluatePythonCohort("non-workday", [PY.non_workday_failed], nw, NOW);
    expect([r.state, r.severity]).toEqual(["failed", "degraded"]);
    expect(r.sources.failed).toEqual(["greenhouse:stripe"]);
  });

  it("incomplete Workday pagination and deliberate cooldown are separate, non-success states", () => {
    const r = evaluatePythonCohort("workday", [PY.workday_incomplete_and_deferred], wd, NOW);
    expect(r.state).toBe("ok");
    expect(r.sources.incomplete).toEqual(["workday:walmart"]);
    expect(r.sources.deferred).toEqual(["workday:cisco"]);
    expect(r.sources.failed).toEqual([]);
    // the row is "warning", so even the complete board is not success evidence from this row alone
    expect(r.sources.healthy).toEqual([]);
    expect(r.severity).toBe("unavailable");
  });

  it("deferred no-op is not a failure", () => {
    const r = evaluatePythonCohort("workday", [PY.workday_deferred_noop], wd, NOW);
    expect(r.state).toBe("deferred_noop");
    expect(r.sources.deferred).toEqual(["workday:nvidia"]);
    expect(r.sources.failed).toEqual([]);
  });

  it("no report: failed cohort, every source insufficient (not stale, not healthy)", () => {
    const r = evaluatePythonCohort("workday", [PY.workday_no_report], wd, NOW);
    expect(r.state).toBe("failed");
    expect(r.sources.insufficient_evidence).toEqual(["workday:cisco", "workday:nvidia", "workday:walmart"]);
  });

  it("stale and never-seen sources", () => {
    const old = { ...PY.non_workday_ok, finished_at: at(-30), started_at: at(-30.2) };
    const recent = { ...PY.non_workday_ok, finished_at: at(-1), started_at: at(-1.2),
      per_source_counts: { amazon: 2, python_run: (PY.non_workday_ok.per_source_counts as any).python_run } };
    const exp = { ...nw, expectedSources: ["amazon", "greenhouse:stripe", "microsoft"] };
    const r = evaluatePythonCohort("non-workday", [old, recent], exp, NOW);
    expect(r.sources.healthy).toEqual(["amazon"]);
    expect(r.sources.stale).toEqual(["greenhouse:stripe"]);
    expect(r.sources.never_seen).toEqual(["microsoft"]);
    expect(r.severity).toBe("degraded");
  });

  it("not configured is never healthy", () => {
    const r = evaluatePythonCohort("workday", [PY.workday_incomplete_and_deferred], { ...wd, expectedSources: [] }, NOW);
    expect([r.state, r.severity]).toEqual(["not_configured", "unavailable"]);
  });
});

describe("evaluateIngestionMonitoring exit codes", () => {
  const healthyPy = [PY.non_workday_ok, { ...PY.non_workday_ok, per_source_counts: {
    "workday:nvidia": 1, "workday:walmart": 2, "workday:cisco": 0,
    python_run: { pipeline: "python", cohort: "workday", outcome: "ok", exit_code: "0", sources: {}, deferred: {} } } }];

  it("0 only when both pipelines and every cohort are healthy", () => {
    const r = evaluateIngestionMonitoring([...TS_ROWS, ...healthyPy], config(), NOW);
    expect(r.checks.map((c) => [c.scope, c.severity])).toEqual([["cycles", "ok"], ["sources", "ok"], ["cohort:non-workday", "ok"], ["cohort:workday", "ok"]]);
    expect([r.status, r.exitCode]).toEqual(["healthy", 0]);
  });

  it("1 for degraded (stale TS source) and degraded wins over unavailable", () => {
    const staleTs = [tsShard("c0", 0, 40, { "greenhouse-a": 1 }), tsShard("c0", 1, 40, { "lever-b": 1 }), tsShard("c1", 0, 2, { "lever-b": 1 }), tsShard("c1", 1, 2, { "greenhouse-c": 1 })];
    const r = evaluateIngestionMonitoring([...staleTs, PY.non_workday_ok, PY.workday_incomplete_and_deferred], config(), NOW);
    const sources = r.checks.find((c) => c.scope === "sources")!;
    expect(sources.state).toBe("degraded");
    expect(sources.sources!.stale).toEqual(["greenhouse-a"]);
    expect(r.checks.find((c) => c.scope === "cohort:workday")!.severity).toBe("unavailable");
    expect([r.status, r.exitCode]).toEqual(["degraded", 1]);
  });

  it("2 when evidence is only insufficient/incomplete, truncated, or not configured", () => {
    expect(evaluateIngestionMonitoring([...TS_ROWS, PY.non_workday_ok, PY.workday_incomplete_and_deferred], config(), NOW).exitCode).toBe(2);
    expect(evaluateIngestionMonitoring([...TS_ROWS, ...healthyPy], { ...config(), evidenceTruncated: true }, NOW).exitCode).toBe(2);
    expect(evaluateIngestionMonitoring([...TS_ROWS, ...healthyPy], config({ python: null }), NOW).exitCode).toBe(2);
    expect(evaluateIngestionMonitoring([...TS_ROWS, ...healthyPy], config({ typescript: null }), NOW).exitCode).toBe(2);
  });

  it("negative control: missing Python coverage fails even when TypeScript is healthy", () => {
    const r = evaluateIngestionMonitoring(TS_ROWS, config(), NOW);
    expect(r.checks.filter((c) => c.pipeline === "python").map((c) => c.state)).toEqual(["missing", "missing"]);
    expect(r.exitCode).toBe(1);
  });

  it("negative control: bypassing freshness would call a silently missing source healthy", () => {
    // lever-b silently absent; every row still names its sources (a row naming none is "blind" -> insufficient instead)
    const rows = [tsShard("c1", 0, 2, { "greenhouse-a": 3 }), tsShard("c1", 1, 2, { "greenhouse-c": 2 })];
    expect(evaluateSourceHealth(rows, { maxFailuresInWindow: 1, staleAfterHours: 12 }, NOW).status).toBe("healthy");
    const r = evaluateIngestionMonitoring([...rows, ...healthyPy], config(), NOW);
    expect(r.checks.find((c) => c.scope === "sources")!.sources!.never_seen).toEqual(["lever-b"]);
    expect(r.exitCode).toBe(1);
  });

  it("unconfigured cohort rows are reported, not counted", () => {
    const stray = { ...PY.non_workday_ok, per_source_counts: { python_run: { pipeline: "python", cohort: "custom", outcome: "ok" } } };
    const r = evaluateIngestionMonitoring([...TS_ROWS, ...healthyPy, stray], config(), NOW);
    expect(r.checks.find((c) => c.state === "unexpected_cohort")).toBeTruthy();
    expect(r.exitCode).toBe(2);
  });

  it("summary lists states and IDs only, no URLs, and says alert delivery is unproven", () => {
    const text = renderMonitoringSummary(evaluateIngestionMonitoring([...TS_ROWS, PY.non_workday_failed], config(), NOW));
    expect(text).toContain("cohort:non-workday");
    expect(text).toContain("greenhouse:stripe");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain("not proof anyone received an alert");
  });
});

describe("check-source-health evidence window", () => {
  const many = Array.from({ length: 120 }, (_, i) => tsShard(`c${i}`, 0, i / 10, i === 110 ? { "lever-b": 1 } : { "greenhouse-a": 1 }));

  it("pages past the old 50-row limit, so an expected source is not hidden", async () => {
    const calls: Array<[number, number]> = [];
    const { rows, truncated } = await fetchRunsWindow(async (from, to) => {
      calls.push([from, to]);
      return { data: many.slice(from, to + 1), error: null };
    }, 50, 10_000);
    expect(calls).toEqual([[0, 49], [50, 99], [100, 149]]);
    expect([rows.length, truncated]).toEqual([120, false]);
    expect(evaluateSourceFreshness(rows, { expectedSources: ["lever-b"], sourceStaleAfterHours: 24 }, NOW).neverSeenSources).toEqual([]);
    // negative control: the first 50 rows alone (the old .limit(50)) never see lever-b
    expect(evaluateSourceFreshness(many.slice(0, 50), { expectedSources: ["lever-b"], sourceStaleAfterHours: 24 }, NOW).neverSeenSources).toEqual(["lever-b"]);
  });

  it("reports truncation instead of silently dropping rows, and surfaces query errors", async () => {
    const r = await fetchRunsWindow(async (from, to) => ({ data: many.slice(from, to + 1), error: null }), 50, 100);
    expect([r.rows.length, r.truncated]).toEqual([100, true]);
    await expect(fetchRunsWindow(async () => ({ data: null, error: { message: "boom" } }))).rejects.toThrow("ingest_runs query failed: boom");
  });

  it("runCheck evaluates both pipelines from checked-in configuration (mocked read, no network)", async () => {
    const result = await runCheck(async () => ({ data: [...TS_ROWS, PY.non_workday_ok], error: null }), NOW,
      loadMonitoringConfig(ROOT, { PY_HEALTH_RECORD: "true" }));
    expect(result.checks.map((c) => c.scope)).toEqual(["cycles", "sources", "cohort:non-workday", "cohort:workday"]);
    expect(result.checks.find((c) => c.scope === "cohort:workday")!.state).toBe("missing");
    expect(result.exitCode).toBe(1);
  });
});

describe("checked-in configuration and workflow windows", () => {
  const wf = (name: string) => fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8");

  it("expected sources come from the checked-in seed and cohort files", () => {
    const cfg = loadMonitoringConfig(ROOT);
    const scheduled = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/config/companies-scheduled.json"), "utf8"));
    expect(cfg.typescript!.expectedSources).toEqual(scheduled.filter((s: any) => s.enabled).map((s: any) => s.id));
    const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/scraper/expected_sources.json"), "utf8"));
    expect(Object.keys(cfg.python!).sort()).toEqual(["non-workday", "workday"]);
    expect(cfg.python!.workday.expectedSources).toEqual(expected.cohorts.workday);
    expect(cfg.python!["non-workday"].expectedSources).toEqual(expected.cohorts["non-workday"]);
  });

  it("missing configuration is not_configured (exit 2), never healthy", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sh-"));
    const cfg = loadMonitoringConfig(empty, {});
    expect([cfg.typescript, cfg.python, cfg.pythonRecording]).toEqual([null, null, false]);
    expect(evaluateIngestionMonitoring(TS_ROWS, cfg, NOW).exitCode).toBe(2);
  });

  it("windows match the schedules of the workflows they watch", () => {
    expect(wf("ingest.yml")).toContain("cron: '17 */4 * * *'");
    expect(wf("python-ingest.yml")).toContain("cron: '47 2-23/4 * * *'");
    const py = wf("python-ingest.yml");
    const cadence = Number(/CADENCE_MINUTES:\s*"(\d+)"/.exec(py)![1]);
    const grace = Number(/OVERDUE_GRACE_MINUTES:\s*"(\d+)"/.exec(py)![1]);
    expect(cadence).toBe(240);
    expect(PY_COHORT_OVERDUE_AFTER_HOURS * 60).toBeGreaterThanOrEqual(cadence + grace); // never before the watchdog's catch-up
    expect(PY_COHORT_OVERDUE_AFTER_HOURS).toBeGreaterThanOrEqual(12); // observed GitHub delivery gap (11.3h)
    expect(TS_SOURCE_STALE_AFTER_HOURS).toBeGreaterThanOrEqual(2 * 12); // two lost 12h gaps of 4h cycles
    expect(PY_SOURCE_STALE_AFTER_HOURS["non-workday"]).toBeGreaterThanOrEqual(2 * 12);
    expect(LOOKBACK_HOURS).toBeGreaterThan(Math.max(...Object.values(PY_SOURCE_STALE_AFTER_HOURS), TS_SOURCE_STALE_AFTER_HOURS));
    expect(TS_CYCLE_ROW_WINDOW).toBe(50); // unchanged cycle-health input
    expect(wf("source-health-cron.yml")).toContain("cron: '30 4 * * *'");
  });

  it("alerting stays on the existing workflow-failure path for both workflows", () => {
    const alert = wf("workflow-failure-alert.yml");
    expect(alert).toContain('- "Source Health Monitoring"');
    expect(alert).toContain('- "Python Job Ingestion (every 4 hours)"');
    expect(wf("source-health-cron.yml")).toContain("npx tsx scripts/check-source-health.ts");
  });
});

describe("PY_HEALTH_RECORD gate (one policy: workflow == 'true' is case-insensitive, no trim)", () => {
  it.each([["true", true], ["TRUE", true], ["True", true], [undefined, false], ["", false], ["false", false], ["yes", false], [" true", false], ["true ", false], ["1", false]])(
    "PY_HEALTH_RECORD=%j -> recording %s, through loadMonitoringConfig",
    (value, on) => {
      expect(pythonHealthRecordingEnabled(value as string | undefined)).toBe(on);
      const env = value === undefined ? {} : { PY_HEALTH_RECORD: value as string };
      expect(loadMonitoringConfig(ROOT, env).pythonRecording).toBe(on);
    }
  );

  it("off: Python cohorts and stray rows are skipped, reported as not_monitored, never as healthy Python", () => {
    const stray = { ...PY.non_workday_ok, per_source_counts: { python_run: { pipeline: "python", cohort: "custom", outcome: "ok" } } };
    for (const off of [undefined, false]) {
      const r = evaluateIngestionMonitoring([...TS_ROWS, PY.non_workday_failed, stray], config({ pythonRecording: off }), NOW);
      expect(r.checks.filter((c) => c.pipeline === "python")).toEqual([
        { pipeline: "python", scope: "pipeline", state: "not_monitored", severity: "ok",
          reason: "Python health recording is off (PY_HEALTH_RECORD is not true): Python cohorts are NOT MONITORED." }]);
      expect(r.python).toEqual([]);
      expect(r.notMonitored).toEqual(["python"]);
      expect([r.status, r.exitCode]).toEqual(["healthy", 0]);
      const text = renderMonitoringSummary(r);
      expect(text.split("\n")[0]).toBe("## Source health: HEALTHY - TypeScript only, python NOT MONITORED (exit 0)");
      expect(notMonitoredNotice(r)).toMatch(/^::notice title=Python ingestion NOT MONITORED::/);
      expect(healthyStatusLine(r)).toBe("TypeScript healthy; Python NOT MONITORED");
    }
  });

  it("off: TypeScript failures still fail", () => {
    const failedTs = [tsShard("c1", 0, 2, { "greenhouse-a": 3 }, "failed"), tsShard("c1", 1, 2, { "lever-b": 1 })];
    const r = evaluateIngestionMonitoring(failedTs, config({ pythonRecording: false }), NOW);
    expect([r.status, r.exitCode, r.notMonitored]).toEqual(["degraded", 1, ["python"]]);
    expect(renderMonitoringSummary(r).split("\n")[0]).toBe("## Source health: DEGRADED - python NOT MONITORED (exit 1)");
  });

  it("on: Python is judged and the summary/last line claim both pipelines", () => {
    const r = evaluateIngestionMonitoring(TS_ROWS, config({ pythonRecording: true }), NOW);
    expect(r.notMonitored).toEqual([]);
    expect(r.checks.filter((c) => c.pipeline === "python").map((c) => c.state)).toEqual(["missing", "missing"]);
    expect(notMonitoredNotice(r)).toBeNull();
    expect(healthyStatusLine({ ...r, notMonitored: [] })).toBe("Source health is healthy.");
  });

  it("workflows: writer gated on the variable, checker receives it", () => {
    const wf = (name: string) => fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8");
    const step = wf("python-ingest.yml").split("- name: Record run health")[1].split("- name:")[0];
    expect(step).toContain("if: always() && needs.plan.outputs.mode == 'write-production-expire' && vars.PY_HEALTH_RECORD == 'true'");
    expect(wf("source-health-cron.yml")).toContain("PY_HEALTH_RECORD: ${{ vars.PY_HEALTH_RECORD }}");
  });
});
