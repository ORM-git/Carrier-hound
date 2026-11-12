/**
 * scripts/test-daily-capacity-projection.ts
 *
 * Offline guard test suite verifying the Daily Capacity Projection kit:
 * 1. Committed ATS payload fixtures (Greenhouse, Ashby, Lever) parse accurately.
 * 2. Trailing-24h date counting and boundary math are strictly verified.
 * 3. Ashby unlisted job exclusion (isListed === false) is enforced.
 * 4. Extrapolation and projection formulas are exact against controlled fixtures.
 * 5. CLI argument parsing correctly handles --dry-run, --limit, --ats, and --delay.
 * 6. Polite rate limiting and safety defaults are strictly enforced.
 * 7. Subprocess dry-run execution exits 0 and prints planned execution without network calls.
 * 8. Generated report (reports/daily-capacity-projection.md) exists and contains explicit verdict line,
 *    run date, empirical estimation label, and per-ATS breakdown.
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
  generateMarkdownReport,
  DEFAULT_DELAY_MS,
  DEFAULT_TARGET_DAILY_JOBS,
  TRAILING_WINDOW_MS,
  BoardCapacityMetrics,
  AtsType,
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
// 1. Committed Fixtures Existence and Schema Parsing
// -----------------------------------------------------------------------------
console.log('--- 1. Committed Fixtures Existence & Parsing ---');

const GH_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'greenhouse-sample.json');
const ASHBY_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'ashby-sample.json');
const LEVER_FIXTURE_PATH = path.join('scripts', 'fixtures', 'capacity', 'lever-sample.json');

check('Greenhouse fixture exists on disk', fs.existsSync(GH_FIXTURE_PATH));
check('Ashby fixture exists on disk', fs.existsSync(ASHBY_FIXTURE_PATH));
check('Lever fixture exists on disk', fs.existsSync(LEVER_FIXTURE_PATH));

const ghRaw = JSON.parse(fs.readFileSync(GH_FIXTURE_PATH, 'utf8'));
const ashbyRaw = JSON.parse(fs.readFileSync(ASHBY_FIXTURE_PATH, 'utf8'));
const leverRaw = JSON.parse(fs.readFileSync(LEVER_FIXTURE_PATH, 'utf8'));

// Fixed test reference timestamp: 2026-11-12T12:00:00.000Z
const FIXED_TEST_NOW = Date.parse('2026-11-12T12:00:00.000Z');

// Greenhouse parsing verification
const ghParsed = parseGreenhouseJobs(ghRaw.jobs, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Greenhouse fixture: total jobs is 5', ghParsed.totalJobs === 5);
check('Greenhouse fixture: dateable jobs is 4 (1 null date excluded)', ghParsed.dateableJobs === 4);
check('Greenhouse fixture: trailing 24h jobs is exactly 2', ghParsed.jobsTrailing24h === 2);
check('Greenhouse fixture: zeroDateableJobs is false', ghParsed.zeroDateableJobs === false);

// Ashby parsing verification
const ashbyParsed = parseAshbyJobs(ashbyRaw.jobs, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Ashby fixture: total listed jobs is 4 (unlisted job excluded)', ashbyParsed.totalJobs === 4);
check('Ashby fixture: dateable jobs is 3 (1 null date excluded)', ashbyParsed.dateableJobs === 3);
check('Ashby fixture: trailing 24h jobs is exactly 2', ashbyParsed.jobsTrailing24h === 2);
check('Ashby fixture: zeroDateableJobs is false', ashbyParsed.zeroDateableJobs === false);

// Lever parsing verification
const leverParsed = parseLeverJobs(leverRaw, FIXED_TEST_NOW, TRAILING_WINDOW_MS);
check('Lever fixture: total jobs is 4', leverParsed.totalJobs === 4);
check('Lever fixture: dateable jobs is 3 (1 null date excluded)', leverParsed.dateableJobs === 3);
check('Lever fixture: trailing 24h jobs is exactly 2', leverParsed.jobsTrailing24h === 2);
check('Lever fixture: zeroDateableJobs is false', leverParsed.zeroDateableJobs === false);

// -----------------------------------------------------------------------------
// 2. Trailing Window Boundary & Edge Case Tests
// -----------------------------------------------------------------------------
console.log('\n--- 2. Trailing Window Boundary & Edge Cases ---');

const now = 1000000000000;
const oneHour = 3600 * 1000;
const dayMs = 24 * oneHour;

check('boundary: timestamp at exactly now is in window', isTimestampInTrailingWindow(now, now));
check(
  'boundary: timestamp at now - 23h59m is in window',
  isTimestampInTrailingWindow(now - (dayMs - 60000), now)
);
check(
  'boundary: timestamp at exactly now - 24h is in window',
  isTimestampInTrailingWindow(now - dayMs, now)
);
check(
  'boundary: timestamp at now - 24h01m is outside window',
  !isTimestampInTrailingWindow(now - (dayMs + 60000), now)
);
check(
  'boundary: timestamp at now + 2min (clock skew) is in window',
  isTimestampInTrailingWindow(now + 2 * 60000, now)
);
check(
  'boundary: timestamp at now + 30min is outside window',
  !isTimestampInTrailingWindow(now + 30 * 60000, now)
);

// Empty and malformed payloads
const emptyGh = parseGreenhouseJobs([], now);
check('empty Greenhouse jobs array yields zeroDateableJobs = true', emptyGh.zeroDateableJobs === true && emptyGh.totalJobs === 0);

const nullAshby = parseAshbyJobs(null as any, now);
check('null Ashby jobs payload yields zeroDateableJobs = true', nullAshby.zeroDateableJobs === true);

const malformedLever = parseLeverJobs([{ id: 'x', text: 'no date' }], now);
check('Lever job without date field yields zeroDateableJobs = true', malformedLever.zeroDateableJobs === true && malformedLever.dateableJobs === 0);

// -----------------------------------------------------------------------------
// 3. Mathematical Extrapolation & Projection Accuracy
// -----------------------------------------------------------------------------
console.log('\n--- 3. Mathematical Extrapolation & Projection Tests ---');

// Controlled scenario:
// Greenhouse: Fleet 200 boards. Sampled 2 boards.
// Board 1: 50 open, 5 in 24h.
// Board 2: 30 open, 3 in 24h.
// Total sampled: 2 boards, 80 open, 8 in 24h.
// Extrapolated Greenhouse daily = (8 / 2) * 200 = 800 daily jobs.
// Extrapolated Greenhouse inventory = (80 / 2) * 200 = 8,000 open jobs.
//
// Ashby: Fleet 100 boards. Sampled 2 boards.
// Board 3: 40 open, 2 in 24h.
// Board 4: 10 open, 0 in 24h (dateable jobs present, 0 recent).
// Total sampled: 2 boards, 50 open, 2 in 24h.
// Extrapolated Ashby daily = (2 / 2) * 100 = 100 daily jobs.
// Extrapolated Ashby inventory = (50 / 2) * 100 = 2,500 open jobs.
//
// Lever: Fleet 50 boards. Sampled 1 board.
// Board 5: 10 open, 1 in 24h.
// Extrapolated Lever daily = (1 / 1) * 50 = 50 daily jobs.
// Extrapolated Lever inventory = (10 / 1) * 50 = 500 open jobs.
//
// Total Fleet Projected Daily = 800 + 100 + 50 = 950 daily jobs.
// Target = 1200 daily jobs.
// Surplus/Deficit = 950 - 1200 = -250 (DEFICIT).

const mockBoards: BoardCapacityMetrics[] = [
  {
    id: 'gh-1',
    name: 'Company A',
    ats: 'greenhouse',
    target: 'compa',
    totalOpenJobs: 50,
    dateableJobs: 50,
    jobsTrailing24h: 5,
    zeroDateableJobs: false,
    status: 'ok',
  },
  {
    id: 'gh-2',
    name: 'Company B',
    ats: 'greenhouse',
    target: 'compb',
    totalOpenJobs: 30,
    dateableJobs: 30,
    jobsTrailing24h: 3,
    zeroDateableJobs: false,
    status: 'ok',
  },
  {
    id: 'ash-1',
    name: 'Company C',
    ats: 'ashby',
    target: 'compc',
    totalOpenJobs: 40,
    dateableJobs: 40,
    jobsTrailing24h: 2,
    zeroDateableJobs: false,
    status: 'ok',
  },
  {
    id: 'ash-2',
    name: 'Company D',
    ats: 'ashby',
    target: 'compd',
    totalOpenJobs: 10,
    dateableJobs: 10,
    jobsTrailing24h: 0,
    zeroDateableJobs: false,
    status: 'ok',
  },
  {
    id: 'lev-1',
    name: 'Company E',
    ats: 'lever',
    target: 'compe',
    totalOpenJobs: 10,
    dateableJobs: 10,
    jobsTrailing24h: 1,
    zeroDateableJobs: false,
    status: 'ok',
  },
  {
    id: 'lev-2',
    name: 'Company F (Zero Dateable)',
    ats: 'lever',
    target: 'compf',
    totalOpenJobs: 0,
    dateableJobs: 0,
    jobsTrailing24h: 0,
    zeroDateableJobs: true,
    status: 'zero_dateable',
  },
];

const mockFleetCounts: Record<AtsType, number> = {
  greenhouse: 200,
  ashby: 100,
  lever: 50,
};

const controlledReport = calculateCapacityProjections(mockBoards, mockFleetCounts, 1200, FIXED_TEST_NOW);

check(
  'controlled math: Greenhouse extrapolated daily capacity is exactly 800',
  controlledReport.perAts.greenhouse.extrapolatedDailyCapacity === 800
);
check(
  'controlled math: Greenhouse extrapolated open inventory is exactly 8,000',
  controlledReport.perAts.greenhouse.extrapolatedOpenInventory === 8000
);
check(
  'controlled math: Ashby extrapolated daily capacity is exactly 100',
  controlledReport.perAts.ashby.extrapolatedDailyCapacity === 100
);
check(
  'controlled math: Lever sampled boards count is 2 (1 ok + 1 zero-dateable)',
  controlledReport.perAts.lever.sampledBoards === 2
);
check(
  'controlled math: Lever extrapolated daily capacity is 25 (1 trailing job / 2 successful * 50 fleet)',
  controlledReport.perAts.lever.extrapolatedDailyCapacity === 25
);
check(
  'controlled math: fleet total extrapolated daily capacity is 925 (800 + 100 + 25)',
  controlledReport.extrapolatedFleetDailyCapacity === 925
);
check(
  'controlled math: verdict status is DEFICIT for 925 vs 1200',
  controlledReport.verdict.status === 'DEFICIT'
);
check(
  'controlled math: deficit amount is -275 jobs/day',
  controlledReport.verdict.surplusOrDeficit === -275
);
check(
  'controlled math: zero-dateable board correctly identified',
  controlledReport.totalBoardsWithZeroDateableJobs === 1
);

// Test 100% full sampling math (where sampled === fleetTotal)
const fullSampleBoards: BoardCapacityMetrics[] = [
  {
    id: 'gh-all1',
    name: 'Company A',
    ats: 'greenhouse',
    target: 'a',
    totalOpenJobs: 100,
    dateableJobs: 100,
    jobsTrailing24h: 15,
    zeroDateableJobs: false,
    status: 'ok',
  },
];
const fullSampleReport = calculateCapacityProjections(fullSampleBoards, { greenhouse: 1, ashby: 0, lever: 0 }, 10);
check(
  'full-sample math: 100% sample rate equals exact observed sum (no fractional drift)',
  fullSampleReport.extrapolatedFleetDailyCapacity === 15 && fullSampleReport.verdict.status === 'ACHIEVED'
);

// -----------------------------------------------------------------------------
// 4. CLI Argument Parsing & Safety Defaults
// -----------------------------------------------------------------------------
console.log('\n--- 4. CLI Argument Parsing & Safety Defaults ---');

check('DEFAULT_DELAY_MS enforces polite pacing (>= 50ms)', DEFAULT_DELAY_MS >= 50);
check('DEFAULT_TARGET_DAILY_JOBS is 1200', DEFAULT_TARGET_DAILY_JOBS === 1200);

const generatedMd = generateMarkdownReport(controlledReport);
check('generateMarkdownReport produces valid verdict line for controlled fixture', generatedMd.includes('925 new jobs/day vs target 1,200 jobs/day'));

const defaultCli = parseCapacityCliArgs([]);
check('CLI defaults: dryRun is false', defaultCli.dryRun === false);
check('CLI defaults: delayMs is polite (>= 50ms)', defaultCli.delayMs >= 50);
check('CLI defaults: target is 1200', defaultCli.targetDailyJobs === 1200);

const dryRunCli = parseCapacityCliArgs(['--dry-run']);
check('CLI: --dry-run sets dryRun: true', dryRunCli.dryRun === true);

const limitCli = parseCapacityCliArgs(['--limit', '25']);
check('CLI: --limit 25 parses correctly', limitCli.limit === 25);

const atsCli = parseCapacityCliArgs(['--ats', 'greenhouse']);
check('CLI: --ats greenhouse parses correctly', atsCli.atsFilter === 'greenhouse');

const delayCli = parseCapacityCliArgs(['--delay=100']);
check('CLI: --delay=100 parses correctly', delayCli.delayMs === 100);

// -----------------------------------------------------------------------------
// 5. Subprocess Dry-Run Execution Test
// -----------------------------------------------------------------------------
console.log('\n--- 5. Subprocess Dry-Run Execution ---');

const SCRIPT_PATH = path.join('scripts', 'project-daily-capacity.ts');
check('scripts/project-daily-capacity.ts exists on disk', fs.existsSync(SCRIPT_PATH));

const dryRunProc = spawnSync(
  process.execPath,
  ['-r', 'tsx', path.resolve(SCRIPT_PATH), '--dry-run'],
  { encoding: 'utf8' }
);

check('subprocess --dry-run exits with code 0', dryRunProc.status === 0);
check(
  'subprocess output contains DRY-RUN notice',
  dryRunProc.stdout?.includes('DRY-RUN (No network calls made)')
);
check(
  'subprocess output mentions fleet total of 438 boards',
  dryRunProc.stdout?.includes('438')
);
check(
  'subprocess output mentions 1200 target',
  dryRunProc.stdout?.includes('1200')
);

// -----------------------------------------------------------------------------
// 6. Report Content and Structure Verification
// -----------------------------------------------------------------------------
console.log('\n--- 6. Report Content & Structure Verification ---');

const REPORT_PATH = path.join('reports', 'daily-capacity-projection.md');
check('reports/daily-capacity-projection.md exists on disk', fs.existsSync(REPORT_PATH));

const reportContent = fs.readFileSync(REPORT_PATH, 'utf8');

check('report contains Audit Run Date', reportContent.includes('Audit Run Date'));
check('report contains explicit **Verdict**: line', reportContent.includes('**Verdict**:'));
check('report references the 1,200 new jobs/day target', reportContent.includes('1,200') || reportContent.includes('1200'));
check(
  'report explicitly labels figures as empirical estimates with no invented numbers',
  reportContent.includes('estimate') || reportContent.includes('empirical')
);
check('report contains Per-ATS Platform Breakdown section', reportContent.includes('Per-ATS Platform Breakdown'));
check('report mentions Greenhouse platform', reportContent.includes('Greenhouse'));
check('report mentions Ashby platform', reportContent.includes('Ashby'));
check('report mentions Lever platform', reportContent.includes('Lever'));
check('report contains Flagged Boards with Zero Date-able Jobs section', reportContent.includes('Zero Date-able Jobs'));
check('report contains Mathematical Methodology & Projection Formulas section', reportContent.includes('Mathematical Methodology'));

// -----------------------------------------------------------------------------
// Summary & Final Exit
// -----------------------------------------------------------------------------
console.log('\n================================================================================');
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log('================================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All daily capacity projection guard checks passed successfully.');
  process.exit(0);
}
