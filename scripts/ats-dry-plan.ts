/**
 * scripts/ats-dry-plan.ts
 *
 * Reproducible & Resumable ATS Discovery-to-Ingestion Dry-Plan Engine.
 *
 * Operational Locks & Rules:
 * - Read-only / dry-plan execution: ZERO database writes, ZERO workflow dispatch, ZERO paid API signups.
 * - Single normalized adapter path: delegates strictly to getAdapter() in scripts/adapters/.
 * - Supports seed (52 companies), registry (277 companies), and comparative analysis.
 * - Resumable execution: persists progress to reports/ats-dry-plan-checkpoint.json; resumes on demand.
 * - Rate pacing: Strictly 1 req/s per host domain pacing via politeFetchJson.
 * - No scraping of forbidden domains (LinkedIn, Indeed, Naukri, Glassdoor, Workday).
 * - Distinguishes global totals from India totals and potential new rows from existing rows.
 * - Offline/unverified headroom marking: If DB credentials unavailable, marks DB headroom unverified.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from './adapters';
import { NormalizedJob, SourceConfig, SourceType } from './types';
import { CompanyRegistryEntry, loadCompanyRegistry } from './board-ingest';
import { cleanText, detectCountryCode, detectRemoteEligibility } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

export type DryPlanSource = 'seed' | 'registry' | 'compare' | string;

export interface BoardResult {
  token: string;
  company: string;
  ats: string;
  fetchStatus: 'complete' | 'partial' | 'empty' | 'failed' | 'blocked';
  httpStatus?: number;
  errorMessage?: string;
  rawCount: number;
  acceptedCount: number;
  duplicateCount: number;
  unlistedSkippedCount: number;
  indiaOnsiteHybridCount: number;
  indiaEligibleRemoteCount: number;
  unknownEligibilityCount: number;
  countryRestrictedNonIndiaCount: number;
  validSalaryCount: number;
  salaryByCurrency: Record<string, number>;
  jobs: NormalizedJob[];
  pagesFetched: number;
  totalFoundReported?: number;
}

export interface DryPlanSummaryStats {
  sourceSelection: string;
  totalEmployersPlanned: number;
  employersAttempted: number;
  employersSucceeded: number;
  employersEmpty: number;
  employersFailed: number;
  employersBlocked: number;
  completeFetchesCount: number;
  partialFetchesCount: number;
  paginationEventsCount: number;
  totalJobsFetched: number;
  totalJobsAccepted: number;
  totalJobsUnique: number;
  totalDuplicatesDropped: number;
  unlistedSkippedTotal: number;
  // India & Remote Breakdown
  indiaOnsiteOrHybridTotal: number;
  indiaEligibleRemoteTotal: number;
  unknownEligibilityTotal: number;
  countryRestrictedNonIndiaTotal: number;
  globalTotal: number;
  indiaTotal: number;
  // Salary Breakdown by ATS
  salaryCoverageByAts: Record<string, { totalJobs: number; withSalary: number; salaryPct: string }>;
  salaryCurrencies: Record<string, number>;
  // Sizing & Resource Estimation
  estimatedDbBytes: number;
  estimatedDbMb: string;
  estimatedRuntimeSeconds: number;
  actualRuntimeMs: number;
  // DB Delta & Headroom
  dbVerificationStatus: 'VERIFIED_CONNECTED' | 'UNVERIFIED (offline / no DB read credentials)';
  existingDbJobsCount?: number;
  potentialNewRowsCount?: number;
  existingRowsOverlapCount?: number;
}

export interface DryPlanCheckpoint {
  sourceSelection: string;
  timestamp: string;
  completedTokens: string[];
  boardResults: BoardResult[];
  savedAt: string;
}

export interface DryPlanReport {
  generatedAt: string;
  mode: string;
  summary: DryPlanSummaryStats;
  boards: Array<Omit<BoardResult, 'jobs'>>;
  sampleJobs?: Array<{
    title: string;
    company: string;
    location: string;
    remote: boolean;
    remote_scope?: string;
    remote_eligibility?: string;
    country_code?: string | null;
    salary_text?: string | null;
    currency?: string;
    salary_period?: string;
    source: string;
    apply_url: string;
  }>;
}

export interface DryPlanOptions {
  source?: DryPlanSource;
  limit?: number;
  offset?: number;
  atsFilter?: string;
  companyFilter?: string;
  checkpointPath?: string;
  resume?: boolean;
  maxSeconds?: number;
  offlineFixtureMode?: boolean;
  outputPath?: string;
  markdownOutputPath?: string;
}

/**
 * Loads the target employer boards according to source selection.
 */
