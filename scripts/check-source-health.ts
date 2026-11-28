/** Scheduled source-health gate over BOTH ingestion pipelines (rows 46/78): service-role read of ingest_runs.
 *
 *   TypeScript (scripts/ingest.ts, ingest.yml): shard-cycle health (evaluateSourceHealth, unchanged policy) and
 *     per-source freshness (evaluateSourceFreshness) against scripts/config/companies-scheduled.json.
 *   Python (scripts/scraper/run_ingestion.py, python-ingest.yml): one row per cohort run written by
 *     scripts/scraper/health_record.py; per-cohort missing/overdue/failed and per-source freshness against
 *     scripts/scraper/expected_sources.json (generated from company_seeds.json by the runner's own planner).
 *
 * Exit 0 healthy, 1 degraded (stale, never-seen, failed, missing or overdue), 2 evidence unavailable,
 * insufficient, truncated or not configured; never 0 silently. Alert delivery stays on the existing
 * workflow-failure-alert.yml path; a failed run there is not proof that anyone received an alert. */
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  evaluateIngestionMonitoring,
  pythonHealthRecordingEnabled,
  renderMonitoringSummary,
  type IngestRunSnapshot,
  type MonitoringConfig,
  type MonitoringResult,
} from "../src/lib/observability/sourceHealth";

const MAX_FAILURES_IN_WINDOW = 1;
const STALE_AFTER_HOURS = Number(process.env.SOURCE_HEALTH_STALE_HOURS) || 12; // GitHub delivers only 2-3 of the 6 daily 4h ingest slots; healthy gaps reached 11.3h (week of 2026-11-15), so 8h false-alarmed.

// Windows, derived from the workflows they watch (pinned by src/lib/__tests__/sourceMonitoring.test.ts):
// - ingest.yml runs every 4h ('17 */4 * * *'); each scheduled board is in exactly one of 12 shards per cycle,
//   so a board is seen once per delivered cycle. With delivery gaps up to the 12h above, 24h = two lost cycles.
export const TS_SOURCE_STALE_AFTER_HOURS = 24;
// - python-ingest.yml runs both cohorts every 4h ('47 2-23/4 * * *'); its watchdog catches up after 240+45 min.
//   12h matches the observed GitHub delivery gap, so a working pipeline is never flagged overdue.
export const PY_COHORT_OVERDUE_AFTER_HOURS = 12;
// - non-Workday sources run every cohort run: two lost 12h gaps.
// - Workday: at most 4 of 7 boards per run, 3h minimum interval, failure backoff capped at 24h
//   (workday_schedule.limits()); 24h cap + 2 rotation runs (8h) + 12h delivery gap + margin = 72h.
export const PY_SOURCE_STALE_AFTER_HOURS: Record<string, number> = { "non-workday": 24, workday: 72 };
// Lookback covers the longest window (72h) with margin; paginated so no expected source is cut off by a row limit.
export const LOOKBACK_HOURS = 7 * 24;
export const PAGE_SIZE = 1000;
export const MAX_ROWS = 10_000;
export const PAGE_TIMEOUT_MS = 20_000;
// evaluateSourceHealth keeps judging the newest 50 TypeScript rows, exactly as before this change.
export const TS_CYCLE_ROW_WINDOW = 50;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Expected sources come only from checked-in configuration; anything missing becomes not_configured.
 * Python is judged only when PY_HEALTH_RECORD (repo variable, passed by source-health-cron.yml) enables the writer. */
