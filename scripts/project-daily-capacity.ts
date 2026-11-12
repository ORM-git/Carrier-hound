/**
 * scripts/project-daily-capacity.ts
 *
 * READ-ONLY capacity projection script auditing CareerMonke's active fleet of scheduled ATS boards.
 *
 * Safety & Methodology Rules:
 * 1. Defaults strictly to --dry-run (no network calls). Pass --live to fetch public ATS APIs.
 * 2. Strict separation between first-published timestamps and edit/update timestamps:
 *    - NEW-jobs supply ONLY counts genuine first-post dates (Greenhouse `first_published` / `created_at`,
 *      Ashby `publishedAt` where `isListed !== false`, Lever `createdAt`).
 *    - Greenhouse `updated_at` is an edit/refresh timestamp and is reported SEPARATELY as
 *      "recent activity (updated in trailing 24h)" — it NEVER feeds NEW-jobs totals.
 * 3. Honest Verdict: Public open-job snapshots cannot prove delivered/deduplicated daily ingestion
 *    (live proof comes from PR #557's immutable `first_seen_at` DB report). The verdict is therefore
 *    `NEW-JOBS TARGET: NOT ESTABLISHED` unless real first-seen DB evidence exists.
 * 4. Scope Honesty:
 *    - `--limit` selects a deterministic, representative stratified systematic every-k-th sample across ATS types.
 *    - `--ats` runs a partial scope: unmeasured ATS platforms are marked `UNKNOWN` (`null`), never `0`,
 *      and no fleet-wide projection is emitted.
 * 5. Provenance: Live runs emit a machine-readable JSON provenance artifact with SHA-256 content hash,
 *    per-board timestamps/status/counts, script version, and invocation command next to the markdown report.
 *
 * Usage:
 *   npx tsx scripts/project-daily-capacity.ts                              # Safe dry-run default
 *   npx tsx scripts/project-daily-capacity.ts --dry-run --limit 30         # Dry-run sampled plan
 *   npx tsx scripts/project-daily-capacity.ts --live                       # Live full-fleet audit (438 boards)
 *   npx tsx scripts/project-daily-capacity.ts --live --ats lever           # Live partial audit (Lever only)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Constants, Types, and Interfaces
// =============================================================================

export const SCRIPT_VERSION = '2.0.0';
export type AtsType = 'greenhouse' | 'ashby' | 'lever';

export const SUPPORTED_ATS_TYPES: AtsType[] = ['greenhouse', 'ashby', 'lever'];
export const DEFAULT_CONFIG_PATH = path.join('scripts', 'config', 'companies-scheduled.json');
export const DEFAULT_REPORT_PATH = path.join('reports', 'daily-capacity-projection.md');
export const DEFAULT_PROVENANCE_PATH = path.join('reports', 'daily-capacity-provenance.json');
export const DEFAULT_TARGET_DAILY_JOBS = 1200;
export const DEFAULT_DELAY_MS = 100;
export const DEFAULT_TIMEOUT_MS = 15000;
export const TRAILING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ScheduledCompany {
  id: string;
  name: string;
  type: AtsType | string;
  target: string;
  enabled: boolean;
}

export interface ParsedBoardResult {
  totalJobs: number;
  dateableNewJobs: number;
  newJobsTrailing24h: number;
  zeroDateableNewJobs: boolean;
  recentActivityDateableJobs: number;
  recentActivityTrailing24h: number;
}

export interface BoardCapacityMetrics {
  id: string;
  name: string;
  ats: AtsType;
  target: string;
  fetchedAt: string;
  totalOpenJobs: number;
  dateableNewJobs: number;
  newJobsTrailing24h: number;
  zeroDateableNewJobs: boolean;
  recentActivityDateableJobs: number;
  recentActivityTrailing24h: number;
  status: 'ok' | 'zero_dateable_new' | 'error';
  error?: string;
}

export interface AtsCapacityProjection {
  ats: AtsType;
  measured: boolean;
  fleetTotalBoards: number;
  sampledBoards: number | null;
  successfulBoards: number | null;
  failedBoards: number | null;
  boardsWithDateableNewJobs: number | null;
  boardsWithZeroDateableNewJobs: number | null;
  totalOpenJobsSampled: number | null;
  newJobsTrailing24hSampled: number | null;
  recentActivityTrailing24hSampled: number | null;
  avgNewJobsPerBoardPerDay: number | null;
  extrapolatedDailyNewJobs: number | null;
  extrapolatedRecentActivity24h: number | null;
  extrapolatedOpenInventory: number | null;
}

export interface FleetScopeMetadata {
  isPartial: boolean;
  scopeType: 'full_fleet' | 'sampled_subset' | 'partial_ats';
  atsFilter?: AtsType;
  limit?: number;
  samplingStrategy: string;
  coveragePct: number;
  totalFleetBoards: number;
  totalSampledBoards: number;
  totalSuccessfulBoards: number;
  totalFailedBoards: number;
  totalBoardsWithDateableNewJobs: number;
  totalBoardsWithZeroDateableNewJobs: number;
}

export interface FleetCapacityReport {
  scriptVersion: string;
  runDate: string;
  nowEpochMs: number;
  trailingWindowHours: number;
  fleetTargetPerDay: number;
  scope: FleetScopeMetadata;
  sampledOpenJobs: number;
  sampledNewJobsTrailing24h: number;
  sampledRecentActivityTrailing24h: number;
  extrapolatedFleetDailyNewJobs: number | null;
  extrapolatedFleetRecentActivity24h: number | null;
  extrapolatedFleetOpenInventory: number | null;
  perAts: Record<AtsType, AtsCapacityProjection>;
  boards: BoardCapacityMetrics[];
  verdict: {
    hasFirstSeenEvidence: boolean;
    status: 'NOT_ESTABLISHED' | 'PARTIAL_SCOPE';
    verdictLine: string;
  };
}

export interface ProvenanceRecord {
  schemaVersion: '1.0.0';
  scriptVersion: string;
  invocationCommand: string;
  runDate: string;
  nowEpochMs: number;
  trailingWindowHours: number;
  scope: FleetScopeMetadata;
  summary: {
    sampledOpenJobs: number;
    sampledNewJobsTrailing24h: number;
    sampledRecentActivityTrailing24h: number;
    extrapolatedFleetDailyNewJobs: number | null;
    extrapolatedFleetRecentActivity24h: number | null;
    extrapolatedFleetOpenInventory: number | null;
    perAts: Record<AtsType, AtsCapacityProjection>;
    verdict: FleetCapacityReport['verdict'];
  };
  boards: BoardCapacityMetrics[];
  contentHashSha256: string;
}

export interface CapacityCliOptions {
  dryRun: boolean;
  limit?: number;
  atsFilter?: AtsType;
  delayMs: number;
  configPath: string;
  outputPath: string;
  provenancePath: string;
  targetDailyJobs: number;
}

// =============================================================================
// CLI Argument Parsing (Safe Dry-Run Default, --live Required)
// =============================================================================

export function parseCapacityCliArgs(argv: string[]): CapacityCliOptions {
  const hasLive = argv.includes('--live');
  const hasDryRun = argv.includes('--dry-run');
  // Safe default: dryRun is true unless --live is explicitly passed without --dry-run
  const dryRun = !hasLive || hasDryRun;

  let limit: number | undefined;
  let atsFilter: AtsType | undefined;
  let delayMs = DEFAULT_DELAY_MS;
  let configPath = DEFAULT_CONFIG_PATH;
  let outputPath = DEFAULT_REPORT_PATH;
  let provenancePath = DEFAULT_PROVENANCE_PATH;
  let targetDailyJobs = DEFAULT_TARGET_DAILY_JOBS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit' && argv[i + 1]) {
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
    } else if (arg === '--provenance' && argv[i + 1]) {
      provenancePath = argv[i + 1].trim();
      i++;
    } else if (arg.startsWith('--provenance=')) {
      provenancePath = arg.split('=')[1].trim();
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
    provenancePath,
    targetDailyJobs,
  };
}

// =============================================================================
// Stratified Systematic Sampling (Stable Representative --limit)
// =============================================================================

/**
 * Selects a deterministic, representative sample of size `limit` using
 * stratified systematic every-k-th sampling across ATS types sorted by board id.
 */