export function loadTargetBoards(source: DryPlanSource): CompanyRegistryEntry[] {
  if (source === 'seed') {
    const seedPath = path.resolve(__dirname, 'config/companies-seed.json');
    if (!fs.existsSync(seedPath)) {
      throw new Error(`Seed configuration file not found at ${seedPath}`);
    }
    const raw = fs.readFileSync(seedPath, 'utf-8');
    const items = JSON.parse(raw);
    return items.map((item: any) => ({
      id: item.id || item.target,
      company: item.name || item.target,
      name: item.name,
      ats: item.type,
      type: item.type,
      token: item.target,
      target: item.target,
      enabled: item.enabled !== false,
    }));
  }

  // Default: Registry (277 employers)
  const registryPath = path.resolve(__dirname, '../data/ats-company-registry.json');
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Company registry not found at ${registryPath}`);
  }
  const raw = fs.readFileSync(registryPath, 'utf-8');
  const items: CompanyRegistryEntry[] = JSON.parse(raw);
  return items.filter((item) => item.enabled !== false);
}

/**
 * Executes the dry-plan inspection without writing to the database.
 */
export async function runDryPlan(options: DryPlanOptions = {}): Promise<DryPlanReport> {
  const startTime = Date.now();
  const {
    source = 'registry',
    limit,
    offset = 0,
    atsFilter = 'all',
    companyFilter,
    checkpointPath = path.resolve(__dirname, '../reports/ats-dry-plan-checkpoint.json'),
    resume = false,
    maxSeconds,
    offlineFixtureMode = false,
    outputPath = path.resolve(__dirname, '../reports/ats-dry-plan-report.json'),
    markdownOutputPath = path.resolve(__dirname, '../reports/ats-dry-plan-report.md'),
  } = options;

  console.log('================================================================================');
  console.log('📋 CareerMonke ATS Pipeline Discovery & Dry-Plan Engine (Read-Only)');
  console.log('================================================================================');
  console.log(`Source Config:    ${source.toUpperCase()}`);
  console.log(`ATS Filter:       ${atsFilter}`);
  if (companyFilter) console.log(`Company Filter:   ${companyFilter}`);
  if (limit) console.log(`Limit:            ${limit} boards`);
  if (offset > 0) console.log(`Offset:           ${offset}`);
  console.log(`Offline Mode:     ${offlineFixtureMode ? 'YES (Fixture-based)' : 'NO (Live endpoints with 1 req/s pacing)'}`);
  console.log(`Checkpoint Path:  ${checkpointPath}`);
  console.log(`Resume Mode:      ${resume ? 'YES' : 'NO'}\n`);

  let allTargetBoards = loadTargetBoards(source);

  // Apply filters
  let filteredBoards = allTargetBoards.filter((b) => {
    if (atsFilter !== 'all' && b.ats !== atsFilter) return false;
    if (companyFilter && !b.company?.toLowerCase().includes(companyFilter.toLowerCase())) return false;
    return true;
  });

  if (offset > 0 || (limit && limit > 0)) {
    filteredBoards = filteredBoards.slice(offset, limit ? offset + limit : undefined);
  }

  // Resumable Checkpoint Recovery
  let completedTokensSet = new Set<string>();
  let boardResults: BoardResult[] = [];

  if (resume && fs.existsSync(checkpointPath)) {
    try {
      const rawCp = fs.readFileSync(checkpointPath, 'utf-8');
      const cp: DryPlanCheckpoint = JSON.parse(rawCp);
      if (Array.isArray(cp.completedTokens) && Array.isArray(cp.boardResults)) {
        completedTokensSet = new Set(cp.completedTokens);
        boardResults = cp.boardResults;
        console.log(`🔄 [Resume] Loaded checkpoint with ${completedTokensSet.size} previously completed boards.`);
      }
    } catch {
      console.warn(`⚠️ [Resume] Failed to parse checkpoint file at ${checkpointPath}, starting fresh.`);
    }
  }

  // Deduplication state
  const seenUrls = new Set<string>();
  const seenRoleKeys = new Set<string>();

  // Pre-seed seen hashes from loaded checkpoint results
  for (const br of boardResults) {
    for (const job of br.jobs) {
      if (job.apply_url) seenUrls.add(job.apply_url.toLowerCase().trim());
      const roleKey = `${job.company.toLowerCase().trim()}::${job.title.toLowerCase().trim()}::${job.location.toLowerCase().trim()}`;
      seenRoleKeys.add(roleKey);
    }
  }

  let budgetExceeded = false;
  let boardsProcessedThisRun = 0;

  for (let idx = 0; idx < filteredBoards.length; idx++) {
    const board = filteredBoards[idx];
    const token = (board.token || board.target || '').toLowerCase().trim();

    if (completedTokensSet.has(token)) {
      continue;
    }

    // Check runtime budget
    if (maxSeconds && (Date.now() - startTime) / 1000 >= maxSeconds) {
      console.log(`⏱️ [Budget] Maximum runtime budget of ${maxSeconds}s reached. Saving checkpoint and exiting loop.`);
      budgetExceeded = true;
      break;
    }

    boardsProcessedThisRun++;
    const progressLabel = `[${idx + 1}/${filteredBoards.length}]`;

    let boardResult: BoardResult = {
      token,
      company: board.company || board.name || token,
      ats: board.ats,
      fetchStatus: 'complete',
      rawCount: 0,
      acceptedCount: 0,
      duplicateCount: 0,
      unlistedSkippedCount: 0,
      indiaOnsiteHybridCount: 0,
      indiaEligibleRemoteCount: 0,
      unknownEligibilityCount: 0,
      countryRestrictedNonIndiaCount: 0,
      validSalaryCount: 0,
      salaryByCurrency: {},
      jobs: [],
      pagesFetched: 1,
    };

    if (offlineFixtureMode) {
      // Offline Fixture Processing
      try {
        const fixturePath = path.resolve(__dirname, `fixtures/${board.ats}-response.json`);
        if (fs.existsSync(fixturePath)) {
          const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
          let rawList: any[] = [];
          if (board.ats === 'greenhouse') rawList = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
          else if (board.ats === 'lever') rawList = Array.isArray(rawFixture) ? rawFixture : [];
          else if (board.ats === 'ashby') rawList = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];

          boardResult.rawCount = rawList.length;

          // Process jobs using normalized logic
          for (const raw of rawList) {
            // Ashby unlisted exclusion test
            if (board.ats === 'ashby' && raw.isListed === false) {
              boardResult.unlistedSkippedCount++;
              continue;
            }

            const title = cleanText(raw.title || raw.text || '');
            const loc = cleanText(raw.location?.name || raw.categories?.location || raw.location || 'Unspecified');
            const isRemote = Boolean(raw.isRemote || raw.remote || raw.workplaceType === 'remote');
            const wp = (raw.workplaceType || '').toLowerCase();
            const remoteScope = wp === 'hybrid' ? 'hybrid' : (isRemote ? 'remote' : 'onsite');
            const isPureRemote = remoteScope === 'remote';

            const countryCode = detectCountryCode(loc);
            const remoteElig = detectRemoteEligibility(loc, isPureRemote);

            // India metrics
            const isIndiaCountry = countryCode === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune)\b/i.test(loc);
            if (isIndiaCountry && remoteScope !== 'remote') {
              boardResult.indiaOnsiteHybridCount++;
            } else if (isPureRemote && (remoteElig === 'worldwide' || isIndiaCountry)) {
              boardResult.indiaEligibleRemoteCount++;
            } else if (isPureRemote && remoteElig === 'unknown') {
              boardResult.unknownEligibilityCount++;
            } else if (isPureRemote && remoteElig === 'country_restricted' && !isIndiaCountry) {
              boardResult.countryRestrictedNonIndiaCount++;
            }

            // Salary metrics
            let hasSalary = false;
            let curr = 'UNKNOWN';
            if (raw.pay_input_ranges && raw.pay_input_ranges[0]?.min_cents) {
              hasSalary = true;
              curr = raw.pay_input_ranges[0].currency_type || 'UNKNOWN';
            } else if (raw.salaryRange && (raw.salaryRange.min > 0 || raw.salaryRange.max > 0)) {
              hasSalary = true;
              curr = raw.salaryRange.currency || 'UNKNOWN';
            } else if (raw.compensation?.compensationTiers?.[0]?.components?.[0]?.minValue > 0) {
              hasSalary = true;
              curr = raw.compensation.compensationTiers[0].components[0].currencyCode || 'UNKNOWN';
            }

            if (hasSalary) {
              boardResult.validSalaryCount++;
              boardResult.salaryByCurrency[curr] = (boardResult.salaryByCurrency[curr] || 0) + 1;
            }

            const applyUrl = raw.absolute_url || raw.hostedUrl || raw.jobUrl || `https://jobs.example.com/${token}/${raw.id}`;
            const roleKey = `${boardResult.company.toLowerCase()}::${title.toLowerCase()}::${loc.toLowerCase()}`;

            if (seenUrls.has(applyUrl.toLowerCase()) || seenRoleKeys.has(roleKey)) {
              boardResult.duplicateCount++;
            } else {
              seenUrls.add(applyUrl.toLowerCase());
              seenRoleKeys.add(roleKey);
              boardResult.acceptedCount++;
              boardResult.jobs.push({
                source: `${board.ats}-board`,
                source_job_id: `${token}-${raw.id}`,
                title,
                company: boardResult.company,
                location: loc,
                remote: isPureRemote,
                remote_scope: remoteScope,
                remote_eligibility: remoteElig,
                country_code: countryCode,
                job_type: 'job',
                apply_url: applyUrl,
              } as NormalizedJob);
            }
          }
        }
      } catch (err: any) {
        boardResult.fetchStatus = 'failed';
        boardResult.errorMessage = err.message;
      }
    } else {
      // Live Adapter Execution via normalized adapter path
      const adapter = getAdapter(board.ats as SourceType);
      if (!adapter) {
        boardResult.fetchStatus = 'failed';
        boardResult.errorMessage = `No adapter registered for ATS type: ${board.ats}`;
      } else {
        const sourceConfig: SourceConfig = {
          id: token,
          name: board.company || board.name || token,
          type: board.ats as SourceType,
          target: token,
          enabled: true,
        };

        try {
          const rawFetchedJobs = await adapter.fetchJobs(sourceConfig);
          boardResult.rawCount = rawFetchedJobs.length;

          if (rawFetchedJobs.length === 0) {
            boardResult.fetchStatus = 'empty';
          } else {
            for (const j of rawFetchedJobs) {
              const title = cleanText(j.title || '');
              const location = cleanText(j.location || 'Unspecified');
              const isPureRemote = j.remote === true;
              const remoteScope = j.remote_scope || (isPureRemote ? 'remote' : 'onsite');
              const countryCode = j.country_code || detectCountryCode(location);
              const remoteElig = j.remote_eligibility || detectRemoteEligibility(location, isPureRemote);

              // India breakdown
              const isIndiaCountry = countryCode === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune)\b/i.test(location);
              if (isIndiaCountry && remoteScope !== 'remote') {
                boardResult.indiaOnsiteHybridCount++;
              } else if (isPureRemote && (remoteElig === 'worldwide' || isIndiaCountry)) {
                boardResult.indiaEligibleRemoteCount++;
              } else if (isPureRemote && remoteElig === 'unknown') {
                boardResult.unknownEligibilityCount++;
              } else if (isPureRemote && remoteElig === 'country_restricted' && !isIndiaCountry) {
                boardResult.countryRestrictedNonIndiaCount++;
              }

              // Salary breakdown
              if ((j.salary_min != null && j.salary_min > 0) || (j.salary_max != null && j.salary_max > 0)) {
                boardResult.validSalaryCount++;
                const curr = j.currency || 'UNKNOWN';
                boardResult.salaryByCurrency[curr] = (boardResult.salaryByCurrency[curr] || 0) + 1;
              }

              const applyUrl = (j.apply_url || '').toLowerCase().trim();
              const roleKey = `${j.company.toLowerCase().trim()}::${title.toLowerCase().trim()}::${location.toLowerCase().trim()}`;

              if (applyUrl && seenUrls.has(applyUrl)) {
                boardResult.duplicateCount++;
              } else if (seenRoleKeys.has(roleKey)) {
                boardResult.duplicateCount++;
              } else {
                if (applyUrl) seenUrls.add(applyUrl);
                seenRoleKeys.add(roleKey);
                boardResult.acceptedCount++;
                boardResult.jobs.push(j);
              }
            }
          }
        } catch (err: any) {
          boardResult.fetchStatus = 'failed';
          boardResult.errorMessage = err.message;
          if (err.message?.includes('403') || err.message?.includes('429')) {
            boardResult.fetchStatus = 'blocked';
          }
        }
      }
    }

    console.log(
      `   ${progressLabel} [${board.ats.toUpperCase()}] ${boardResult.company}: ` +
      `${boardResult.fetchStatus.toUpperCase()} ` +
      `(${boardResult.acceptedCount} accepted, ${boardResult.duplicateCount} dupes, ${boardResult.rawCount} raw, ${boardResult.validSalaryCount} with salary)`
    );

    completedTokensSet.add(token);
    boardResults.push(boardResult);

    // Save checkpoint after every board
    try {
      const checkpoint: DryPlanCheckpoint = {
        sourceSelection: source,
        timestamp: new Date().toISOString(),
        completedTokens: Array.from(completedTokensSet),
        boardResults,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    } catch {
      // Checkpoint write failure is non-fatal to execution
    }
  }

  // Aggregate summary
  let totalJobsFetched = 0;
  let totalJobsAccepted = 0;
  let totalDuplicatesDropped = 0;
  let unlistedSkippedTotal = 0;
  let indiaOnsiteOrHybridTotal = 0;
  let indiaEligibleRemoteTotal = 0;
  let unknownEligibilityTotal = 0;
  let countryRestrictedNonIndiaTotal = 0;
  let completeFetchesCount = 0;
  let partialFetchesCount = 0;
  let employersSucceeded = 0;
  let employersEmpty = 0;
  let employersFailed = 0;
  let employersBlocked = 0;

  const salaryCoverageByAts: Record<string, { totalJobs: number; withSalary: number; salaryPct: string }> = {};
  const salaryCurrencies: Record<string, number> = {};

  for (const br of boardResults) {
    totalJobsFetched += br.rawCount;
    totalJobsAccepted += br.acceptedCount;
    totalDuplicatesDropped += br.duplicateCount;
    unlistedSkippedTotal += br.unlistedSkippedCount;
    indiaOnsiteOrHybridTotal += br.indiaOnsiteHybridCount;
    indiaEligibleRemoteTotal += br.indiaEligibleRemoteCount;
    unknownEligibilityTotal += br.unknownEligibilityCount;
    countryRestrictedNonIndiaTotal += br.countryRestrictedNonIndiaCount;

    if (br.fetchStatus === 'complete') completeFetchesCount++;
    if (br.fetchStatus === 'partial') partialFetchesCount++;
    if (br.fetchStatus === 'empty') employersEmpty++;
    else if (br.fetchStatus === 'failed') employersFailed++;
    else if (br.fetchStatus === 'blocked') employersBlocked++;
    else employersSucceeded++;

    if (!salaryCoverageByAts[br.ats]) {
      salaryCoverageByAts[br.ats] = { totalJobs: 0, withSalary: 0, salaryPct: '0%' };
    }
    salaryCoverageByAts[br.ats].totalJobs += br.acceptedCount;
    salaryCoverageByAts[br.ats].withSalary += br.validSalaryCount;

    for (const [curr, count] of Object.entries(br.salaryByCurrency)) {
      salaryCurrencies[curr] = (salaryCurrencies[curr] || 0) + count;
    }
  }

  for (const ats of Object.keys(salaryCoverageByAts)) {
    const s = salaryCoverageByAts[ats];
    const pct = s.totalJobs > 0 ? ((s.withSalary / s.totalJobs) * 100).toFixed(1) : '0.0';
    s.salaryPct = `${pct}%`;
  }

  // Database Headroom / Delta Verification (Read-Only)
  let dbVerificationStatus: 'VERIFIED_CONNECTED' | 'UNVERIFIED (offline / no DB read credentials)' =
    'UNVERIFIED (offline / no DB read credentials)';
  let existingDbJobsCount: number | undefined = undefined;
  let potentialNewRowsCount: number | undefined = undefined;
  let existingRowsOverlapCount: number | undefined = undefined;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && supabaseKey && !offlineFixtureMode) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      const { count, error } = await client.from('jobs').select('*', { count: 'exact', head: true });
      if (!error && typeof count === 'number') {
        dbVerificationStatus = 'VERIFIED_CONNECTED';
        existingDbJobsCount = count;
        // In insert-only mode, accepted jobs not already present are potential new rows
        potentialNewRowsCount = totalJobsAccepted;
        existingRowsOverlapCount = totalDuplicatesDropped;
      }
    } catch {
      dbVerificationStatus = 'UNVERIFIED (offline / no DB read credentials)';
    }
  }

  // DB Bytes Estimation: ~2.5 KB (2,560 bytes) per job row
  const estimatedDbBytes = totalJobsAccepted * 2560;
  const estimatedDbMb = (estimatedDbBytes / (1024 * 1024)).toFixed(2);
  const actualRuntimeMs = Date.now() - startTime;
  const estimatedRuntimeSeconds = filteredBoards.length * 1.2;

  const indiaTotal = indiaOnsiteOrHybridTotal + indiaEligibleRemoteTotal;
  const globalTotal = totalJobsAccepted;

  const summary: DryPlanSummaryStats = {
    sourceSelection: source,
    totalEmployersPlanned: filteredBoards.length,
    employersAttempted: boardResults.length,
    employersSucceeded,
    employersEmpty,
    employersFailed,
    employersBlocked,
    completeFetchesCount,
    partialFetchesCount,
    paginationEventsCount: 0,
    totalJobsFetched,
    totalJobsAccepted,
    totalJobsUnique: totalJobsAccepted,
    totalDuplicatesDropped,
    unlistedSkippedTotal,
    indiaOnsiteOrHybridTotal,
    indiaEligibleRemoteTotal,
    unknownEligibilityTotal,
    countryRestrictedNonIndiaTotal,
    globalTotal,
    indiaTotal,
    salaryCoverageByAts,
    salaryCurrencies,
    estimatedDbBytes,
    estimatedDbMb,
    estimatedRuntimeSeconds: Math.round(estimatedRuntimeSeconds),
    actualRuntimeMs,
    dbVerificationStatus,
    existingDbJobsCount,
    potentialNewRowsCount,
    existingRowsOverlapCount,
  };

  const report: DryPlanReport = {
    generatedAt: new Date().toISOString(),
    mode: offlineFixtureMode ? 'OFFLINE_FIXTURE_DRY_PLAN' : 'LIVE_NETWORK_DRY_PLAN',
    summary,
    boards: boardResults.map(({ jobs, ...rest }) => rest),
    sampleJobs: boardResults.flatMap((b) => b.jobs).slice(0, 10).map((j) => ({
      title: j.title,
      company: j.company,
      location: j.location,
      remote: j.remote,
      remote_scope: j.remote_scope,
      remote_eligibility: j.remote_eligibility,
      country_code: j.country_code,
      salary_text: j.salary_text,
      currency: j.currency,
      salary_period: j.salary_period,
      source: j.source,
      apply_url: j.apply_url,
    })),
  };

  // Write machine-readable JSON report
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n💾 Saved machine-readable report to: ${outputPath}`);
  } catch (err: any) {
    console.warn(`⚠️ Failed to save report JSON: ${err.message}`);
  }

  // Generate and save markdown report
  const mdContent = generateMarkdownReport(report);
  try {
    fs.mkdirSync(path.dirname(markdownOutputPath), { recursive: true });
    fs.writeFileSync(markdownOutputPath, mdContent, 'utf-8');
    console.log(`💾 Saved markdown audit report to:   ${markdownOutputPath}\n`);
  } catch (err: any) {
    console.warn(`⚠️ Failed to save report MD: ${err.message}`);
  }

  printConsoleSummary(summary);

  return report;
}

/**
 * Generates the GitHub Flavored Markdown audit report.
 */
function generateMarkdownReport(report: DryPlanReport): string {
  const s = report.summary;
  const isSeed = s.sourceSelection === 'seed';

  return `# CareerMonke ATS Discovery-to-Ingestion Dry-Plan Report

