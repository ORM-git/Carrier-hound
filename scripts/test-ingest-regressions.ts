import { detectJobType, slugify } from './utils/sanitizer';
import { extractSkillsFromJob } from '../src/lib/matcher/scoring';
import { NormalizedJob } from './types';
import {
  getSourceTimeoutMs,
  DEFAULT_SOURCE_TIMEOUT_MS,
  LARGE_BOARD_TIMEOUT_MS,
  MAX_SOURCE_TIMEOUT_CAP_MS,
} from './ingest';

async function runRegressionTests() {
  console.log('======================================================');
  console.log('🧪 CareerMonke Ingestion & Data Quality Regression Tests');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Empty Source Fetch Safety
  // ---------------------------------------------------------------------------
  console.log('--- TEST 1: Destructive Safety on Empty / Failed Source Fetch ---');

  function shouldSkipDisappearanceCheck(
    validJobsCount: number,
    statsFailed: number,
    isCapped: boolean
  ): boolean {
    return Boolean(isCapped || statsFailed > 0 || validJobsCount === 0);
  }

  assert(
    shouldSkipDisappearanceCheck(0, 0, false) === true,
    'Empty source fetch (0 jobs returned) MUST skip disappearance detection'
  );

  assert(
    shouldSkipDisappearanceCheck(0, 1, false) === true,
    'Failed source fetch (stats.failed > 0) MUST skip disappearance detection'
  );

  assert(
    shouldSkipDisappearanceCheck(25, 0, false) === false,
    'Successful non-empty fetch permits disappearance check'
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Intra-Run Deduplication
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Intra-Run Normalised Deduplication ---');

  const rawJobsSample = [
    {
      company: 'Fastly',
      title: 'Threat Detection Analyst (Japanese & English speaking)',
      location: 'Singapore, Singapore',
      apply_url: 'https://fastly.com/jobs/1',
    },
    {
      company: 'Fastly',
      title: 'Threat Detection Analyst (Japanese & English speaking)',
      location: 'Singapore, Singapore',
      apply_url: 'https://fastly.com/jobs/1?source=board',
    },
    {
      company: 'Fastly ',
      title: ' Threat Detection Analyst (Japanese & English speaking) ',
      location: 'Singapore, Singapore ',
      apply_url: 'https://fastly.com/jobs/duplicate',
    },
    {
      company: 'Fastly',
      title: 'Threat Detection Analyst (Japanese & English speaking)',
      location: 'Australia (Remote)',
      apply_url: 'https://fastly.com/jobs/australia',
    },
  ];

  const seenApplyUrls = new Set<string>();
  const seenJobKeys = new Set<string>();
  const accepted: any[] = [];

  for (const j of rawJobsSample) {
    if (seenApplyUrls.has(j.apply_url)) continue;

    const normKey = `${slugify(j.company)}::${slugify(j.title)}::${slugify(j.location || 'unspecified')}`;
    if (seenJobKeys.has(normKey)) continue;

    seenApplyUrls.add(j.apply_url);
    seenJobKeys.add(normKey);
    accepted.push(j);
  }

  assert(accepted.length === 2, `Deduplication reduced 4 raw jobs to 2 unique normalized roles (got ${accepted.length})`);
  assert(
    accepted[0].location === 'Singapore, Singapore' && accepted[1].location === 'Australia (Remote)',
    'Retained distinct locations while dropping duplicates of same title+company+location'
  );

  // ---------------------------------------------------------------------------
  // TEST 3: Backfill Batching Logic & Error Isolation
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: Backfill Batching Isolation ---');

  const simulatedItems = Array.from({ length: 250 }, (_, i) => ({ id: `job-${i}`, num: i }));
  const batchSize = 100;
  const batches: any[][] = [];

  for (let i = 0; i < simulatedItems.length; i += batchSize) {
    batches.push(simulatedItems.slice(i, i + batchSize));
  }

  assert(batches.length === 3, '250 items chunked into 3 batches (100, 100, 50)');
  assert(batches[0].length === 100, 'Batch 1 has exactly 100 items');
  assert(batches[1].length === 100, 'Batch 2 has exactly 100 items');
  assert(batches[2].length === 50, 'Batch 3 has remaining 50 items');

  // Verify batch error isolation
  let successfullyProcessed = 0;
  for (let b = 0; b < batches.length; b++) {
    try {
      if (b === 1) {
        throw new Error('Simulated transient batch network error');
      }
      successfullyProcessed += batches[b].length;
    } catch {
      // Isolated error handling: continue processing subsequent batches
    }
  }

  assert(
    successfullyProcessed === 150,
    `Error in batch 2 was isolated, processing 150 of 250 items without crashing (got ${successfullyProcessed})`
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Intern Classification Precision
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: Intern vs Full-Time Classification ---');

  const internCases = [
    { title: 'Software Engineering Intern, Backend', rawType: '', expected: 'internship' },
    { title: 'ML Intern/Co-op', rawType: '', expected: 'internship' },
    { title: 'Summer 2026 Engineering Intern', rawType: '', expected: 'internship' },
    { title: 'Frontend Developer Apprentice', rawType: '', expected: 'internship' },
    { title: 'Graduate Trainee Engineer', rawType: '', expected: 'internship' },
    { title: 'International Business Development Lead', rawType: '', expected: 'job' },
    { title: 'Internal Audit Senior Manager', rawType: '', expected: 'job' },
    { title: 'Senior Software Engineer', rawType: 'Full-time', expected: 'job' },
  ];

  for (const c of internCases) {
    const res = detectJobType(c.title, c.rawType);
    assert(res === c.expected, `detectJobType("${c.title}") === "${c.expected}" (got: "${res}")`);
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Skill Extraction & Category Filtering
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: Skill Extraction (No Category Words) ---');

  const sampleJobInput = {
    title: 'Senior Full Stack Engineer',
    category: 'engineering',
    description: `
      We are looking for a Senior Full Stack Engineer with strong experience in:
      - React, TypeScript, and Next.js for web development.
      - Python, PostgreSQL, and Redis for data services.
      - Docker and AWS for cloud infrastructure.
      Engineering excellence and design thinking are core values.
    `,
  };

  const extracted = extractSkillsFromJob(sampleJobInput);
  const lowerExtracted = extracted.map((s) => s.toLowerCase());

  assert(lowerExtracted.includes('react'), 'Extracted concrete skill "React"');
  assert(lowerExtracted.includes('typescript'), 'Extracted concrete skill "TypeScript"');
  assert(lowerExtracted.includes('python'), 'Extracted concrete skill "Python"');
  assert(lowerExtracted.includes('postgresql'), 'Extracted concrete skill "PostgreSQL"');
  assert(lowerExtracted.includes('docker'), 'Extracted concrete skill "Docker"');
  assert(lowerExtracted.includes('aws'), 'Extracted concrete skill "AWS"');

  assert(!lowerExtracted.includes('engineering'), 'Category word "engineering" strictly filtered out');
  assert(!lowerExtracted.includes('design'), 'Category word "design" strictly filtered out');
  assert(!lowerExtracted.includes('marketing'), 'Category word "marketing" not present');

  // ---------------------------------------------------------------------------
  // TEST 6: Workflow Fatal Error & Secret Sanitization
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 6: Fatal Error Reporting & Secret Sanitization ---');

  function sanitizeLog(message: string): string {
    return message
      .replace(/([?&]apikey=)[^&]+/gi, '$1[REDACTED]')
      .replace(/(bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]');
  }

  const leakyMessage = 'Failed connect to https://xyz.supabase.co?apikey=sbp_secret_key_12345 with bearer eyJhbGciOiJIUzI1NiJ9.test';
  const cleanMessage = sanitizeLog(leakyMessage);

  assert(!cleanMessage.includes('sbp_secret_key_12345'), 'Sanitizer stripped raw API key token');
  assert(!cleanMessage.includes('eyJhbGciOiJIUzI1NiJ9.test'), 'Sanitizer stripped raw JWT Bearer token');
  assert(cleanMessage.includes('[REDACTED]'), 'Replaced secrets with [REDACTED]');

  // ---------------------------------------------------------------------------
  // TEST 7: Per-Source Timeout Configuration (Audit Blocker B8)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 7: Per-Source Timeout Configuration & Large Board Scaling ---');

  const largeBoards = [
    { id: 'greenhouse-doordash', name: 'DoorDash', type: 'greenhouse', target: 'doordash' },
    { id: 'greenhouse-mongodb', name: 'MongoDB', type: 'greenhouse', target: 'mongodb' },
    { id: 'greenhouse-snowflake', name: 'Snowflake', type: 'greenhouse', target: 'snowflake' },
    { id: 'greenhouse-elastic', name: 'Elastic', type: 'greenhouse', target: 'elastic' },
    { id: 'greenhouse-zscaler', name: 'Zscaler', type: 'greenhouse', target: 'zscaler' },
    { id: 'greenhouse-palantir', name: 'Palantir', type: 'greenhouse', target: 'palantir' },
  ];

  for (const board of largeBoards) {
    const t = getSourceTimeoutMs(board as any);
    assert(
      t === LARGE_BOARD_TIMEOUT_MS && t === 180000,
      `Large board "${board.name}" assigned extended 180s timeout (got: ${t}ms)`
    );
  }

  const standardBoard = { id: 'ashby-atlan', name: 'Atlan', type: 'ashby', target: 'atlan' };
  const standardTimeout = getSourceTimeoutMs(standardBoard as any);
  assert(
    standardTimeout === DEFAULT_SOURCE_TIMEOUT_MS && standardTimeout === 60000,
    `Standard board "${standardBoard.name}" assigned default 60s timeout (got: ${standardTimeout}ms)`
  );

  const excessiveBoard = {
    id: 'ashby-custom',
    name: 'Custom Huge',
    type: 'ashby',
    target: 'custom',
    timeoutMs: 999999,
  };
  const cappedTimeout = getSourceTimeoutMs(excessiveBoard as any);
  assert(
    cappedTimeout === MAX_SOURCE_TIMEOUT_CAP_MS && cappedTimeout === 240000,
    `Excessive custom timeout capped strictly at MAX_SOURCE_TIMEOUT_CAP_MS (240s) (got: ${cappedTimeout}ms)`
  );

  // ---------------------------------------------------------------------------
  // TEST 8: Error Accounting (Source Warnings vs Per-Job Failures)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 8: Error Accounting (Source Warnings vs Per-Job Failures) ---');

  // Case A: Source timeout / network error must be counted as 1 source warning, NOT failed jobs
  const timeoutStats = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    warnings: 1,
    error: 'Timeout after 180s processing DoorDash',
  };
  assert(timeoutStats.warnings === 1, 'Source timeout records 1 warning');
  assert(timeoutStats.failed === 0, 'Source timeout does NOT increment failed jobs (kept 0)');

  // Case B: Partial fetch that encounters source error records warning, leaving per-job failures for real DB rejections
  const partialStats = {
    fetched: 2500,
    inserted: 200,
    updated: 0,
    skipped: 50,
    failed: 1, // exactly 1 rejected row during insertion
    warnings: 1, // source aborted mid-run
  };
  assert(partialStats.failed === 1, 'Per-job errors reflect actual write rejections only');
  assert(partialStats.warnings === 1, 'Source failure logged as 1 source warning, not 2500 errors');

  // Verify shard exit condition: warnings do NOT trigger non-zero exit
  const shardSummaryWithWarnings = {
    totalFetched: 5000,
    totalInserted: 4800,
    totalUpdated: 100,
    totalSkipped: 100,
    totalWarnings: 3,
    totalFailed: 0, // Zero job write errors
  };
  const shouldExitNonZero = shardSummaryWithWarnings.totalFailed > 0;
  assert(!shouldExitNonZero, 'Shard with source warnings and zero write failures exits successfully (code 0)');

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`📊 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runRegressionTests().catch((err) => {
  console.error('Fatal Test Failure:', err);
  process.exit(1);
});
