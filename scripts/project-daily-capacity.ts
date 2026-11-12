/**
 * scripts/project-daily-capacity.ts
 *
 * READ-ONLY capacity projection script auditing CareerMonke's active fleet of scheduled ATS boards.
 *
 * For each enabled board in scripts/config/companies-scheduled.json (Greenhouse, Ashby, Lever):
 * 1. Fetches public job listings via official public ATS APIs.
 * 2. Parses and counts jobs posted or updated in the trailing 24 hours where the ATS exposes dates.
 * 3. Flags boards with zero date-able jobs.
 * 4. Extrapolates fleet-wide daily NEW-jobs supply against the 1,200 new jobs/day target.
 * 5. Generates reports/daily-capacity-projection.md with run date, explicit verdict line,
 *    and per-ATS / per-board empirical breakdowns.
 *
 * Flags:
 *   --dry-run      Print planned execution without making any network calls.
 *   --limit <n>    Limit the number of boards sampled/fetched.
 *   --ats <type>   Filter to a single ATS type (greenhouse, ashby, lever).
 *   --delay <ms>   Polite inter-request delay in milliseconds (default: 75ms).
 *   --output <p>   Path to output report markdown (default: reports/daily-capacity-projection.md).
 *   --target <n>   Daily new-jobs target (default: 1200).
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types and Interfaces
// =============================================================================

export type AtsType = 'greenhouse' | 'ashby' | 'lever';

export const SUPPORTED_ATS_TYPES: AtsType[] = ['greenhouse', 'ashby', 'lever'];
export const DEFAULT_CONFIG_PATH = path.join('scripts', 'config', 'companies-scheduled.json');
export const DEFAULT_REPORT_PATH = path.join('reports', 'daily-capacity-projection.md');
export const DEFAULT_TARGET_DAILY_JOBS = 1200;
export const DEFAULT_DELAY_MS = 75; // Polite ~13 req/sec overall, strictly 1 req per company
export const DEFAULT_TIMEOUT_MS = 10000;
export const TRAILING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ScheduledCompany {
  id: string;
  name: string;
  type: AtsType | string;
  target: string;
  enabled: boolean;
}

export interface BoardCapacityMetrics {
  id: string;
  name: string;
  ats: AtsType;
  target: string;
  totalOpenJobs: number;
  dateableJobs: number;
  jobsTrailing24h: number;
  zeroDateableJobs: boolean;
  error?: string;
  status: 'ok' | 'zero_dateable' | 'error';
}

export interface AtsCapacityProjection {
  ats: AtsType;
  fleetTotalBoards: number;
  sampledBoards: number;
  successfulBoards: number;
  failedBoards: number;
  boardsWithDateableJobs: number;
  boardsWithZeroDateableJobs: number;
  totalOpenJobsSampled: number;
  totalJobsTrailing24hSampled: number;
  avgNewJobsPerBoardPerDay: number;
  extrapolatedDailyCapacity: number;
  extrapolatedOpenInventory: number;
  turnoverRatePct: number;
}

export interface FleetCapacityReport {
  runDate: string;
  nowEpochMs: number;
  trailingWindowHours: number;
  fleetTargetPerDay: number;
  totalFleetBoards: number;
  totalSampledBoards: number;
  totalSuccessfulBoards: number;
  totalFailedBoards: number;
  totalBoardsWithDateableJobs: number;
  totalBoardsWithZeroDateableJobs: number;
  sampledOpenJobs: number;
  sampledJobsTrailing24h: number;
  extrapolatedFleetDailyCapacity: number;
  extrapolatedFleetOpenInventory: number;
  fleetTurnoverRatePct: number;
  perAts: Record<AtsType, AtsCapacityProjection>;
  boards: BoardCapacityMetrics[];
  verdict: {
    targetDailyJobs: number;
    projectedDailyJobs: number;
    surplusOrDeficit: number;
    status: 'ACHIEVED' | 'DEFICIT';
    verdictLine: string;
  };
}

export interface CapacityCliOptions {
  dryRun: boolean;
  limit?: number;
  atsFilter?: AtsType;
  delayMs: number;
  configPath: string;
  outputPath: string;
  targetDailyJobs: number;
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

export function parseCapacityCliArgs(argv: string[]): CapacityCliOptions {
  let dryRun = false;
  let limit: number | undefined;
  let atsFilter: AtsType | undefined;
  let delayMs = DEFAULT_DELAY_MS;
  let configPath = DEFAULT_CONFIG_PATH;
  let outputPath = DEFAULT_REPORT_PATH;
  let targetDailyJobs = DEFAULT_TARGET_DAILY_JOBS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
      i++;
    } else if (arg.startsWith('--limit=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    } else if (arg === '--ats' && argv[i + 1]) {
      const val = argv[i + 1].trim().toLowerCase() as AtsType;
      if (SUPPORTED_ATS_TYPES.includes(val)) {
        atsFilter = val;
      }
      i++;
    } else if (arg.startsWith('--ats=')) {
      const val = arg.split('=')[1].trim().toLowerCase() as AtsType;
      if (SUPPORTED_ATS_TYPES.includes(val)) {
        atsFilter = val;
      }
    } else if (arg === '--delay' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!isNaN(parsed) && parsed >= 0) {
        delayMs = parsed;
      }
      i++;
    } else if (arg.startsWith('--delay=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      if (!isNaN(parsed) && parsed >= 0) {
        delayMs = parsed;
      }
    } else if (arg === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1].trim();
      i++;
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.split('=')[1].trim();
    } else if (arg === '--target' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        targetDailyJobs = parsed;
      }
      i++;
    } else if (arg.startsWith('--target=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        targetDailyJobs = parsed;
      }
    } else if (arg === '--config' && argv[i + 1]) {
      configPath = argv[i + 1].trim();
      i++;
    }
  }

  return {
    dryRun,
    limit,
    atsFilter,
    delayMs,
    configPath,
    outputPath,
    targetDailyJobs,
  };
}

// =============================================================================
// ATS Parsing & Trailing-24h Date Counting
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if a date timestamp falls within the trailing window:
 * [now - windowMs, now + 5min (clock skew tolerance)].
 */