export function loadMonitoringConfig(root = REPO_ROOT, env: Record<string, string | undefined> = process.env): MonitoringConfig {
  const scheduled = readJson(path.join(root, "scripts", "config", "companies-scheduled.json"));
  const tsSources = Array.isArray(scheduled)
    ? scheduled.filter((s) => s && s.enabled && typeof s.id === "string").map((s) => s.id as string)
    : [];
  const expected = readJson(path.join(root, "scripts", "scraper", "expected_sources.json")) as
    | { cohorts?: Record<string, unknown> }
    | null;
  const python: MonitoringConfig["python"] = {};
  for (const [cohort, list] of Object.entries(expected?.cohorts || {})) {
    if (!Array.isArray(list)) continue;
    python[cohort] = {
      expectedSources: list.filter((s): s is string => typeof s === "string"),
      sourceStaleAfterHours: PY_SOURCE_STALE_AFTER_HOURS[cohort] ?? 24,
      overdueAfterHours: PY_COHORT_OVERDUE_AFTER_HOURS,
    };
  }
  return {
    typescript: tsSources.length
      ? {
          health: { maxFailuresInWindow: MAX_FAILURES_IN_WINDOW, staleAfterHours: STALE_AFTER_HOURS },
          expectedSources: tsSources,
          sourceStaleAfterHours: TS_SOURCE_STALE_AFTER_HOURS,
          cycleRowWindow: TS_CYCLE_ROW_WINDOW,
        }
      : null,
    python: Object.keys(python).length ? python : null,
    pythonRecording: pythonHealthRecordingEnabled(env.PY_HEALTH_RECORD),
  };
}

export type FetchPage = (from: number, to: number) => Promise<{ data: IngestRunSnapshot[] | null; error: { message: string } | null }>;

/** Every row in the lookback, newest first, in bounded pages. truncated=true when MAX_ROWS stops it early. */
export async function fetchRunsWindow(fetchPage: FetchPage, pageSize = PAGE_SIZE, maxRows = MAX_ROWS): Promise<{ rows: IngestRunSnapshot[]; truncated: boolean }> {
  const rows: IngestRunSnapshot[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await fetchPage(from, Math.min(from + pageSize, maxRows) - 1);
    if (error) throw new Error(`ingest_runs query failed: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function runCheck(fetchPage: FetchPage, nowIso: string, config = loadMonitoringConfig()) {
  const { rows, truncated } = await fetchRunsWindow(fetchPage);
  return evaluateIngestionMonitoring(rows, { ...config, evidenceTruncated: truncated }, nowIso);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase service-role env is required.");

  const client = createClient(url, key);
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000).toISOString();
  const fetchPage: FetchPage = async (from, to) => {
    const { data, error } = await client
      .from("ingest_runs")
      .select("id,started_at,finished_at,status,per_source_counts")
      .gte("finished_at", since)
      .order("finished_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
      .abortSignal(AbortSignal.timeout(PAGE_TIMEOUT_MS));
    return { data: (data as IngestRunSnapshot[] | null) ?? null, error: error ? { message: error.message } : null };
  };

  const result = await runCheck(fetchPage, now.toISOString());
  const summary = renderMonitoringSummary(result);
  console.log(JSON.stringify(result));
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  const notice = notMonitoredNotice(result);
  if (notice) console.log(notice);
  const worst = result.checks.filter((c) => c.severity !== "ok").map((c) => `${c.pipeline}/${c.scope}: ${c.state}`).join("; ");
  if (result.exitCode === 1) {
    console.error(`[SOURCE-HEALTH-ALERT] ${worst}`);
    process.exit(1);
  }
  if (result.exitCode === 2) {
    console.error(`[SOURCE-HEALTH-UNAVAILABLE] ${worst}`);
    process.exit(2);
  }
  console.log(healthyStatusLine(result));
}

/** GitHub ::notice when Python is deliberately not judged (writer off). */
export function notMonitoredNotice(result: MonitoringResult): string | null {
  return result.notMonitored.includes("python")
    ? "::notice title=Python ingestion NOT MONITORED::PY_HEALTH_RECORD is not true, so no Python health rows are written and Python cohorts are not judged."
    : null;
}

/** Last line on exit 0, scope-aware so no log tail reads as overall healthy while Python is not monitored. */
export function healthyStatusLine(result: MonitoringResult): string {
  return result.notMonitored.includes("python") ? "TypeScript healthy; Python NOT MONITORED" : "Source health is healthy.";
}

const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error("[SOURCE-HEALTH-UNAVAILABLE]", error.message || error);
    process.exit(2);
  });
}