export function selectRepresentativeSample<T extends { id: string; type: string }>(
  boards: T[],
  limit?: number
): T[] {
  if (!limit || limit <= 0 || limit >= boards.length) {
    return [...boards];
  }

  // Group deterministically by ATS type sorted by id
  const groups = new Map<string, T[]>();
  for (const ats of SUPPORTED_ATS_TYPES) {
    groups.set(ats, []);
  }
  for (const b of boards) {
    const bucket = groups.get(b.type) || [];
    bucket.push(b);
    groups.set(b.type, bucket);
  }

  for (const [k, list] of groups.entries()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    if (list.length === 0) groups.delete(k);
  }

  const total = boards.length;
  const quotas = new Map<string, number>();
  const remainders: Array<{ ats: string; rem: number }> = [];
  let allocated = 0;

  for (const [ats, list] of groups.entries()) {
    const exact = (list.length / total) * limit;
    const base = Math.min(list.length, Math.floor(exact));
    quotas.set(ats, base);
    allocated += base;
    remainders.push({ ats, rem: exact - base });
  }

  // Distribute remaining slots via Hamilton largest-remainder method
  remainders.sort((a, b) => b.rem - a.rem || a.ats.localeCompare(b.ats));
  let idx = 0;
  while (allocated < limit && remainders.length > 0) {
    const item = remainders[idx % remainders.length];
    const current = quotas.get(item.ats) || 0;
    const maxLen = groups.get(item.ats)!.length;
    if (current < maxLen) {
      quotas.set(item.ats, current + 1);
      allocated++;
    }
    idx++;
    if (idx > remainders.length * 4 && allocated < limit) break;
  }

  // Select evenly spaced every-k-th item from each group
  const selected: T[] = [];
  for (const [ats, list] of groups.entries()) {
    const q = quotas.get(ats) || 0;
    for (let i = 0; i < q; i++) {
      const pickIdx = Math.floor((i * list.length) / q);
      selected.push(list[pickIdx]);
    }
  }

  return selected;
}

// =============================================================================
// ATS Parsing & Strict First-Post vs Recent-Activity Separation
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTimestampInTrailingWindow(
  timestampMs: number,
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): boolean {
  if (isNaN(timestampMs)) return false;
  const ageMs = nowMs - timestampMs;
  return ageMs >= -5 * 60 * 1000 && ageMs <= windowMs;
}

/**
 * Parses Greenhouse public jobs payload.
 * CRITICAL RULE:
 * - `first_published` (or `created_at` if present) is a genuine first-post date -> feeds NEW-jobs metrics.
 * - `updated_at` is an edit/refresh timestamp -> ONLY feeds `recentActivity*` metrics, NEVER `newJobsTrailing24h`.
 */
