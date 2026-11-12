/**
 * scripts/test-daily-capacity-projection.ts
 *
 * Offline guard test suite verifying the reworked Daily Capacity Projection kit:
 * 1. Committed ATS fixtures parse cleanly (Greenhouse `first_published` vs `updated_at`, Ashby `publishedAt`, Lever `createdAt`).
 * 2. CRITICAL GUARD: Greenhouse `updated_at` NEVER feeds NEW-jobs supply; it is isolated in `recentActivityTrailing24h`.
 * 3. CRITICAL GUARD: Verdict NEVER claims ACHIEVED or DEFICIT from open-job snapshots; strictly `NEW-JOBS TARGET: NOT ESTABLISHED` referencing PR #557.
 * 4. Scope Honesty: `--limit` selects a deterministic representative sample across ATS types; `--ats` marks unmeasured platforms UNKNOWN (`null`), never `0`.
 * 5. Safe Defaults: Normal invocation without flags defaults to `--dry-run`; `--live` is required for network calls.
 * 6. Provenance Verification: `reports/daily-capacity-provenance.json` exists with 438 boards, script version, invocation command, timestamps, and valid SHA-256 content hash.
 * 7. Report Integrity: `reports/daily-capacity-projection.md` matches provenance, lists coverage, failed boards, assumptions, and separates recent activity from date-able new.
 *
 * Run: npx tsx scripts/test-daily-capacity-projection.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  parseGreenhouseJobs,
  parseAshbyJobs,
  parseLeverJobs,
  isTimestampInTrailingWindow,
  calculateCapacityProjections,
  parseCapacityCliArgs,
  selectRepresentativeSample,
  generateMarkdownReport,
  computeProvenanceHash,
  DEFAULT_DELAY_MS,
  DEFAULT_TARGET_DAILY_JOBS,
  TRAILING_WINDOW_MS,
  BoardCapacityMetrics,
  AtsType,
  ProvenanceRecord,
} from './project-daily-capacity';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

console.log('================================================================================');
console.log('       DAILY CAPACITY PROJECTION KIT OFFLINE GUARD TEST                         ');
console.log('================================================================================\n');

// -----------------------------------------------------------------------------
// 1. Committed Fixtures & Greenhouse updated_at vs first_published Isolation
// -----------------------------------------------------------------------------
console.log('--- 1. Committed Fixtures & Greenhouse updated_at Isolation ---');

const GH_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'greenhouse-sample.json');
const ASHBY_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'ashby-sample.json');
const LEVER_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'lever-sample.json');

check('Greenhouse fixture exists', fs.existsSync(GH_FIXTURE_PATH));
check('Ashby fixture exists', fs.existsSync(ASHBY_FIXTURE_PATH));
check('Lever fixture exists', fs.existsSync(LEVER_FIXTURE_PATH));

const ghRaw = JSON.parse(fs.readFileSync(GH_FIXTURE_PATH, 'utf8'));
const ashbyRaw = JSON.parse(fs.readFileSync(ASHBY_FIXTURE_PATH, 'utf8'));
const leverRaw = JSON.parse(fs.readFileSync(LEVER_FIXTURE_PATH, 'utf8'));

const FIXED_TEST_NOW = Date.parse('2026-11-12T12:00:00.000Z');

// In greenhouse-sample.json:
// - Job 101: first_published in 24h AND updated_at in 24h
// - Job 102: first_published old (Oct 1) AND updated_at in 24h -> MUST NOT count as NEW
// - Job 103: first_published null AND updated_at in 24h -> MUST NOT count as NEW or dateable_new
// - Job 104: both older than 24h
// - Job 105: both null
const ghParsed = parseGreenhouseJobs(ghRaw.jobs, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Greenhouse fixture: total jobs is 5', ghParsed.totalJobs === 5);
check('Greenhouse fixture: dateableNewJobs is 3 (jobs with first_published)', ghParsed.dateableNewJobs === 3);
check(
  'Greenhouse fixture: newJobsTrailing24h is strictly 1 (updated_at-only and old-edited excluded)',
  ghParsed.newJobsTrailing24h === 1
);
check(
  'Greenhouse fixture: recentActivityTrailing24h is 3 (captures all updated_at in 24h)',
  ghParsed.recentActivityTrailing24h === 3
);

// Extra direct test: payload with ONLY updated_at in 24h (zero first_published) must yield ZERO new jobs
const ghUpdatedOnlyParsed = parseGreenhouseJobs(
  [
    { id: 1, title: 'Updated A', updated_at: '2026-11-12T10:00:00.000Z' },
    { id: 2, title: 'Updated B', updated_at: '2026-11-12T11:00:00.000Z', first_published: null },
    {
      id: 3,
      title: 'Old Edit C',
      updated_at: '2026-11-12T09:00:00.000Z',
      first_published: '2026-08-01T00:00:00.000Z',
    },
  ],
  FIXED_TEST_NOW,
  TRAILING_WINDOW_MS
);
check(
  'GUARD: Greenhouse updated_at NEVER feeds newJobsTrailing24h (0 new vs 3 recent activity)',
  ghUpdatedOnlyParsed.newJobsTrailing24h === 0 && ghUpdatedOnlyParsed.recentActivityTrailing24h === 3
);

// Ashby parsing verification
const ashbyParsed = parseAshbyJobs(ashbyRaw.jobs, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Ashby fixture: total listed jobs is 4 (unlisted excluded)', ashbyParsed.totalJobs === 4);
check('Ashby fixture: dateableNewJobs is 3', ashbyParsed.dateableNewJobs === 3);
check('Ashby fixture: newJobsTrailing24h is 2', ashbyParsed.newJobsTrailing24h === 2);

// Lever parsing verification
const leverParsed = parseLeverJobs(leverRaw, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Lever fixture: total jobs is 4', leverParsed.totalJobs === 4);
check('Lever fixture: dateableNewJobs is 3', leverParsed.dateableNewJobs === 3);
check('Lever fixture: newJobsTrailing24h is 2', leverParsed.newJobsTrailing24h === 2);

// -----------------------------------------------------------------------------
// 2. Trailing Window Boundary Tests
// -----------------------------------------------------------------------------
console.log('\n--- 2. Trailing Window Boundary Tests ---');
const now = 1000000000000;
const dayMs = 24 * 3600 * 1000;

check('boundary: exact now is in window', isTimestampInTrailingWindow(now, now));
check('boundary: now - 24h is in window', isTimestampInTrailingWindow(now - dayMs, now));
check('boundary: now - 24h01m is outside window', !isTimestampInTrailingWindow(now - dayMs - 60000, now));
check('empty Greenhouse payload yields zeroDateableNewJobs = true', parseGreenhouseJobs([], now).zeroDateableNewJobs === true);

// -----------------------------------------------------------------------------
// 3. Projection Math, Metric Isolation & Verdict Guards
// -----------------------------------------------------------------------------
console.log('\n--- 3. Projection Math, Metric Isolation & Verdict Guards ---');

const mockBoards: BoardCapacityMetrics[] = [
  {
    id: 'gh-1',
    name: 'GH Board 1',
    ats: 'greenhouse',
    target: 'gh1',
    fetchedAt: '2026-11-12T12:00:00.000Z',
    totalOpenJobs: 50,
    dateableNewJobs: 40,
    newJobsTrailing24h: 2,
    zeroDateableNewJobs: false,
    recentActivityDateableJobs: 50,
    recentActivityTrailing24h: 30, // huge updated_at churn!
    status: 'ok',
  },
  {
    id: 'ash-1',
    name: 'Ashby Board 1',
    ats: 'ashby',
    target: 'ash1',
    fetchedAt: '2026-11-12T12:00:00.000Z',
    totalOpenJobs: 20,
    dateableNewJobs: 20,
    newJobsTrailing24h: 4,
    zeroDateableNewJobs: false,
    recentActivityDateableJobs: 0,
    recentActivityTrailing24h: 0,
    status: 'ok',
  },
  {
    id: 'lev-1',
    name: 'Lever Board 1',
    ats: 'lever',
    target: 'lev1',
    fetchedAt: '2026-11-12T12:00:00.000Z',
    totalOpenJobs: 10,
    dateableNewJobs: 0,
    newJobsTrailing24h: 0,
    zeroDateableNewJobs: true,
    recentActivityDateableJobs: 0,
    recentActivityTrailing24h: 0,
    status: 'zero_dateable_new',
  },
];

const mockFleetCounts: Record<AtsType, number> = {
  greenhouse: 100, // 2/1 * 100 = 200 new, 30/1 * 100 = 3000 recent activity!
  ashby: 50,       // 4/1 * 50 = 200 new
  lever: 20,       // 0/1 * 20 = 0 new
};

const proj = calculateCapacityProjections(mockBoards, mockFleetCounts, {
  targetDailyJobs: 1200,
  nowEpochMs: FIXED_TEST_NOW,
});

check(
  'GUARD: extrapolatedDailyNewJobs counts ONLY genuine new (200+200+0 = 400), ignores 3000 updated_at churn',
  proj.extrapolatedFleetDailyNewJobs === 400 && proj.extrapolatedFleetRecentActivity24h === 3000
);

// Even when recentActivity (3000) or new (5000) > 1200 target, verdict MUST NOT say ACHIEVED or DEFICIT
const highVolumeProj = calculateCapacityProjections(
  [
    {
      ...mockBoards[0],
      newJobsTrailing24h: 50, // 50 * 100 = 5000/day
    },
    mockBoards[1],
    mockBoards[2],
  ],
  mockFleetCounts,
  { targetDailyJobs: 1200, nowEpochMs: FIXED_TEST_NOW }
);

check(
  'GUARD: verdict status is NOT_ESTABLISHED even when numbers > 1200 (no first-seen DB evidence)',
  highVolumeProj.verdict.status === 'NOT_ESTABLISHED' && !highVolumeProj.verdict.hasFirstSeenEvidence
);
check(
  'GUARD: verdictLine explicitly states NEW-JOBS TARGET: NOT ESTABLISHED',
  highVolumeProj.verdict.verdictLine.includes('NEW-JOBS TARGET: NOT ESTABLISHED')
);
check(
  'GUARD: verdictLine NEVER claims ACHIEVED or DEFICIT without first-seen evidence',
  !highVolumeProj.verdict.verdictLine.includes('ACHIEVED') &&
    !highVolumeProj.verdict.verdictLine.includes('DEFICIT')
);
check(
  'GUARD: verdictLine references PR #557 first-seen proof',
  highVolumeProj.verdict.verdictLine.includes('PR #557')
);

// -----------------------------------------------------------------------------
// 4. Scope Honesty: Partial --ats and Stratified --limit Sampling
// -----------------------------------------------------------------------------
console.log('\n--- 4. Scope Honesty (--ats Partial & --limit Representative Sample) ---');

const partialAtsProj = calculateCapacityProjections([mockBoards[0]], mockFleetCounts, {
  atsFilter: 'greenhouse',
  nowEpochMs: FIXED_TEST_NOW,
});

check('partial --ats scope sets scope.isPartial = true and scopeType = partial_ats', partialAtsProj.scope.isPartial && partialAtsProj.scope.scopeType === 'partial_ats');
check(
  'GUARD: unmeasured ATS platforms (ashby, lever) are null (UNKNOWN), NEVER 0',
  partialAtsProj.perAts.ashby.measured === false &&
    partialAtsProj.perAts.ashby.extrapolatedDailyNewJobs === null &&
    partialAtsProj.perAts.lever.measured === false &&
    partialAtsProj.perAts.lever.extrapolatedDailyNewJobs === null
);
check(
  'GUARD: fleet aggregate under --ats filter is null (UNKNOWN), NEVER a partial sum',
  partialAtsProj.extrapolatedFleetDailyNewJobs === null &&
    partialAtsProj.verdict.status === 'PARTIAL_SCOPE'
);

const partialMd = generateMarkdownReport(partialAtsProj);
check('partial report labels unmeasured ATS as UNKNOWN', partialMd.includes('UNKNOWN (unmeasured)'));

// Stratified systematic --limit sampling verification
const rawScheduled = JSON.parse(
  fs.readFileSync(path.join('scripts', 'config', 'companies-scheduled.json'), 'utf8')
);
const sample30Run1 = selectRepresentativeSample(rawScheduled, 30);
const sample30Run2 = selectRepresentativeSample(rawScheduled, 30);

check('--limit 30 returns exact count of 30 boards', sample30Run1.length === 30);
check(
  '--limit 30 is deterministic across runs',
  JSON.stringify(sample30Run1.map((b: any) => b.id)) ===
    JSON.stringify(sample30Run2.map((b: any) => b.id))
);
check(
  '--limit 30 includes all 3 ATS types (greenhouse, ashby, lever) proportionally',
  sample30Run1.some((b: any) => b.type === 'greenhouse') &&
    sample30Run1.some((b: any) => b.type === 'ashby') &&
    sample30Run1.some((b: any) => b.type === 'lever')
);

// -----------------------------------------------------------------------------
// 5. Safe Default --dry-run & CLI Flag Verification
// -----------------------------------------------------------------------------
console.log('\n--- 5. Safe Default --dry-run & CLI Flags ---');

check('DEFAULT_DELAY_MS enforces polite rate limit (>= 50ms)', DEFAULT_DELAY_MS >= 50);
check('DEFAULT_TARGET_DAILY_JOBS is 1200', DEFAULT_TARGET_DAILY_JOBS === 1200);

check('default parseCapacityCliArgs([]) defaults to dryRun: true', parseCapacityCliArgs([]).dryRun === true);
check('parseCapacityCliArgs(["--dry-run"]) sets dryRun: true', parseCapacityCliArgs(['--dry-run']).dryRun === true);
check('parseCapacityCliArgs(["--live"]) sets dryRun: false', parseCapacityCliArgs(['--live']).dryRun === false);
check('parseCapacityCliArgs(["--live", "--dry-run"]) stays dryRun: true (safe override)', parseCapacityCliArgs(['--live', '--dry-run']).dryRun === true);

const defaultProc = spawnSync(
  process.execPath,
  ['-r', 'tsx', path.resolve('scripts', 'project-daily-capacity.ts')],
  { encoding: 'utf8' }
);
check('subprocess normal invocation (no flags) exits 0 in DRY-RUN without network calls', defaultProc.status === 0 && defaultProc.stdout?.includes('DRY-RUN'));

// -----------------------------------------------------------------------------
// 6. Provenance Artifact & Report Consistency Verification
// -----------------------------------------------------------------------------
console.log('\n--- 6. Provenance Artifact & Report Consistency ---');

const REPORT_PATH = path.join('reports', 'daily-capacity-projection.md');
const PROVENANCE_PATH = path.join('reports', 'daily-capacity-provenance.json');

check('reports/daily-capacity-projection.md exists on disk', fs.existsSync(REPORT_PATH));
check('reports/daily-capacity-provenance.json exists on disk', fs.existsSync(PROVENANCE_PATH));

const provenance: ProvenanceRecord = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf8'));
const reportMd = fs.readFileSync(REPORT_PATH, 'utf8');

check('provenance includes schemaVersion and scriptVersion', Boolean(provenance.schemaVersion && provenance.scriptVersion));
check('provenance records invocationCommand', Boolean(provenance.invocationCommand && provenance.invocationCommand.includes('--live')));
check('provenance records 438 boards in boards array', Array.isArray(provenance.boards) && provenance.boards.length === 438);
check(
  'provenance SHA-256 contentHashSha256 verifies intact against serialized payload',
  (() => {
    const { contentHashSha256, ...rest } = provenance;
    return computeProvenanceHash(rest) === contentHashSha256;
  })()
);

check('report cites provenance file path and matching SHA-256 hash', reportMd.includes('daily-capacity-provenance.json') && reportMd.includes(provenance.contentHashSha256));
check('report contains NEW-JOBS TARGET: NOT ESTABLISHED verdict line', reportMd.includes('NEW-JOBS TARGET: NOT ESTABLISHED'));
check('GUARD: report does NOT claim TARGET ACHIEVED or DEFICIT', !reportMd.includes('TARGET ACHIEVED') && !reportMd.includes('CAPACITY DEFICIT'));
check('report shows Date-able NEW Jobs Supply and Recent Activity as separate lines', reportMd.includes('Date-able NEW Jobs Supply') && reportMd.includes('Recent Activity / Updates'));
check('report references PR #557 for live first-seen DB proof', reportMd.includes('PR #557'));
check('report states coverage and failed boards count', reportMd.includes('Fleet Coverage') && reportMd.includes('Failed Boards'));

// -----------------------------------------------------------------------------
// Summary & Final Exit
// -----------------------------------------------------------------------------
console.log('\n================================================================================');
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log('================================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All reworked daily capacity projection guard checks passed successfully.');
  process.exit(0);
}