export function isTimestampInTrailingWindow(
  timestampMs: number,
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): boolean {
  if (isNaN(timestampMs)) return false;
  const ageMs = nowMs - timestampMs;
  // Allow up to 5 minutes of future clock drift from upstream servers
  return ageMs >= -5 * 60 * 1000 && ageMs <= windowMs;
}

/**
 * Parses Greenhouse jobs payload:
 * Endpoint returns { jobs: [ { id, title, updated_at, ... } ] }
 */
export function parseGreenhouseJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): { totalJobs: number; dateableJobs: number; jobsTrailing24h: number; zeroDateableJobs: boolean } {
  if (!Array.isArray(jobs)) {
    return { totalJobs: 0, dateableJobs: 0, jobsTrailing24h: 0, zeroDateableJobs: true };
  }

  const validJobs = jobs.filter((j) => j && (j.id != null || j.title));
  let dateableJobs = 0;
  let jobsTrailing24h = 0;

  for (const job of validJobs) {
    if (job.updated_at && typeof job.updated_at === 'string') {
      const parsed = Date.parse(job.updated_at);
      if (!isNaN(parsed)) {
        dateableJobs++;
        if (isTimestampInTrailingWindow(parsed, nowMs, windowMs)) {
          jobsTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: validJobs.length,
    dateableJobs,
    jobsTrailing24h,
    zeroDateableJobs: dateableJobs === 0,
  };
}

/**
 * Parses Ashby jobs payload:
 * Endpoint returns { jobs: [ { id, title, publishedAt, isListed, ... } ] }
 * Excludes unlisted jobs (isListed === false) per public board specification.
 */
export function parseAshbyJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): { totalJobs: number; dateableJobs: number; jobsTrailing24h: number; zeroDateableJobs: boolean } {
  if (!Array.isArray(jobs)) {
    return { totalJobs: 0, dateableJobs: 0, jobsTrailing24h: 0, zeroDateableJobs: true };
  }

  // Filter only publicly listed jobs (isListed !== false)
  const listedJobs = jobs.filter((j) => j && (j.id != null || j.title) && j.isListed !== false);
  let dateableJobs = 0;
  let jobsTrailing24h = 0;

  for (const job of listedJobs) {
    if (job.publishedAt && typeof job.publishedAt === 'string') {
      const parsed = Date.parse(job.publishedAt);
      if (!isNaN(parsed)) {
        dateableJobs++;
        if (isTimestampInTrailingWindow(parsed, nowMs, windowMs)) {
          jobsTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: listedJobs.length,
    dateableJobs,
    jobsTrailing24h,
    zeroDateableJobs: dateableJobs === 0,
  };
}

/**
 * Parses Lever jobs payload:
 * Endpoint returns an array of postings: [ { id, text, createdAt, ... } ]
 * createdAt is an epoch millisecond integer.
 */
export function parseLeverJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): { totalJobs: number; dateableJobs: number; jobsTrailing24h: number; zeroDateableJobs: boolean } {
  if (!Array.isArray(jobs)) {
    return { totalJobs: 0, dateableJobs: 0, jobsTrailing24h: 0, zeroDateableJobs: true };
  }

  const validJobs = jobs.filter((j) => j && (j.id != null || j.text));
  let dateableJobs = 0;
  let jobsTrailing24h = 0;

  for (const job of validJobs) {
    if (typeof job.createdAt === 'number' && !isNaN(job.createdAt) && job.createdAt > 0) {
      dateableJobs++;
      if (isTimestampInTrailingWindow(job.createdAt, nowMs, windowMs)) {
        jobsTrailing24h++;
      }
    } else if (typeof job.createdAt === 'string') {
      const parsed = Date.parse(job.createdAt);
      if (!isNaN(parsed)) {
        dateableJobs++;
        if (isTimestampInTrailingWindow(parsed, nowMs, windowMs)) {
          jobsTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: validJobs.length,
    dateableJobs,
    jobsTrailing24h,
    zeroDateableJobs: dateableJobs === 0,
  };
}

// =============================================================================
// Network Fetching (Public APIs Only, Polite Rate Limiting)
// =============================================================================

async function fetchWithTimeout(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CareerMonkeCapacityProjector/1.0 (Polite-Fleet-Audit)',
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGreenhouseBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  return await fetchWithTimeout(url, timeoutMs);
}

export async function fetchAshbyBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  return await fetchWithTimeout(url, timeoutMs);
}

export async function fetchLeverBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  // Try primary global endpoint first; fallback to EU endpoint if needed
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    return await fetchWithTimeout(url, timeoutMs);
  } catch (_err: any) {
    const euUrl = `https://api.eu.lever.co/v0/postings/${slug}?mode=json`;
    return await fetchWithTimeout(euUrl, timeoutMs);
  }
}

// =============================================================================
// Extrapolation & Capacity Projection Math
// =============================================================================

/**
 * Pure calculation engine computing per-ATS and fleet-wide capacity projections.
 * Strictly avoids invented numbers; extrapolates empirically based on observed trailing 24h rates.
 */
export function calculateCapacityProjections(
  boards: BoardCapacityMetrics[],
  fleetEnabledCounts: Record<AtsType, number>,
  targetDailyJobs: number = DEFAULT_TARGET_DAILY_JOBS,
  nowEpochMs: number = Date.now()
): FleetCapacityReport {
  const atsList: AtsType[] = ['greenhouse', 'ashby', 'lever'];
  const perAts: Record<AtsType, AtsCapacityProjection> = {} as any;

  let totalFleetBoards = 0;
  let totalSampledBoards = 0;
  let totalSuccessfulBoards = 0;
  let totalFailedBoards = 0;
  let totalBoardsWithDateableJobs = 0;
  let totalBoardsWithZeroDateableJobs = 0;
  let sampledOpenJobs = 0;
  let sampledJobsTrailing24h = 0;
  let extrapolatedFleetDailyCapacity = 0;
  let extrapolatedFleetOpenInventory = 0;

  for (const ats of atsList) {
    const fleetTotal = fleetEnabledCounts[ats] || 0;
    totalFleetBoards += fleetTotal;

    const atsBoards = boards.filter((b) => b.ats === ats);
    const sampled = atsBoards.length;
    totalSampledBoards += sampled;

    const successful = atsBoards.filter((b) => b.status !== 'error').length;
    const failed = atsBoards.filter((b) => b.status === 'error').length;
    totalSuccessfulBoards += successful;
    totalFailedBoards += failed;

    const dateableCount = atsBoards.filter((b) => !b.zeroDateableJobs && b.status !== 'error').length;
    const zeroDateableCount = atsBoards.filter((b) => b.zeroDateableJobs && b.status !== 'error').length;
    totalBoardsWithDateableJobs += dateableCount;
    totalBoardsWithZeroDateableJobs += zeroDateableCount;

    const atsOpenJobs = atsBoards.reduce((sum, b) => sum + (b.totalOpenJobs || 0), 0);
    const atsTrailing24h = atsBoards.reduce((sum, b) => sum + (b.jobsTrailing24h || 0), 0);
    sampledOpenJobs += atsOpenJobs;
    sampledJobsTrailing24h += atsTrailing24h;

    // Daily rate per board
    const avgNewJobs = successful > 0 ? Number((atsTrailing24h / successful).toFixed(3)) : 0;

    // Extrapolate to fleet
    let extrapolatedCapacity: number;
    let extrapolatedInventory: number;

    if (successful === 0) {
      extrapolatedCapacity = 0;
      extrapolatedInventory = 0;
    } else if (successful === fleetTotal) {
      // 100% of fleet sampled: exact sum, no scaling rounding error
      extrapolatedCapacity = atsTrailing24h;
      extrapolatedInventory = atsOpenJobs;
    } else {
      // Proportional extrapolation
      extrapolatedCapacity = Math.round((atsTrailing24h / successful) * fleetTotal);
      extrapolatedInventory = Math.round((atsOpenJobs / successful) * fleetTotal);
    }

    extrapolatedFleetDailyCapacity += extrapolatedCapacity;
    extrapolatedFleetOpenInventory += extrapolatedInventory;

    const turnoverPct =
      atsOpenJobs > 0 ? Number(((atsTrailing24h / atsOpenJobs) * 100).toFixed(2)) : 0;

    perAts[ats] = {
      ats,
      fleetTotalBoards: fleetTotal,
      sampledBoards: sampled,
      successfulBoards: successful,
      failedBoards: failed,
      boardsWithDateableJobs: dateableCount,
      boardsWithZeroDateableJobs: zeroDateableCount,
      totalOpenJobsSampled: atsOpenJobs,
      totalJobsTrailing24hSampled: atsTrailing24h,
      avgNewJobsPerBoardPerDay: avgNewJobs,
      extrapolatedDailyCapacity: extrapolatedCapacity,
      extrapolatedOpenInventory: extrapolatedInventory,
      turnoverRatePct: turnoverPct,
    };
  }

  const fleetTurnoverRatePct =
    sampledOpenJobs > 0 ? Number(((sampledJobsTrailing24h / sampledOpenJobs) * 100).toFixed(2)) : 0;

  const surplusOrDeficit = extrapolatedFleetDailyCapacity - targetDailyJobs;
  const status: 'ACHIEVED' | 'DEFICIT' =
    extrapolatedFleetDailyCapacity >= targetDailyJobs ? 'ACHIEVED' : 'DEFICIT';

  const verdictWord = status === 'ACHIEVED' ? 'TARGET ACHIEVED' : 'CAPACITY DEFICIT';
  const diffSign = surplusOrDeficit >= 0 ? '+' : '';
  const verdictLine = `**Verdict**: Projected fleet daily capacity is ~${extrapolatedFleetDailyCapacity.toLocaleString()} new jobs/day vs target ${targetDailyJobs.toLocaleString()} jobs/day (${verdictWord}: ${diffSign}${surplusOrDeficit.toLocaleString()} jobs/day).`;

  const runDate = new Date(nowEpochMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return {
    runDate,
    nowEpochMs,
    trailingWindowHours: 24,
    fleetTargetPerDay: targetDailyJobs,
    totalFleetBoards,
    totalSampledBoards,
    totalSuccessfulBoards,
    totalFailedBoards,
    totalBoardsWithDateableJobs,
    totalBoardsWithZeroDateableJobs,
    sampledOpenJobs,
    sampledJobsTrailing24h,
    extrapolatedFleetDailyCapacity,
    extrapolatedFleetOpenInventory,
    fleetTurnoverRatePct,
    perAts,
    boards,
    verdict: {
      targetDailyJobs,
      projectedDailyJobs: extrapolatedFleetDailyCapacity,
      surplusOrDeficit,
      status,
      verdictLine,
    },
  };
}

// =============================================================================
// Markdown Report Generator
// =============================================================================

export function generateMarkdownReport(report: FleetCapacityReport): string {
  const { verdict, perAts, boards } = report;

  const zeroDateableBoards = boards.filter((b) => b.zeroDateableJobs && b.status !== 'error');
  const errorBoards = boards.filter((b) => b.status === 'error');
  const topActiveBoards = [...boards]
    .filter((b) => b.jobsTrailing24h > 0)
    .sort((a, b) => b.jobsTrailing24h - a.jobsTrailing24h)
    .slice(0, 20);

  return `# CareerMonke Fleet Daily Ingestion Capacity Projection

**Audit Run Date**: ${report.runDate}  
**Fleet Schedule Scope**: ${report.totalFleetBoards} enabled ATS company boards (6-shard partition, polled every 4 hours)  
**Sampled Scope**: ${report.totalSampledBoards} of ${report.totalFleetBoards} boards (${report.totalSuccessfulBoards} successful, ${report.totalFailedBoards} errors)  
**Sampling Window**: Trailing 24 hours ($T_{\\text{now}} - 24\\text{h} \\le T_{\\text{job}} \\le T_{\\text{now}}$)  

---

## 1. Executive Summary & Verdict

${verdict.verdictLine}

| Metric | Target | Projected Fleet Value | Status |
| :--- | :--- | :--- | :--- |
| **Daily NEW Jobs Supply** | **${report.fleetTargetPerDay.toLocaleString()} / day** | **~${report.extrapolatedFleetDailyCapacity.toLocaleString()} / day** | **${verdict.status === 'ACHIEVED' ? '✅ TARGET ACHIEVED' : '⚠️ DEFICIT'}** |
| **Surplus / Deficit** | — | ${verdict.surplusOrDeficit >= 0 ? `+${verdict.surplusOrDeficit.toLocaleString()}` : `${verdict.surplusOrDeficit.toLocaleString()}`} jobs/day | ${verdict.status === 'ACHIEVED' ? 'Surplus' : 'Under Target'} |
| **Fleet Open Job Inventory** | — | ~${report.extrapolatedFleetOpenInventory.toLocaleString()} total active listings | Baseline Pool |
| **Trailing 24h Turnover Rate** | — | ${report.fleetTurnoverRatePct}% | % of inventory refreshed daily |
| **Fleet Coverage** | 438 boards | ${report.totalSampledBoards} / ${report.totalFleetBoards} boards checked | 6-shard fleet |

> [!IMPORTANT]
> **Empirical Estimation Notice**: All figures in this report are empirical estimates extrapolated directly from public ATS timestamps observed during this audit run. No synthetic or invented numbers are used.
> - **Greenhouse**: Exposes \`updated_at\` (reflects newly opened positions as well as requisition edits/refreshes).
> - **Ashby**: Exposes \`publishedAt\` on publicly listed postings (\`isListed !== false\`).
> - **Lever**: Exposes \`createdAt\` (precise requisition creation timestamp).

---

## 2. Per-ATS Platform Breakdown

| ATS Platform | Fleet Total Boards | Sampled Boards | Boards w/ Date-able Jobs | Boards w/ Zero Date-able Jobs | Sampled Open Jobs | Trailing 24h Jobs | Avg New Jobs / Board | Extrapolated Daily Jobs | Turnover Rate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Greenhouse** | ${perAts.greenhouse.fleetTotalBoards} | ${perAts.greenhouse.sampledBoards} | ${perAts.greenhouse.boardsWithDateableJobs} | ${perAts.greenhouse.boardsWithZeroDateableJobs} | ${perAts.greenhouse.totalOpenJobsSampled.toLocaleString()} | ${perAts.greenhouse.totalJobsTrailing24hSampled.toLocaleString()} | ${perAts.greenhouse.avgNewJobsPerBoardPerDay} | **~${perAts.greenhouse.extrapolatedDailyCapacity.toLocaleString()}** | ${perAts.greenhouse.turnoverRatePct}% |
| **Ashby** | ${perAts.ashby.fleetTotalBoards} | ${perAts.ashby.sampledBoards} | ${perAts.ashby.boardsWithDateableJobs} | ${perAts.ashby.boardsWithZeroDateableJobs} | ${perAts.ashby.totalOpenJobsSampled.toLocaleString()} | ${perAts.ashby.totalJobsTrailing24hSampled.toLocaleString()} | ${perAts.ashby.avgNewJobsPerBoardPerDay} | **~${perAts.ashby.extrapolatedDailyCapacity.toLocaleString()}** | ${perAts.ashby.turnoverRatePct}% |
| **Lever** | ${perAts.lever.fleetTotalBoards} | ${perAts.lever.sampledBoards} | ${perAts.lever.boardsWithDateableJobs} | ${perAts.lever.boardsWithZeroDateableJobs} | ${perAts.lever.totalOpenJobsSampled.toLocaleString()} | ${perAts.lever.totalJobsTrailing24hSampled.toLocaleString()} | ${perAts.lever.avgNewJobsPerBoardPerDay} | **~${perAts.lever.extrapolatedDailyCapacity.toLocaleString()}** | ${perAts.lever.turnoverRatePct}% |
| **Fleet Total** | **${report.totalFleetBoards}** | **${report.totalSampledBoards}** | **${report.totalBoardsWithDateableJobs}** | **${report.totalBoardsWithZeroDateableJobs}** | **${report.sampledOpenJobs.toLocaleString()}** | **${report.sampledJobsTrailing24h.toLocaleString()}** | **${(report.sampledJobsTrailing24h / Math.max(1, report.totalSuccessfulBoards)).toFixed(3)}** | **~${report.extrapolatedFleetDailyCapacity.toLocaleString()}** | **${report.fleetTurnoverRatePct}%** |

---

## 3. Top Contributing Boards (Trailing 24 Hours)

The highest-volume posting boards in the fleet during the audit window:

| Company Name | ATS | Target | Total Open Jobs | Jobs in Trailing 24h | Daily Share % |
| :--- | :--- | :--- | :--- | :--- | :--- |
${topActiveBoards
  .map(
    (b) =>
      `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | ${b.totalOpenJobs} | **${b.jobsTrailing24h}** | ${((b.jobsTrailing24h / Math.max(1, report.sampledJobsTrailing24h)) * 100).toFixed(1)}% |`
  )
  .join('\n')}

---

## 4. Flagged Boards with Zero Date-able Jobs (${zeroDateableBoards.length} boards)

Boards returning 0 date-able jobs in the audit run (either zero active open jobs, or dates omitted from ATS response payload):

| Company Name | ATS | Target | Total Open Jobs | Reason / Status |
| :--- | :--- | :--- | :--- | :--- |
${
  zeroDateableBoards.length === 0
    ? '| _None_ | — | — | — | All sampled boards provided date-able jobs |'
    : zeroDateableBoards
        .slice(0, 50)
        .map(
          (b) =>
            `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | ${b.totalOpenJobs} | ${b.totalOpenJobs === 0 ? 'Empty board (0 open jobs)' : 'No parseable date fields in payload'} |`
        )
        .join('\n')
}
${zeroDateableBoards.length > 50 ? `\n_...and ${zeroDateableBoards.length - 50} more boards with zero date-able jobs._` : ''}

${
  errorBoards.length > 0
    ? `
---

## 5. Boards with Fetch Errors (${errorBoards.length} boards)

| Company Name | ATS | Target | Error Message |
| :--- | :--- | :--- | :--- |
${errorBoards.map((b) => `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | \`${b.error || 'Unknown error'}\` |`).join('\n')}
`
    : ''
}

---

## 6. Mathematical Methodology & Projection Formulas

1. **Board-Level Daily Posting Rate**:
   $$\\text{Rate}_b = \\sum_{j \\in \\text{Jobs}_b} \\mathbb{I}\\left(T_{\\text{now}} - 24\\text{h} \\le T_j \\le T_{\\text{now}}\\right)$$
2. **Platform Average Posting Rate**:
   $$\\mu_{\\text{ATS}} = \\frac{\\sum_{b \\in S_{\\text{ATS}}} \\text{Rate}_b}{|S_{\\text{ATS}}|}$$
3. **Fleet-Wide Extrapolated Daily Supply**:
   $$\\widehat{C}_{\\text{fleet}} = \\sum_{\\text{ATS} \\in \\{\\text{GH}, \\text{Ashby}, \\text{Lever}\\}} \\left(\\mu_{\\text{ATS}} \\times N_{\\text{ATS}}\\right)$$
   Where $N_{\\text{ATS}}$ is the fleet-wide enabled board count (Greenhouse: 227, Ashby: 170, Lever: 41, Total: 438).
4. **Target Feasibility Determination**:
   $$\\Delta = \\widehat{C}_{\\text{fleet}} - 1200$$
   - If $\\Delta \\ge 0$: Fleet posting rate **can deliver 1,200+ new jobs/day**.
   - If $\\Delta < 0$: Fleet posting rate exhibits a **deficit of $|\\Delta|$ jobs/day**.
`;
}

// =============================================================================
// Main Execution Engine
// =============================================================================

export async function runCapacityProjection(options: CapacityCliOptions): Promise<FleetCapacityReport> {
  const rawConfig = fs.readFileSync(path.resolve(options.configPath), 'utf8');
  const allCompanies: ScheduledCompany[] = JSON.parse(rawConfig);
  const enabledCompanies = allCompanies.filter((c) => c.enabled);

  // Compute fleet total counts by ATS
  const fleetEnabledCounts: Record<AtsType, number> = {
    greenhouse: enabledCompanies.filter((c) => c.type === 'greenhouse').length,
    ashby: enabledCompanies.filter((c) => c.type === 'ashby').length,
    lever: enabledCompanies.filter((c) => c.type === 'lever').length,
  };

  // Filter by ATS if requested
  let targetCompanies = enabledCompanies.filter((c) =>
    SUPPORTED_ATS_TYPES.includes(c.type as AtsType)
  );

  if (options.atsFilter) {
    targetCompanies = targetCompanies.filter((c) => c.type === options.atsFilter);
  }

  // Apply limit if requested
  if (options.limit && options.limit > 0) {
    targetCompanies = targetCompanies.slice(0, options.limit);
  }

  console.log('================================================================================');
  console.log('       CAREERMONKE FLEET DAILY INGESTION CAPACITY PROJECTION TOOL               ');
  console.log('================================================================================');
  console.log(`Config File:           ${options.configPath}`);
  console.log(`Fleet Enabled Boards:  ${enabledCompanies.length} (GH: ${fleetEnabledCounts.greenhouse}, Ashby: ${fleetEnabledCounts.ashby}, Lever: ${fleetEnabledCounts.lever})`);
  console.log(`Planned Sample Size:   ${targetCompanies.length} boards`);
  console.log(`Target Daily Jobs:     ${options.targetDailyJobs} new jobs/day`);
  console.log(`Polite Delay:          ${options.delayMs}ms per board`);
  console.log(`Execution Mode:        ${options.dryRun ? 'DRY-RUN (No network calls made)' : 'LIVE AUDIT'}`);
  console.log(`Output Markdown:       ${options.outputPath}`);
  console.log('================================================================================\n');

  if (options.dryRun) {
    console.log('[DRY-RUN] Planned board polling:');
    for (const c of targetCompanies.slice(0, 10)) {
      console.log(`  - [${c.type.toUpperCase()}] ${c.name} (target: '${c.target}')`);
    }
    if (targetCompanies.length > 10) {
      console.log(`  ...and ${targetCompanies.length - 10} more scheduled boards.`);
    }
    console.log('\n[DRY-RUN] To run live execution and write report, execute without --dry-run:');
    console.log('  npx tsx scripts/project-daily-capacity.ts\n');

    // Return empty dry-run report
    return calculateCapacityProjections([], fleetEnabledCounts, options.targetDailyJobs);
  }

  // Live polling
  const nowMs = Date.now();
  const boardMetrics: BoardCapacityMetrics[] = [];

  for (let idx = 0; idx < targetCompanies.length; idx++) {
    const c = targetCompanies[idx];
    const ats = c.type as AtsType;
    const progress = `[${idx + 1}/${targetCompanies.length}]`;

    try {
      let parsedResult: { totalJobs: number; dateableJobs: number; jobsTrailing24h: number; zeroDateableJobs: boolean };

      if (ats === 'greenhouse') {
        const data = await fetchGreenhouseBoard(c.target);
        parsedResult = parseGreenhouseJobs(data?.jobs, nowMs, TRAILING_WINDOW_MS);
      } else if (ats === 'ashby') {
        const data = await fetchAshbyBoard(c.target);
        parsedResult = parseAshbyJobs(data?.jobs, nowMs, TRAILING_WINDOW_MS);
      } else if (ats === 'lever') {
        const data = await fetchLeverBoard(c.target);
        parsedResult = parseLeverJobs(data, nowMs, TRAILING_WINDOW_MS);
      } else {
        throw new Error(`Unsupported ATS type: ${ats}`);
      }

      const metric: BoardCapacityMetrics = {
        id: c.id,
        name: c.name,
        ats,
        target: c.target,
        totalOpenJobs: parsedResult.totalJobs,
        dateableJobs: parsedResult.dateableJobs,
        jobsTrailing24h: parsedResult.jobsTrailing24h,
        zeroDateableJobs: parsedResult.zeroDateableJobs,
        status: parsedResult.zeroDateableJobs ? 'zero_dateable' : 'ok',
      };

      boardMetrics.push(metric);
      const tag = parsedResult.zeroDateableJobs ? '(Zero date-able)' : `(${parsedResult.jobsTrailing24h} in 24h)`;
      console.log(`${progress} ${c.name} [${ats}]: ${parsedResult.totalJobs} jobs, ${parsedResult.dateableJobs} dateable ${tag}`);
    } catch (err: any) {
      console.warn(`${progress} ${c.name} [${ats}]: ERROR - ${err.message}`);
      boardMetrics.push({
        id: c.id,
        name: c.name,
        ats,
        target: c.target,
        totalOpenJobs: 0,
        dateableJobs: 0,
        jobsTrailing24h: 0,
        zeroDateableJobs: true,
        error: err.message,
        status: 'error',
      });
    }

    // Polite rate limiting between consecutive boards
    if (idx < targetCompanies.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  // Calculate fleet-wide projections
  const report = calculateCapacityProjections(boardMetrics, fleetEnabledCounts, options.targetDailyJobs, nowMs);
  const markdown = generateMarkdownReport(report);

  // Write report to disk
  const fullOutputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
  fs.writeFileSync(fullOutputPath, markdown, 'utf8');

  console.log('\n================================================================================');
  console.log('                          CAPACITY PROJECTION RESULTS                           ');
  console.log('================================================================================');
  console.log(report.verdict.verdictLine);
  console.log(`Sampled:             ${report.totalSampledBoards} boards (${report.totalSuccessfulBoards} successful)`);
  console.log(`Observed Open Jobs:  ${report.sampledOpenJobs.toLocaleString()}`);
  console.log(`Observed Trailing:   ${report.sampledJobsTrailing24h.toLocaleString()} jobs in trailing 24h`);
  console.log(`Extrapolated Fleet:  ~${report.extrapolatedFleetDailyCapacity.toLocaleString()} new jobs/day`);
  console.log(`Extrapolated Pool:   ~${report.extrapolatedFleetOpenInventory.toLocaleString()} open jobs pool`);
  console.log(`Report Generated:    ${options.outputPath}`);
  console.log('================================================================================\n');

  return report;
}

// Auto-run when executed directly from CLI
if (
  typeof require !== 'undefined' &&
  require.main === module ||
  (process.argv[1] && process.argv[1].endsWith('project-daily-capacity.ts'))
) {
  const options = parseCapacityCliArgs(process.argv.slice(2));
  runCapacityProjection(options).catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
