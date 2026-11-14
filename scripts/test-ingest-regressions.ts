import { detectJobType, slugify } from './utils/sanitizer';
import { extractSkillsFromJob } from '../src/lib/matcher/scoring';
import { NormalizedJob } from './types';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getSourceTimeoutMs,
  parseTimeoutMs,
  fetchWithTimeout,
  recordSourceFailure,
  shouldFailShard,
  updateExistingJobs,
  ABSOLUTE_MAX_SOURCE_TIMEOUT_MS,
  DEFAULT_SOURCE_TIMEOUT_MS,
  LARGE_BOARD_TIMEOUT_MS,
  MAX_SOURCE_TIMEOUT_CAP_MS,
} from './ingest';
import { fetchActiveJobsWindow } from '../src/lib/cron/dailyDigestCron';

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

  // Validation: NaN, negative, zero, non-numeric and non-finite values are rejected; overflow is clamped to the absolute bound
  for (const badValue of [NaN, -1, -5000, 0, '0', '-3', '', '   ', 'abc', Infinity, -Infinity, undefined, null, {}, []]) {
    assert(parseTimeoutMs(badValue as any) === null, `parseTimeoutMs rejects ${String(JSON.stringify(badValue))}`);
  }
  for (const hugeValue of [1e308, Number.MAX_SAFE_INTEGER, '99999999999999999999', 1e12, ABSOLUTE_MAX_SOURCE_TIMEOUT_MS + 1]) {
    assert(
      parseTimeoutMs(hugeValue as any) === ABSOLUTE_MAX_SOURCE_TIMEOUT_MS,
      `parseTimeoutMs clamps overflow ${String(hugeValue)} to the absolute bound`
    );
  }
  assert(parseTimeoutMs('1500') === 1500 && parseTimeoutMs(2.2) === 3, 'parseTimeoutMs accepts finite positive values (rounded up)');
  assert(ABSOLUTE_MAX_SOURCE_TIMEOUT_MS === 300000, 'Absolute upper bound is 300s');

  for (const badValue of [NaN, -1, 0, Infinity, 'abc']) {
    const t = getSourceTimeoutMs({ ...standardBoard, timeoutMs: badValue } as any);
    assert(
      Number.isFinite(t) && t === DEFAULT_SOURCE_TIMEOUT_MS,
      `Invalid per-source timeoutMs ${String(badValue)} is ignored (fell back to default ${t}ms)`
    );
  }
  for (const hugeValue of [1e308, 1e12]) {
    const t = getSourceTimeoutMs({ ...standardBoard, timeoutMs: hugeValue } as any);
    assert(
      Number.isFinite(t) && t > 0 && t <= MAX_SOURCE_TIMEOUT_CAP_MS && t <= ABSOLUTE_MAX_SOURCE_TIMEOUT_MS,
      `Huge per-source timeoutMs ${String(hugeValue)} is capped (got ${t}ms)`
    );
  }
  assert(getSourceTimeoutMs({ ...standardBoard, timeoutMs: 20000 } as any) === 20000, 'Valid per-source timeoutMs below the cap is honored');

  // Env and CLI values are validated at module load: run the real module in a subprocess per scenario
  const probe = path.join(os.tmpdir(), `ingest-timeout-probe-${process.pid}.ts`);
  const ingestPath = path.resolve(process.cwd(), 'scripts', 'ingest.ts').replace(/\\/g, '/');
  fs.writeFileSync(
    probe,
    `import * as m from ${JSON.stringify(ingestPath)};\n` +
      `const src: any = { id: 'ashby-x', name: 'X', type: 'ashby', target: 'x' };\n` +
      `console.log('PROBE ' + JSON.stringify([m.MAX_SOURCE_TIMEOUT_CAP_MS, m.DEFAULT_SOURCE_TIMEOUT_MS, m.LARGE_BOARD_TIMEOUT_MS, m.getSourceTimeoutMs(src)]));\n`
  );
  const runProbe = (env: Record<string, string>, cliArgs: string[] = []) => {
    const r = spawnSync('npx', ['tsx', probe, ...cliArgs], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      shell: true,
      cwd: process.cwd(),
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PROBE '));
    return line ? (JSON.parse(line.slice(6)) as number[]) : null;
  };
  const envBad = runProbe({ INGEST_MAX_TIMEOUT_CAP_MS: 'abc', INGEST_SOURCE_TIMEOUT_MS: '-5', INGEST_LARGE_BOARD_TIMEOUT_MS: '0' });
  assert(
    !!envBad && envBad[0] === 240000 && envBad[1] === 60000 && envBad[2] === 180000 && envBad[3] === 60000,
    `Bogus env timeouts (abc / -5 / 0) fall back to defaults, never NaN (got ${JSON.stringify(envBad)})`
  );
  const envHuge = runProbe({ INGEST_MAX_TIMEOUT_CAP_MS: '99999999999', INGEST_SOURCE_TIMEOUT_MS: '99999999999', INGEST_LARGE_BOARD_TIMEOUT_MS: '1e15' });
  assert(
    !!envHuge && envHuge.every((v) => Number.isFinite(v) && v > 0 && v <= ABSOLUTE_MAX_SOURCE_TIMEOUT_MS),
    `Overflowing env timeouts are clamped to the 300s absolute bound (got ${JSON.stringify(envHuge)})`
  );
  const cliBad = runProbe({}, ['--source-timeout-ms', '-100']);
  assert(!!cliBad && cliBad[1] === 60000, `Negative --source-timeout-ms is ignored (got ${JSON.stringify(cliBad)})`);
  const cliHuge = runProbe({}, ['--source-timeout', '999999999']);
  assert(!!cliHuge && cliHuge[1] === ABSOLUTE_MAX_SOURCE_TIMEOUT_MS, `Huge --source-timeout clamps to the absolute bound (got ${JSON.stringify(cliHuge)})`);
  try {
    fs.unlinkSync(probe);
  } catch {}

  // ---------------------------------------------------------------------------
  // TEST 8: Error Accounting - executes the real timeout, failure-accounting and write paths
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 8: Error Accounting (real fetch-timeout, source-failure and job-update paths) ---');

  const freshStats = () =>
    ({ sourceName: 'Hang', type: 'greenhouse', fetched: 0, normalized: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 }) as any;

  // Real timeout path: a fetch that never resolves must reject, and the failure is ONE warning, not N failed jobs
  const hangStats = freshStats();
  let timeoutMessage = '';
  try {
    await fetchWithTimeout(() => new Promise<never>(() => {}), 80, 'HangBoard');
  } catch (err) {
    timeoutMessage = (err as Error).message;
    recordSourceFailure(hangStats, err);
  }
  assert(/^Timeout after \d+s processing HangBoard$/.test(timeoutMessage), `fetchWithTimeout rejects a hanging fetch (got: ${timeoutMessage})`);
  assert(hangStats.warnings === 1 && hangStats.failed === 0 && hangStats.error === timeoutMessage, 'Source timeout records 1 warning and 0 failed jobs');
  assert((await fetchWithTimeout(async () => 42, 1000, 'FastBoard')) === 42, 'fetchWithTimeout passes through a successful fetch');

  const adapterErrStats = freshStats();
  try {
    await fetchWithTimeout(async () => {
      throw new Error('ATS 503');
    }, 1000, 'DownBoard');
  } catch (err) {
    recordSourceFailure(adapterErrStats, err);
  }
  assert(
    adapterErrStats.warnings === 1 && adapterErrStats.failed === 0 && adapterErrStats.error === 'ATS 503',
    'Adapter error records 1 warning and 0 failed jobs'
  );

  // Real write path: updateExistingJobs against a fake Supabase client with permanent and transient update failures
  const attempts: Record<string, number> = {};
  const descUpserts: string[] = [];
  const fakeSupabase: any = {
    from(table: string) {
      if (table === 'job_descriptions') {
        return {
          upsert: async (row: any) => {
            descUpserts.push(row.job_id);
            return { error: null };
          },
        };
      }
      return {
        update: () => ({
          eq: async (_col: string, id: string) => {
            attempts[id] = (attempts[id] || 0) + 1;
            if (id === 'permanent') return { error: { message: 'canceling statement due to statement timeout' } };
            if (id === 'flaky' && attempts[id] === 1) return { error: { message: 'transient' } };
            return { error: null };
          },
        }),
      };
    },
  };
  const writeStats = freshStats();
  const firstErr = await updateExistingJobs(
    fakeSupabase,
    [
      { id: 'good', item: {}, original: { description: 'd1' } as any },
      { id: 'flaky', item: {}, original: { description: 'd2' } as any },
      { id: 'permanent', item: {}, original: { description: 'd3' } as any },
    ],
    writeStats,
    true,
    1
  );
  assert(
    writeStats.updated === 2 && writeStats.failed === 1,
    `Transient update failure is retried; only the permanent failure counts (updated=${writeStats.updated}, failed=${writeStats.failed})`
  );
  assert(
    attempts['good'] === 1 && attempts['flaky'] === 2 && attempts['permanent'] === 2,
    `Each failing update is retried exactly once (attempts: ${JSON.stringify(attempts)})`
  );
  assert(firstErr === 'canceling statement due to statement timeout', 'First write error message is returned for logging (not swallowed)');
  assert(descUpserts.sort().join(',') === 'flaky,good', 'Descriptions are written only for successfully updated rows');

  // Shard exit decision: warnings alone never fail a shard; real write failures do
  assert(shouldFailShard({ totalFailed: 0 }) === false, 'Shard with only source warnings (0 write failures) exits successfully');
  assert(shouldFailShard({ totalFailed: writeStats.failed }) === true, 'Shard with real job write failures exits non-zero');

  // ---------------------------------------------------------------------------
  // TEST 9: Digest job scan pagination across a shared boundary timestamp (runs the real query logic)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 9: Digest Pagination With Repeated Timestamps ---');

  const T_SHARED = '2026-11-12T10:00:00.000+00:00';
  const T_NEW = '2026-11-13T09:00:00.000+00:00';
  const dataset: any[] = [];
  for (let i = 0; i < 120; i++) dataset.push({ id: `a-${String(i).padStart(4, '0')}`, discovered_at: T_NEW, status: 'active', is_active: true });
  // 300 jobs share one timestamp, so a 250-row page ends in the middle of it
  for (let i = 0; i < 300; i++) dataset.push({ id: `b-${String(i).padStart(4, '0')}`, discovered_at: T_SHARED, status: 'active', is_active: true });
  for (let i = 0; i < 200; i++) dataset.push({ id: `c-${String(i).padStart(4, '0')}`, discovered_at: '2026-11-11T08:00:00.000+00:00', status: 'active', is_active: true });
  dataset.push({ id: 'z-old', discovered_at: '2026-10-01T00:00:00.000+00:00', status: 'active', is_active: true });
  dataset.push({ id: 'z-inactive', discovered_at: T_SHARED, status: 'active', is_active: false });

  const queries: string[] = [];
  const makeFakeJobsDb = () => ({
    from(_table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN = Infinity;
      let orExpr = '';
      const q: any = {
        select: () => q,
        eq: (col: string, v: any) => {
          filters.push((r) => r[col] === v);
          return q;
        },
        gte: (col: string, v: string) => {
          filters.push((r) => r[col] >= v);
          return q;
        },
        lt: (col: string, v: string) => {
          filters.push((r) => r[col] < v);
          return q;
        },
        or: (expr: string) => {
          orExpr = expr;
          const m = expr.match(/^discovered_at\.lt\."(.+?)",and\(discovered_at\.eq\."(.+?)",id\.lt\."(.+?)"\)$/);
          if (!m) throw new Error(`unsupported or() expression: ${expr}`);
          filters.push((r) => r.discovered_at < m[1] || (r.discovered_at === m[2] && r.id < m[3]));
          return q;
        },
        order: (col: string, o: { ascending: boolean }) => {
          orders.push({ col, asc: o.ascending });
          return q;
        },
        limit: (n: number) => {
          limitN = n;
          return q;
        },
        then: (resolve: any) => {
          queries.push(`or=${orExpr || '-'} order=${orders.map((o) => o.col).join(',')} limit=${limitN}`);
          const rows = dataset
            .filter((r) => filters.every((f) => f(r)))
            .sort((x, y) => {
              for (const o of orders) {
                if (x[o.col] === y[o.col]) continue;
                return (x[o.col] < y[o.col] ? -1 : 1) * (o.asc ? 1 : -1);
              }
              return 0;
            });
          resolve({ data: rows.slice(0, limitN), error: null });
        },
      };
      return q;
    },
  });

  const cutoff = '2026-11-01T00:00:00.000+00:00';
  const scanned = await fetchActiveJobsWindow(makeFakeJobsDb(), cutoff, 1000, 250);
  const expectedIds = dataset.filter((r) => r.is_active && r.discovered_at >= cutoff).map((r) => r.id).sort();
  const scannedIds = scanned.map((r) => r.id);
  assert(scannedIds.length === 620, `All 620 in-window active jobs are scanned across pages, including 300 sharing one timestamp (got ${scannedIds.length})`);
  assert(new Set(scannedIds).size === scannedIds.length, 'No job is returned twice across pages');
  assert([...scannedIds].sort().join('|') === expectedIds.join('|'), 'Scanned ids exactly match the in-window active jobs (none skipped)');
  assert(
    queries.length === 3 && queries.slice(1).every((x) => x.startsWith('or=discovered_at.lt') && x.includes('order=discovered_at,id')),
    `Pages 2+ use the composite (discovered_at, id) cursor with two-column ordering (${queries.length} queries)`
  );
  const capped = await fetchActiveJobsWindow(makeFakeJobsDb(), cutoff, 500, 250);
  assert(capped.length === 500 && capped[0].discovered_at === T_NEW, 'maxJobs bound is respected (500 newest jobs)');

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