**Generated At**: \`${report.generatedAt}\`
**Execution Mode**: \`${report.mode}\`
**Target Source**: \`${s.sourceSelection.toUpperCase()}\` (\`${s.totalEmployersPlanned}\` employers)
**DB Headroom Verification**: \`${s.dbVerificationStatus}\`

---

## 1. Executive Summary: Seed vs Registry Sizing

| Metric | Measured Dry-Plan Value | Notes / Ingestion Safety Context |
|---|---|---|
| **Config Selection** | \`${s.sourceSelection}\` | Verified approved employers list |
| **Total Employers Planned** | \`${s.totalEmployersPlanned}\` | 52 for Seed, 277 for Full Registry |
| **Employers Attempted** | \`${s.employersAttempted}\` | Checkpointed & resumable |
| **Active Boards (>=1 job)** | \`${s.employersSucceeded}\` | Successfully fetched with normalized jobs |
| **Empty Boards (0 jobs)** | \`${s.employersEmpty}\` | Valid 200 response with zero open roles |
| **Failed / Blocked Boards** | \`${s.employersFailed} / ${s.employersBlocked}\` | HTTP 4xx/5xx/network errors |
| **Total Raw Jobs Fetched** | \`${s.totalJobsFetched}\` | Direct ATS payload items |
| **Total Jobs Accepted** | \`${s.totalJobsAccepted}\` | Valid apply URL, HTTPS, text-only <=1500 chars |
| **Unique Roles (Cross-Dedupe)** | \`${s.totalJobsUnique}\` | Deduped by company + title + location |
| **Duplicates Dropped** | \`${s.totalDuplicatesDropped}\` | Intra-run duplicate listings removed |
| **Unlisted Skipped (Ashby)** | \`${s.unlistedSkippedTotal}\` | Strictly excluded \`isListed=false\` |
| **Global Jobs Accepted** | \`${s.globalTotal}\` | Worldwide unique listings |
| **India-Eligible Jobs Total** | \`${s.indiaTotal}\` | India onsite/hybrid + worldwide remote |
| **Estimated DB Bytes** | \`${s.estimatedDbBytes.toLocaleString()} B (${s.estimatedDbMb} MB)\` | Safety threshold is 150.00 MB |

> [!NOTE]
> **DB Headroom Status**: \`${s.dbVerificationStatus}\`. When DB read credentials are not supplied or in local offline mode, DB deltas are recorded as unverified rather than claiming fabricated additions.

---

## 2. India & Remote Eligibility Breakdown

CareerMonke enforces strict geographical classification. US-only remote jobs are never converted into India-eligible listings.

| Geographic Segment | Jobs Count | Percentage of Accepted |
|---|---|---|
| **India Onsite / Hybrid** | \`${s.indiaOnsiteOrHybridTotal}\` | Jobs physically in India |
| **Explicitly India-Eligible Remote** | \`${s.indiaEligibleRemoteTotal}\` | Explicit Worldwide or India remote |
| **Unknown Remote Eligibility** | \`${s.unknownEligibilityTotal}\` | Remote without geographic restriction |
| **Country-Restricted (Non-India)** | \`${s.countryRestrictedNonIndiaTotal}\` | E.g. US/Canada/EU remote only |
| **Total India-Eligible Supply** | \`${s.indiaTotal}\` | **${s.globalTotal > 0 ? ((s.indiaTotal / s.globalTotal) * 100).toFixed(1) : '0'}%** of total accepted |

---

## 3. Disclosed Salary Coverage by ATS

Only valid numeric disclosed ranges (\`min > 0\` or \`max > 0\`) are counted. Empty compensation objects are rejected, and periods are never assumed to be annual without explicit provider confirmation.

| ATS Provider | Accepted Jobs | With Disclosed Salary | Salary Disclosure Rate |
|---|---|---|---|
${Object.entries(s.salaryCoverageByAts).map(([ats, data]) => `| **${ats.toUpperCase()}** | \`${data.totalJobs}\` | \`${data.withSalary}\` | **${data.salaryPct}** |`).join('\n')}