export function parseGreenhouseJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): ParsedBoardResult {
  if (!Array.isArray(jobs)) {
    return {
      totalJobs: 0,
      dateableNewJobs: 0,
      newJobsTrailing24h: 0,
      zeroDateableNewJobs: true,
      recentActivityDateableJobs: 0,
      recentActivityTrailing24h: 0,
    };
  }

  const validJobs = jobs.filter((j) => j && (j.id != null || j.title));
  let dateableNewJobs = 0;
  let newJobsTrailing24h = 0;
  let recentActivityDateableJobs = 0;
  let recentActivityTrailing24h = 0;

  for (const job of validJobs) {
    // 1. Genuine first-post timestamp ONLY (first_published / created_at). NEVER updated_at.
    const rawFirstPost =
      typeof job.first_published === 'string' && job.first_published.trim()
        ? job.first_published
        : typeof job.created_at === 'string' && job.created_at.trim()
          ? job.created_at
          : null;

    if (rawFirstPost) {
      const parsedFirst = Date.parse(rawFirstPost);
      if (!isNaN(parsedFirst)) {
        dateableNewJobs++;
        if (isTimestampInTrailingWindow(parsedFirst, nowMs, windowMs)) {
          newJobsTrailing24h++;
        }
      }
    }

    // 2. Edit/update timestamp (updated_at) -> Recent Activity ONLY.
    if (job.updated_at && typeof job.updated_at === 'string') {
      const parsedUpdated = Date.parse(job.updated_at);
      if (!isNaN(parsedUpdated)) {
        recentActivityDateableJobs++;
        if (isTimestampInTrailingWindow(parsedUpdated, nowMs, windowMs)) {
          recentActivityTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: validJobs.length,
    dateableNewJobs,
    newJobsTrailing24h,
    zeroDateableNewJobs: dateableNewJobs === 0,
    recentActivityDateableJobs,
    recentActivityTrailing24h,
  };
}

/**
 * Parses Ashby public jobs payload:
 * Excludes unlisted jobs (isListed === false).
 * Uses `publishedAt` as genuine first-post date.
 */
export function parseAshbyJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): ParsedBoardResult {
  if (!Array.isArray(jobs)) {
    return {
      totalJobs: 0,
      dateableNewJobs: 0,
      newJobsTrailing24h: 0,
      zeroDateableNewJobs: true,
      recentActivityDateableJobs: 0,
      recentActivityTrailing24h: 0,
    };
  }

  const listedJobs = jobs.filter((j) => j && (j.id != null || j.title) && j.isListed !== false);
  let dateableNewJobs = 0;
  let newJobsTrailing24h = 0;

  for (const job of listedJobs) {
    if (job.publishedAt && typeof job.publishedAt === 'string') {
      const parsed = Date.parse(job.publishedAt);
      if (!isNaN(parsed)) {
        dateableNewJobs++;
        if (isTimestampInTrailingWindow(parsed, nowMs, windowMs)) {
          newJobsTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: listedJobs.length,
    dateableNewJobs,
    newJobsTrailing24h,
    zeroDateableNewJobs: dateableNewJobs === 0,
    recentActivityDateableJobs: 0,
    recentActivityTrailing24h: 0,
  };
}

/**
 * Parses Lever public jobs payload:
 * Uses `createdAt` (epoch ms) as genuine first-post date.
 */
export function parseLeverJobs(
  jobs: any[],
  nowMs: number,
  windowMs: number = TRAILING_WINDOW_MS
): ParsedBoardResult {
  if (!Array.isArray(jobs)) {
    return {
      totalJobs: 0,
      dateableNewJobs: 0,
      newJobsTrailing24h: 0,
      zeroDateableNewJobs: true,
      recentActivityDateableJobs: 0,
      recentActivityTrailing24h: 0,
    };
  }

  const validJobs = jobs.filter((j) => j && (j.id != null || j.text));
  let dateableNewJobs = 0;
  let newJobsTrailing24h = 0;

  for (const job of validJobs) {
    if (typeof job.createdAt === 'number' && !isNaN(job.createdAt) && job.createdAt > 0) {
      dateableNewJobs++;
      if (isTimestampInTrailingWindow(job.createdAt, nowMs, windowMs)) {
        newJobsTrailing24h++;
      }
    } else if (typeof job.createdAt === 'string') {
      const parsed = Date.parse(job.createdAt);
      if (!isNaN(parsed)) {
        dateableNewJobs++;
        if (isTimestampInTrailingWindow(parsed, nowMs, windowMs)) {
          newJobsTrailing24h++;
        }
      }
    }
  }

  return {
    totalJobs: validJobs.length,
    dateableNewJobs,
    newJobsTrailing24h,
    zeroDateableNewJobs: dateableNewJobs === 0,
    recentActivityDateableJobs: 0,
    recentActivityTrailing24h: 0,
  };
}

// =============================================================================
// Network Fetching (Public APIs Only, Only Invoked with --live)
// =============================================================================

async function fetchWithTimeout(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': `CareerMonkeCapacityProjector/${SCRIPT_VERSION} (Polite-Fleet-Audit)`,
          Accept: 'application/json, text/plain, */*',
        },
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        (err as any).status = res.status;
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          await sleep(300 * attempt);
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (err: any) {
      lastError = err;
      if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt < maxAttempts) {
        await sleep(300 * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Failed fetching ${url}`);
}

export async function fetchGreenhouseBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  return await fetchWithTimeout(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, timeoutMs);
}

export async function fetchAshbyBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  return await fetchWithTimeout(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, timeoutMs);
}

export async function fetchLeverBoard(
  target: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<any> {
  const slug = encodeURIComponent(target.trim().toLowerCase());
  try {
    return await fetchWithTimeout(`https://api.lever.co/v0/postings/${slug}?mode=json`, timeoutMs);
  } catch (err: any) {
    // Only fall back to EU host on genuine 404 (not timeout/429)
    if (err && err.status === 404) {
      return await fetchWithTimeout(`https://api.eu.lever.co/v0/postings/${slug}?mode=json`, timeoutMs);
    }
    throw err;
  }
}

// =============================================================================
// Extrapolation, Scope Honesty & Honest Verdict Engine
// =============================================================================

export interface ProjectionContext {
  atsFilter?: AtsType;
  limit?: number;
  hasFirstSeenEvidence?: boolean;
  targetDailyJobs?: number;
  nowEpochMs?: number;
}

/**
 * Pure calculation engine computing per-ATS and fleet-wide capacity projections.
 * - Never combines Greenhouse `updated_at` recent activity into NEW-jobs counts.
 * - Never outputs ACHIEVED or DEFICIT without first-seen DB evidence.
 * - Marks unmeasured ATS platforms as UNKNOWN (null) when `--ats` partial filter is active.
 */
export function calculateCapacityProjections(
  boards: BoardCapacityMetrics[],
  fleetEnabledCounts: Record<AtsType, number>,
  ctx: ProjectionContext = {}
): FleetCapacityReport {
  const targetDailyJobs = ctx.targetDailyJobs ?? DEFAULT_TARGET_DAILY_JOBS;
  const nowEpochMs = ctx.nowEpochMs ?? Date.now();
  const hasFirstSeenEvidence = ctx.hasFirstSeenEvidence === true; // Public ATS snapshots never have DB first-seen evidence

  const totalFleetBoards =
    (fleetEnabledCounts.greenhouse || 0) +
    (fleetEnabledCounts.ashby || 0) +
    (fleetEnabledCounts.lever || 0);

  const isPartialAts = Boolean(ctx.atsFilter);
  const isSampledSubset = !isPartialAts && Boolean(ctx.limit && ctx.limit < totalFleetBoards);
  const isPartial = isPartialAts || isSampledSubset;

  const scopeType: FleetScopeMetadata['scopeType'] = isPartialAts
    ? 'partial_ats'
    : isSampledSubset
      ? 'sampled_subset'
      : 'full_fleet';

  const samplingStrategy = isPartialAts
    ? `filtered to ATS=${ctx.atsFilter} only (other ATS platforms unmeasured / UNKNOWN)`
    : isSampledSubset
      ? `stratified systematic every-k-th sample (${ctx.limit} of ${totalFleetBoards} enabled boards)`
      : `complete fleet enumeration (${totalFleetBoards} enabled boards)`;

  const perAts: Record<AtsType, AtsCapacityProjection> = {} as any;

  let totalSampledBoards = 0;
  let totalSuccessfulBoards = 0;
  let totalFailedBoards = 0;
  let totalBoardsWithDateableNewJobs = 0;
  let totalBoardsWithZeroDateableNewJobs = 0;
  let sampledOpenJobs = 0;
  let sampledNewJobsTrailing24h = 0;
  let sampledRecentActivityTrailing24h = 0;

  let allMeasured = true;
  let fleetNewJobsSum = 0;
  let fleetRecentActivitySum = 0;
  let fleetInventorySum = 0;

  for (const ats of SUPPORTED_ATS_TYPES) {
    const fleetTotal = fleetEnabledCounts[ats] || 0;
    const isMeasured = !ctx.atsFilter || ctx.atsFilter === ats;

    if (!isMeasured) {
      allMeasured = false;
      perAts[ats] = {
        ats,
        measured: false,
        fleetTotalBoards: fleetTotal,
        sampledBoards: null,
        successfulBoards: null,
        failedBoards: null,
        boardsWithDateableNewJobs: null,
        boardsWithZeroDateableNewJobs: null,
        totalOpenJobsSampled: null,
        newJobsTrailing24hSampled: null,
        recentActivityTrailing24hSampled: null,
        avgNewJobsPerBoardPerDay: null,
        extrapolatedDailyNewJobs: null,
        extrapolatedRecentActivity24h: null,
        extrapolatedOpenInventory: null,
      };
      continue;
    }

    const atsBoards = boards.filter((b) => b.ats === ats);
    const sampled = atsBoards.length;
    totalSampledBoards += sampled;

    const successful = atsBoards.filter((b) => b.status !== 'error').length;
    const failed = atsBoards.filter((b) => b.status === 'error').length;
    totalSuccessfulBoards += successful;
    totalFailedBoards += failed;

    const dateableNewCount = atsBoards.filter((b) => !b.zeroDateableNewJobs && b.status !== 'error').length;
    const zeroDateableNewCount = atsBoards.filter((b) => b.zeroDateableNewJobs && b.status !== 'error').length;
    totalBoardsWithDateableNewJobs += dateableNewCount;
    totalBoardsWithZeroDateableNewJobs += zeroDateableNewCount;

    const atsOpenJobs = atsBoards.reduce((sum, b) => sum + (b.totalOpenJobs || 0), 0);
    const atsNew24h = atsBoards.reduce((sum, b) => sum + (b.newJobsTrailing24h || 0), 0);
    const atsRecent24h = atsBoards.reduce((sum, b) => sum + (b.recentActivityTrailing24h || 0), 0);

    sampledOpenJobs += atsOpenJobs;
    sampledNewJobsTrailing24h += atsNew24h;
    sampledRecentActivityTrailing24h += atsRecent24h;

    const avgNewPerBoard = successful > 0 ? Number((atsNew24h / successful).toFixed(3)) : 0;

    let extrapolatedNew: number;
    let extrapolatedRecent: number;
    let extrapolatedInventory: number;

    if (successful === 0) {
      extrapolatedNew = 0;
      extrapolatedRecent = 0;
      extrapolatedInventory = 0;
    } else if (successful === fleetTotal) {
      extrapolatedNew = atsNew24h;
      extrapolatedRecent = atsRecent24h;
      extrapolatedInventory = atsOpenJobs;
    } else {
      extrapolatedNew = Math.round((atsNew24h / successful) * fleetTotal);
      extrapolatedRecent = Math.round((atsRecent24h / successful) * fleetTotal);
      extrapolatedInventory = Math.round((atsOpenJobs / successful) * fleetTotal);
    }

    fleetNewJobsSum += extrapolatedNew;
    fleetRecentActivitySum += extrapolatedRecent;
    fleetInventorySum += extrapolatedInventory;

    perAts[ats] = {
      ats,
      measured: true,
      fleetTotalBoards: fleetTotal,
      sampledBoards: sampled,
      successfulBoards: successful,
      failedBoards: failed,
      boardsWithDateableNewJobs: dateableNewCount,
      boardsWithZeroDateableNewJobs: zeroDateableNewCount,
      totalOpenJobsSampled: atsOpenJobs,
      newJobsTrailing24hSampled: atsNew24h,
      recentActivityTrailing24hSampled: atsRecent24h,
      avgNewJobsPerBoardPerDay: avgNewPerBoard,
      extrapolatedDailyNewJobs: extrapolatedNew,
      extrapolatedRecentActivity24h: extrapolatedRecent,
      extrapolatedOpenInventory: extrapolatedInventory,
    };
  }

  const coveragePct =
    totalFleetBoards > 0 ? Number(((totalSampledBoards / totalFleetBoards) * 100).toFixed(1)) : 0;

  // If partial ATS scope, fleet-wide aggregate is UNKNOWN (null), NEVER partial sum!
  const extrapolatedFleetDailyNewJobs = allMeasured ? fleetNewJobsSum : null;
  const extrapolatedFleetRecentActivity24h = allMeasured ? fleetRecentActivitySum : null;
  const extrapolatedFleetOpenInventory = allMeasured ? fleetInventorySum : null;

  // Honest Verdict (never ACHIEVED or DEFICIT without first-seen DB evidence)
  const verdictStatus: FleetCapacityReport['verdict']['status'] = isPartialAts
    ? 'PARTIAL_SCOPE'
    : 'NOT_ESTABLISHED';

  let verdictLine: string;
  if (isPartialAts) {
    verdictLine = `**Verdict**: NEW-JOBS TARGET: NOT ESTABLISHED (PARTIAL SCOPE: \`--ats ${ctx.atsFilter}\` only; unmeasured ATS platforms are UNKNOWN). Open-job public ATS snapshots cannot prove delivered/deduplicated ingestion per day (live proof comes from PR #557's immutable \`first_seen_at\` DB report).`;
  } else {
    verdictLine = `**Verdict**: NEW-JOBS TARGET: NOT ESTABLISHED — Open-job public ATS snapshots cannot prove delivered/deduplicated ingestion per day vs the ${targetDailyJobs.toLocaleString()}/day goal (live proof comes from PR #557's immutable \`first_seen_at\` DB report).`;
  }

  const runDate = new Date(nowEpochMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return {
    scriptVersion: SCRIPT_VERSION,
    runDate,
    nowEpochMs,
    trailingWindowHours: 24,
    fleetTargetPerDay: targetDailyJobs,
    scope: {
      isPartial,
      scopeType,
      atsFilter: ctx.atsFilter,
      limit: ctx.limit,
      samplingStrategy,
      coveragePct,
      totalFleetBoards,
      totalSampledBoards,
      totalSuccessfulBoards,
      totalFailedBoards,
      totalBoardsWithDateableNewJobs,
      totalBoardsWithZeroDateableNewJobs,
    },
    sampledOpenJobs,
    sampledNewJobsTrailing24h,
    sampledRecentActivityTrailing24h,
    extrapolatedFleetDailyNewJobs,
    extrapolatedFleetRecentActivity24h,
    extrapolatedFleetOpenInventory,
    perAts,
    boards,
    verdict: {
      hasFirstSeenEvidence,
      status: verdictStatus,
      verdictLine,
    },
  };
}

// =============================================================================
// Provenance Hash & Serialization
// =============================================================================

export function computeProvenanceHash(payload: Omit<ProvenanceRecord, 'contentHashSha256'>): string {
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildProvenanceRecord(
  report: FleetCapacityReport,
  invocationCommand: string
): ProvenanceRecord {
  const basePayload: Omit<ProvenanceRecord, 'contentHashSha256'> = {
    schemaVersion: '1.0.0',
    scriptVersion: report.scriptVersion,
    invocationCommand,
    runDate: report.runDate,
    nowEpochMs: report.nowEpochMs,
    trailingWindowHours: report.trailingWindowHours,
    scope: report.scope,
    summary: {
      sampledOpenJobs: report.sampledOpenJobs,
      sampledNewJobsTrailing24h: report.sampledNewJobsTrailing24h,
      sampledRecentActivityTrailing24h: report.sampledRecentActivityTrailing24h,
      extrapolatedFleetDailyNewJobs: report.extrapolatedFleetDailyNewJobs,
      extrapolatedFleetRecentActivity24h: report.extrapolatedFleetRecentActivity24h,
      extrapolatedFleetOpenInventory: report.extrapolatedFleetOpenInventory,
      perAts: report.perAts,
      verdict: report.verdict,
    },
    boards: report.boards,
  };

  return {
    ...basePayload,
    contentHashSha256: computeProvenanceHash(basePayload),
  };
}

// =============================================================================
// Markdown Report Generator
// =============================================================================

function fmtNum(val: number | null, prefix: string = ''): string {
  if (val === null) return 'UNKNOWN (unmeasured)';
  return `${prefix}${val.toLocaleString()}`;
}

export function generateMarkdownReport(
  report: FleetCapacityReport,
  provenance?: ProvenanceRecord,
  provenanceFilePath: string = DEFAULT_PROVENANCE_PATH
): string {
  const { verdict, perAts, boards, scope } = report;

  const zeroDateableNewBoards = boards.filter((b) => b.zeroDateableNewJobs && b.status !== 'error');
  const errorBoards = boards.filter((b) => b.status === 'error');
  const topNewJobBoards = [...boards]
    .filter((b) => b.newJobsTrailing24h > 0)
    .sort((a, b) => b.newJobsTrailing24h - a.newJobsTrailing24h)
    .slice(0, 20);

  const provenanceBlock = provenance
    ? `**Provenance Artifact**: \`${provenanceFilePath.replace(/\\/g, '/')}\`  
**Provenance SHA-256**: \`${provenance.contentHashSha256}\`  
**Invocation Command**: \`${provenance.invocationCommand}\``
    : `**Provenance Status**: _UNVERIFIED (in-memory projection without committed raw run JSON)_`;

  return `# CareerMonke Fleet Daily Ingestion Capacity Projection

**Audit Run Date**: ${report.runDate}  
**Script Version**: \`${report.scriptVersion}\`  
**Scope Type**: \`${scope.scopeType}\` (${scope.samplingStrategy})  
**Fleet Coverage**: ${scope.totalSampledBoards} / ${scope.totalFleetBoards} enabled boards (${scope.coveragePct}% coverage | ${scope.totalSuccessfulBoards} succeeded, ${scope.totalFailedBoards} failed)  
${provenanceBlock}  

---

## 1. Executive Summary & Verdict

${verdict.verdictLine}

- **Date-able NEW Jobs Supply (trailing 24h, genuine first-post dates only)**: ${fmtNum(report.extrapolatedFleetDailyNewJobs, '~')} / day (observed in sample: ${report.sampledNewJobsTrailing24h.toLocaleString()})
- **Recent Activity / Updates (trailing 24h, Greenhouse \`updated_at\` edit churn — NEVER added to NEW jobs)**: ${fmtNum(report.extrapolatedFleetRecentActivity24h, '~')} / day (observed in sample: ${report.sampledRecentActivityTrailing24h.toLocaleString()})
- **Target Daily NEW Jobs Goal**: ${report.fleetTargetPerDay.toLocaleString()} / day (First-Seen DB Evidence Present: **${verdict.hasFirstSeenEvidence ? 'YES' : 'NO'}**)

| Metric | Estimate / Value | Notes |
| :--- | :--- | :--- |
| **Target Status** | **${verdict.status}** | Public ATS snapshots cannot verify deduplicated DB ingestion (see PR #557) |
| **Date-able NEW Jobs (Trailing 24h)** | **${fmtNum(report.extrapolatedFleetDailyNewJobs, '~')} / day** | Counts ONLY genuine first-post dates (\`first_published\`, \`publishedAt\`, \`createdAt\`) |
| **Recent Activity / Updates (Trailing 24h)** | **${fmtNum(report.extrapolatedFleetRecentActivity24h, '~')} / day** | Counts Greenhouse \`updated_at\` edit/refresh events separately; never counted as new |
| **Estimated Fleet Open Inventory** | **${fmtNum(report.extrapolatedFleetOpenInventory, '~')}** | Active public job listings across measured boards |
| **Failed Boards** | **${scope.totalFailedBoards}** | HTTP errors / timeouts excluded from successful denominator |

> [!IMPORTANT]
> **Why Open-Job Snapshots Cannot Prove Target Attainment**:
> 1. **No Delivery / Deduplication Proof**: Polling open ATS snapshots measures *upstream posting hints*, not *delivered, deduplicated DB inserts*. Live proof of delivered daily NEW jobs comes strictly from PR #557's immutable \`first_seen_at\` database report.
> 2. **Strict Separation of Edit Churn (\`updated_at\`)**: Greenhouse \`updated_at\` fires on routine requisition edits, recruiter changes, or description tweaks. It is tracked strictly as **recent activity** and NEVER included in NEW-jobs supply. Only genuine first-post fields (\`first_published\` / \`created_at\` on Greenhouse, \`publishedAt\` on Ashby, \`createdAt\` on Lever) feed NEW-jobs supply.
> 3. **Extrapolation Assumptions**: When a subset of boards is sampled (\`--limit\`) or individual boards fail, extrapolation assumes failed/unsampled boards have the same mean posting rate as successful sampled boards within that ATS platform. Unmeasured ATS platforms under \`--ats\` are strictly reported as **UNKNOWN**.

---

## 2. Per-ATS Platform Breakdown

| ATS Platform | Measured? | Fleet Boards | Sampled Boards | Failed Boards | Boards w/ Zero Date-able NEW | Open Jobs Sampled | Date-able NEW (24h, First-Post) | Recent Activity (24h, \`updated_at\`) | Extrapolated Daily NEW Supply |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Greenhouse** | ${perAts.greenhouse.measured ? 'YES' : 'NO'} | ${perAts.greenhouse.fleetTotalBoards} | ${fmtNum(perAts.greenhouse.sampledBoards)} | ${fmtNum(perAts.greenhouse.failedBoards)} | ${fmtNum(perAts.greenhouse.boardsWithZeroDateableNewJobs)} | ${fmtNum(perAts.greenhouse.totalOpenJobsSampled)} | ${fmtNum(perAts.greenhouse.newJobsTrailing24hSampled)} | ${fmtNum(perAts.greenhouse.recentActivityTrailing24hSampled)} | **${fmtNum(perAts.greenhouse.extrapolatedDailyNewJobs, '~')}** |
| **Ashby** | ${perAts.ashby.measured ? 'YES' : 'NO'} | ${perAts.ashby.fleetTotalBoards} | ${fmtNum(perAts.ashby.sampledBoards)} | ${fmtNum(perAts.ashby.failedBoards)} | ${fmtNum(perAts.ashby.boardsWithZeroDateableNewJobs)} | ${fmtNum(perAts.ashby.totalOpenJobsSampled)} | ${fmtNum(perAts.ashby.newJobsTrailing24hSampled)} | N/A | **${fmtNum(perAts.ashby.extrapolatedDailyNewJobs, '~')}** |
| **Lever** | ${perAts.lever.measured ? 'YES' : 'NO'} | ${perAts.lever.fleetTotalBoards} | ${fmtNum(perAts.lever.sampledBoards)} | ${fmtNum(perAts.lever.failedBoards)} | ${fmtNum(perAts.lever.boardsWithZeroDateableNewJobs)} | ${fmtNum(perAts.lever.totalOpenJobsSampled)} | ${fmtNum(perAts.lever.newJobsTrailing24hSampled)} | N/A | **${fmtNum(perAts.lever.extrapolatedDailyNewJobs, '~')}** |
| **Fleet Aggregate** | ${scope.isPartial ? 'PARTIAL' : 'FULL'} | **${scope.totalFleetBoards}** | **${scope.totalSampledBoards}** | **${scope.totalFailedBoards}** | **${scope.totalBoardsWithZeroDateableNewJobs}** | **${report.sampledOpenJobs.toLocaleString()}** | **${report.sampledNewJobsTrailing24h.toLocaleString()}** | **${report.sampledRecentActivityTrailing24h.toLocaleString()}** | **${fmtNum(report.extrapolatedFleetDailyNewJobs, '~')}** |

---

## 3. Top Contributing Boards (Date-able NEW First-Posts in Trailing 24h)

| Company Name | ATS | Target | Open Jobs | Date-able NEW (24h) | Recent Activity \`updated_at\` (24h) |
| :--- | :--- | :--- | :--- | :--- | :--- |
${
  topNewJobBoards.length === 0
    ? '| _None observed in sample_ | — | — | — | 0 | 0 |'
    : topNewJobBoards
        .map(
          (b) =>
            `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | ${b.totalOpenJobs} | **${b.newJobsTrailing24h}** | ${b.ats === 'greenhouse' ? b.recentActivityTrailing24h : 'N/A'} |`
        )
        .join('\n')
}

---

## 4. Flagged Boards with Zero Date-able NEW Jobs (${zeroDateableNewBoards.length} boards)

Boards returning 0 jobs with genuine first-post dates (\`first_published\` / \`publishedAt\` / \`createdAt\`):

| Company Name | ATS | Target | Total Open Jobs | Recent Activity \`updated_at\` (24h) | Flag Reason |
| :--- | :--- | :--- | :--- | :--- | :--- |
${
  zeroDateableNewBoards.length === 0
    ? '| _None_ | — | — | — | — | All successful boards exposed genuine first-post dates |'
    : zeroDateableNewBoards
        .slice(0, 50)
        .map(
          (b) =>
            `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | ${b.totalOpenJobs} | ${b.ats === 'greenhouse' ? b.recentActivityTrailing24h : 'N/A'} | ${b.totalOpenJobs === 0 ? 'Empty board (0 open jobs)' : 'No genuine first-post date exposed by ATS'} |`
        )
        .join('\n')
}
${zeroDateableNewBoards.length > 50 ? `\n_...and ${zeroDateableNewBoards.length - 50} more boards with zero date-able NEW jobs (see provenance JSON)._` : ''}

---

## 5. Boards with Fetch Errors (${errorBoards.length} boards)

| Company Name | ATS | Target | Error Message |
| :--- | :--- | :--- | :--- |
${
  errorBoards.length === 0
    ? '| _None_ | — | — | Zero failed requests |'
    : errorBoards.map((b) => `| ${b.name} | \`${b.ats}\` | \`${b.target}\` | \`${b.error || 'Unknown error'}\` |`).join('\n')
}
`;
}

// =============================================================================
// Main Execution Engine
// =============================================================================

export async function runCapacityProjection(
  options: CapacityCliOptions,
  rawArgv: string[] = []
): Promise<FleetCapacityReport> {
  const rawConfig = fs.readFileSync(path.resolve(options.configPath), 'utf8');
  const allCompanies: ScheduledCompany[] = JSON.parse(rawConfig);
  const enabledCompanies = allCompanies.filter((c) => c.enabled);

  const fleetEnabledCounts: Record<AtsType, number> = {
    greenhouse: enabledCompanies.filter((c) => c.type === 'greenhouse').length,
    ashby: enabledCompanies.filter((c) => c.type === 'ashby').length,
    lever: enabledCompanies.filter((c) => c.type === 'lever').length,
  };

  let targetCompanies = enabledCompanies.filter((c) =>
    SUPPORTED_ATS_TYPES.includes(c.type as AtsType)
  );

  if (options.atsFilter) {
    targetCompanies = targetCompanies.filter((c) => c.type === options.atsFilter);
  }

  // Representative stratified systematic sampling for --limit
  targetCompanies = selectRepresentativeSample(targetCompanies, options.limit);

  console.log('================================================================================');
  console.log('       CAREERMONKE FLEET DAILY INGESTION CAPACITY PROJECTION TOOL               ');
  console.log('================================================================================');
  console.log(`Config File:           ${options.configPath}`);
  console.log(`Fleet Enabled Boards:  ${enabledCompanies.length} (GH: ${fleetEnabledCounts.greenhouse}, Ashby: ${fleetEnabledCounts.ashby}, Lever: ${fleetEnabledCounts.lever})`);
  console.log(`Sample Scope:          ${targetCompanies.length} boards${options.atsFilter ? ` (ATS filter: ${options.atsFilter})` : ''}${options.limit ? ` (Systematic sample limit: ${options.limit})` : ''}`);
  console.log(`Polite Delay:          ${options.delayMs}ms per board`);
  console.log(`Execution Mode:        ${options.dryRun ? 'DRY-RUN (Safe default - no network calls made)' : 'LIVE EXECUTION'}`);
  console.log(`Report Path:           ${options.outputPath}`);
  console.log(`Provenance Path:       ${options.provenancePath}`);
  console.log('================================================================================\n');

  if (options.dryRun) {
    console.log('[DRY-RUN] Planned representative board polling:');
    for (const c of targetCompanies.slice(0, 12)) {
      console.log(`  - [${c.type.toUpperCase()}] ${c.name} (target: '${c.target}')`);
    }
    if (targetCompanies.length > 12) {
      console.log(`  ...and ${targetCompanies.length - 12} more scheduled boards.`);
    }
    console.log('\n[DRY-RUN] Normal invocation defaults to --dry-run. Pass --live to execute network calls:');
    console.log('  npx tsx scripts/project-daily-capacity.ts --live\n');

    return calculateCapacityProjections([], fleetEnabledCounts, {
      atsFilter: options.atsFilter,
      limit: options.limit,
      targetDailyJobs: options.targetDailyJobs,
    });
  }

  // Live polling (requires --live flag)
  const nowMs = Date.now();
  const boardMetrics: BoardCapacityMetrics[] = [];

  for (let idx = 0; idx < targetCompanies.length; idx++) {
    const c = targetCompanies[idx];
    const ats = c.type as AtsType;
    const progress = `[${idx + 1}/${targetCompanies.length}]`;
    const fetchedAt = new Date().toISOString();

    try {
      let parsedResult: ParsedBoardResult;

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
        fetchedAt,
        totalOpenJobs: parsedResult.totalJobs,
        dateableNewJobs: parsedResult.dateableNewJobs,
        newJobsTrailing24h: parsedResult.newJobsTrailing24h,
        zeroDateableNewJobs: parsedResult.zeroDateableNewJobs,
        recentActivityDateableJobs: parsedResult.recentActivityDateableJobs,
        recentActivityTrailing24h: parsedResult.recentActivityTrailing24h,
        status: parsedResult.zeroDateableNewJobs ? 'zero_dateable_new' : 'ok',
      };

      boardMetrics.push(metric);
      const recentTag = ats === 'greenhouse' ? `, recent_updated=${parsedResult.recentActivityTrailing24h}` : '';
      console.log(`${progress} ${c.name} [${ats}]: ${parsedResult.totalJobs} open, ${parsedResult.dateableNewJobs} dateable_new (${parsedResult.newJobsTrailing24h} in 24h${recentTag})`);
    } catch (err: any) {
      console.warn(`${progress} ${c.name} [${ats}]: ERROR - ${err.message}`);
      boardMetrics.push({
        id: c.id,
        name: c.name,
        ats,
        target: c.target,
        fetchedAt,
        totalOpenJobs: 0,
        dateableNewJobs: 0,
        newJobsTrailing24h: 0,
        zeroDateableNewJobs: true,
        recentActivityDateableJobs: 0,
        recentActivityTrailing24h: 0,
        status: 'error',
        error: err.message,
      });
    }

    if (idx < targetCompanies.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  const report = calculateCapacityProjections(boardMetrics, fleetEnabledCounts, {
    atsFilter: options.atsFilter,
    limit: options.limit,
    targetDailyJobs: options.targetDailyJobs,
    nowEpochMs: nowMs,
  });

  const invocationCommand = `npx tsx scripts/project-daily-capacity.ts ${rawArgv.join(' ')}`.trim();
  const provenance = buildProvenanceRecord(report, invocationCommand);
  const markdown = generateMarkdownReport(report, provenance, options.provenancePath);

  const fullOutputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
  fs.writeFileSync(fullOutputPath, markdown, 'utf8');

  const fullProvPath = path.resolve(options.provenancePath);
  fs.mkdirSync(path.dirname(fullProvPath), { recursive: true });
  fs.writeFileSync(fullProvPath, JSON.stringify(provenance, null, 2) + '\n', 'utf8');

  console.log('\n================================================================================');
  console.log('                          CAPACITY PROJECTION RESULTS                           ');
  console.log('================================================================================');
  console.log(report.verdict.verdictLine);
  console.log(`Date-able NEW (first-post):  ${fmtNum(report.extrapolatedFleetDailyNewJobs, '~')} / day (sample: ${report.sampledNewJobsTrailing24h})`);
  console.log(`Recent Activity (updated_at): ${fmtNum(report.extrapolatedFleetRecentActivity24h, '~')} / day (sample: ${report.sampledRecentActivityTrailing24h})`);
  console.log(`Provenance JSON:              ${options.provenancePath} (sha256: ${provenance.contentHashSha256})`);
  console.log(`Markdown Report:              ${options.outputPath}`);
  console.log('================================================================================\n');

  return report;
}

if (
  (typeof require !== 'undefined' && require.main === module) ||
  (process.argv[1] && process.argv[1].endsWith('project-daily-capacity.ts'))
) {
  const argv = process.argv.slice(2);
  const options = parseCapacityCliArgs(argv);
  runCapacityProjection(options, argv).catch((err) => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