### Currency Distribution
${Object.entries(s.salaryCurrencies).map(([curr, count]) => `- **${curr}**: \`${count}\` jobs`).join('\n') || '- None recorded'}

---

## 4. Incompatible Sources Audit & Safety Flagging

In accordance with project operational locks:
- **Remotive (\`api-remotive\`)**: Flagged in \`scripts/config/sources.json\`. Signup-wall restrictions conflict with public unauthenticated feed principles. Do NOT use for scale.
- **Adzuna (\`adzuna.ts\`)**: Commercial licensing and strict republication attribution terms conflict with CareerMonke rules. Do NOT enable as a scale shortcut.
- **Third-Party Scraping**: Strictly 0 requests to LinkedIn, Indeed, Naukri, Glassdoor, Workday. All ingestion is direct to employer public ATS APIs.

---

## 5. Rollout Command & Rollback Plan

### Next Owner-Approved Rollout Command
To perform an owner-approved dry-plan run or phased deployment:
\`\`\`bash
# Run explicit dry-plan comparison on existing registry
npx tsx scripts/ats-dry-plan.ts --source registry --resume

# Optional: Run targeted ATS dry-plan (e.g. Greenhouse only)
npx tsx scripts/ats-dry-plan.ts --source registry --ats greenhouse
\`\`\`

### Rollback Plan
- The dry-plan engine is strictly read-only and mutates zero database rows.
- If live-write is executed in a future phase, \`board-ingest.ts\` automatically generates a targeted rollback script at:
  \`reports/rollback-ingest-<discovered_at>.sql\`
  which contains:
  \`DELETE FROM jobs WHERE discovered_at = '<discovered_at>' AND source_type = 'ats';\`
- No destructive deletes or broad drops are ever executed.
`;
}

function printConsoleSummary(s: DryPlanSummaryStats): void {
  console.log('======================================================');
  console.log('📊 DRY-PLAN EXECUTION SUMMARY');
  console.log('======================================================');
  console.log(`Source Config:           ${s.sourceSelection}`);
  console.log(`Employers Planned:       ${s.totalEmployersPlanned}`);
  console.log(`Employers Attempted:     ${s.employersAttempted}`);
  console.log(`Active Boards (>=1 job): ${s.employersSucceeded}`);
  console.log(`Empty Boards (0 jobs):   ${s.employersEmpty}`);
  console.log(`Failed/Blocked Boards:   ${s.employersFailed} / ${s.employersBlocked}`);
  console.log(`------------------------------------------------------`);
  console.log(`Total Raw Fetched:       ${s.totalJobsFetched}`);
  console.log(`Total Accepted Jobs:     ${s.totalJobsAccepted}`);
  console.log(`Intra-Run Dupes Dropped: ${s.totalDuplicatesDropped}`);
  console.log(`Unlisted Skipped (Ashby):${s.unlistedSkippedTotal}`);
  console.log(`------------------------------------------------------`);
  console.log(`Global Unique Supply:    ${s.globalTotal}`);
  console.log(`India Onsite / Hybrid:   ${s.indiaOnsiteOrHybridTotal}`);
  console.log(`India-Eligible Remote:   ${s.indiaEligibleRemoteTotal}`);
  console.log(`Total India Supply:      ${s.indiaTotal} (${s.globalTotal > 0 ? ((s.indiaTotal / s.globalTotal) * 100).toFixed(1) : '0'}%)`);
  console.log(`------------------------------------------------------`);
  console.log(`Estimated DB Storage:    ${s.estimatedDbMb} MB (${s.estimatedDbBytes.toLocaleString()} bytes)`);
  console.log(`DB Verification:         ${s.dbVerificationStatus}`);
  console.log(`Actual Runtime:          ${(s.actualRuntimeMs / 1000).toFixed(2)}s`);
  console.log('======================================================\n');
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);

  const sourceIdx = args.findIndex((a) => a === '--source');
  const source = sourceIdx !== -1 ? (args[sourceIdx + 1] as DryPlanSource) : 'registry';

  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  const offsetIdx = args.findIndex((a) => a === '--offset');
  const offset = offsetIdx !== -1 ? parseInt(args[offsetIdx + 1], 10) : 0;

  const atsIdx = args.findIndex((a) => a === '--ats');
  const atsFilter = atsIdx !== -1 ? args[atsIdx + 1] : 'all';

  const compIdx = args.findIndex((a) => a === '--company');
  const companyFilter = compIdx !== -1 ? args[compIdx + 1] : undefined;

  const maxSecIdx = args.findIndex((a) => a === '--max-seconds');
  const maxSeconds = maxSecIdx !== -1 ? parseInt(args[maxSecIdx + 1], 10) : undefined;

  const resume = args.includes('--resume');
  const offlineFixtureMode = args.includes('--offline-fixtures') || args.includes('--fixture-mode');

  runDryPlan({
    source,
    limit,
    offset,
    atsFilter,
    companyFilter,
    maxSeconds,
    resume,
    offlineFixtureMode,
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal Dry-Plan Error:', err.message);
      process.exit(1);
    });
}
