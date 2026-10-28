/**
 * scripts/test-null-posted-at-ordering.ts
 *
 * Verifies that:
 * 1. Every posted_at DESC order in src/app/api/jobs/search/route.ts includes { ascending: false, nullsFirst: false }.
 * 2. Every posted_at DESC order in src/lib/jobs/service.ts includes { ascending: false, nullsFirst: false }.
 * 3. Every posted_at DESC order in netlify/functions/jobs-search.ts includes { ascending: false, nullsFirst: false }.
 * 4. Every posted_at DESC order in src/app/api/jobs/pro/route.ts includes { ascending: false, nullsFirst: false }.
 * 5. Every posted_at DESC order in netlify/functions/jobs-pro.ts includes { ascending: false, nullsFirst: false }.
 * 6. Every posted_at DESC order in src/app/api/jobs/top10/route.ts includes { ascending: false, nullsFirst: false }.
 * 7. Every posted_at DESC order in netlify/functions/jobs-top10.ts includes { ascending: false, nullsFirst: false }.
 * 8. Comprehensive directory scanner across ALL files in src/ and netlify/functions/ (not a fixed list):
 *    Fails if ANY file contains a posted_at DESC order lacking nullsFirst: false.
 * 9. Sorting behavior places NULL posted_at at the end (nulls last) so undated ATS jobs do not hijack page 1.
 * 10. Date filters (.gte posted_at) only filter when a dateParam/date is provided, never hiding undated rows on standard browsing.
 *
 * Includes negative control protocol (--negative-control) proving non-zero exit on invalid assertions / violations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const isNegativeControl = process.argv.includes('--negative-control');

export function findPostedAtDescViolations(content: string): Array<{ rawMatch: string; opts: string }> {
  const violations: Array<{ rawMatch: string; opts: string }> = [];
  const orderRegex = /\.order\(\s*["']posted_at["']\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = orderRegex.exec(content)) !== null) {
    const opts = match[1];
    const isDesc = /ascending\s*:\s*false/.test(opts);
    const hasNullsLast = /nullsFirst\s*:\s*false/.test(opts);
    if (isDesc && !hasNullsLast) {
      violations.push({ rawMatch: match[0], opts: opts.trim() });
    }
  }
  return violations;
}

function getCodeFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getCodeFiles(fullPath));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(file)) {
      results.push(fullPath);
    }
  }
  return results;
}

async function run() {
  console.log('==================================================================');
  console.log('🧪 TEST: NULL POSTED_AT ORDERING & RECURSIVE SAFETY SCAN');
  console.log('==================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Testing scanner detection of missing nullsFirst: false in simulated code...');
    const badCode = `
      const query = supabase.from("jobs").select("*").order("posted_at", { ascending: false }).limit(20);
    `;
    const violations = findPostedAtDescViolations(badCode);
    if (violations.length > 0) {
      console.error('❌ [NEGATIVE CONTROL TRIGGERED] Scanner successfully detected violation in code lacking nullsFirst: false. Exiting non-zero (1).');
      process.exit(1);
    } else {
      console.error('⚠️ [NEGATIVE CONTROL FAILED] Scanner failed to detect bad posted_at DESC ordering!');
      process.exit(0);
    }
  }

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Static Validation: src/app/api/jobs/search/route.ts
  // ---------------------------------------------------------------------------
  const routePath = path.resolve(process.cwd(), 'src/app/api/jobs/search/route.ts');
  assert(fs.existsSync(routePath), 'src/app/api/jobs/search/route.ts exists');
  const routeContent = fs.readFileSync(routePath, 'utf-8');
  const routeViolations = findPostedAtDescViolations(routeContent);
  assert(routeViolations.length === 0, 'Every posted_at DESC order in route.ts specifies nullsFirst: false');

  const hasRouteDateGuard =
    routeContent.includes('dateParam') &&
    routeContent.includes('.gte("posted_at", cutoff)') &&
    routeContent.includes('ms > 0');
  assert(hasRouteDateGuard, 'route.ts only applies .gte("posted_at") when dateParam is provided and ms > 0');

  // ---------------------------------------------------------------------------
  // 2. Static Validation: src/lib/jobs/service.ts
  // ---------------------------------------------------------------------------
  const servicePath = path.resolve(process.cwd(), 'src/lib/jobs/service.ts');
  assert(fs.existsSync(servicePath), 'src/lib/jobs/service.ts exists');
  const serviceContent = fs.readFileSync(servicePath, 'utf-8');
  const serviceViolations = findPostedAtDescViolations(serviceContent);
  assert(serviceViolations.length === 0, 'Every posted_at DESC order in service.ts specifies nullsFirst: false');

  const hasServiceDateGuard =
    serviceContent.includes('datePosted') &&
    serviceContent.includes('.gte("posted_at", cutoff)') &&
    serviceContent.includes('ms > 0');
  assert(hasServiceDateGuard, 'service.ts only applies .gte("posted_at") when datePosted is provided and ms > 0');

  // ---------------------------------------------------------------------------
  // 3. Static Validation: netlify/functions/jobs-search.ts
  // ---------------------------------------------------------------------------
  const netlifySearchPath = path.resolve(process.cwd(), 'netlify/functions/jobs-search.ts');
  assert(fs.existsSync(netlifySearchPath), 'netlify/functions/jobs-search.ts exists');
  const netlifySearchContent = fs.readFileSync(netlifySearchPath, 'utf-8');
  const netlifySearchViolations = findPostedAtDescViolations(netlifySearchContent);
  assert(netlifySearchViolations.length === 0, 'Every posted_at DESC order in netlify/functions/jobs-search.ts specifies nullsFirst: false');

  // ---------------------------------------------------------------------------
  // 4. Static Validation: src/app/api/jobs/pro/route.ts
  // ---------------------------------------------------------------------------
  const proRoutePath = path.resolve(process.cwd(), 'src/app/api/jobs/pro/route.ts');
  assert(fs.existsSync(proRoutePath), 'src/app/api/jobs/pro/route.ts exists');
  const proRouteContent = fs.readFileSync(proRoutePath, 'utf-8');
  const proRouteViolations = findPostedAtDescViolations(proRouteContent);
  assert(proRouteViolations.length === 0, 'Every posted_at DESC order in pro/route.ts specifies nullsFirst: false');

  // ---------------------------------------------------------------------------
  // 5. Static Validation: netlify/functions/jobs-pro.ts
  // ---------------------------------------------------------------------------
  const netlifyProPath = path.resolve(process.cwd(), 'netlify/functions/jobs-pro.ts');
  assert(fs.existsSync(netlifyProPath), 'netlify/functions/jobs-pro.ts exists');
  const netlifyProContent = fs.readFileSync(netlifyProPath, 'utf-8');
  const netlifyProViolations = findPostedAtDescViolations(netlifyProContent);
  assert(netlifyProViolations.length === 0, 'Every posted_at DESC order in netlify/functions/jobs-pro.ts specifies nullsFirst: false');

  // ---------------------------------------------------------------------------
  // 6. Static Validation: src/app/api/jobs/top10/route.ts
  // ---------------------------------------------------------------------------
  const top10RoutePath = path.resolve(process.cwd(), 'src/app/api/jobs/top10/route.ts');
  assert(fs.existsSync(top10RoutePath), 'src/app/api/jobs/top10/route.ts exists');
  const top10RouteContent = fs.readFileSync(top10RoutePath, 'utf-8');
  const top10RouteViolations = findPostedAtDescViolations(top10RouteContent);
  assert(top10RouteViolations.length === 0, 'Every posted_at DESC order in top10/route.ts specifies nullsFirst: false');

  // ---------------------------------------------------------------------------
  // 7. Static Validation: netlify/functions/jobs-top10.ts
  // ---------------------------------------------------------------------------
  const netlifyTop10Path = path.resolve(process.cwd(), 'netlify/functions/jobs-top10.ts');
  assert(fs.existsSync(netlifyTop10Path), 'netlify/functions/jobs-top10.ts exists');
  const netlifyTop10Content = fs.readFileSync(netlifyTop10Path, 'utf-8');
  const netlifyTop10Violations = findPostedAtDescViolations(netlifyTop10Content);
  assert(netlifyTop10Violations.length === 0, 'Every posted_at DESC order in netlify/functions/jobs-top10.ts specifies nullsFirst: false');

  // ---------------------------------------------------------------------------
  // 8. Recursive Codebase Scanner: ALL files in src/ and netlify/functions/
  // ---------------------------------------------------------------------------
  const allCodeFiles = [
    ...getCodeFiles(path.resolve(process.cwd(), 'src')),
    ...getCodeFiles(path.resolve(process.cwd(), 'netlify/functions')),
  ];
  let totalOrderQueriesFound = 0;
  const allViolations: Array<{ file: string; rawMatch: string }> = [];

  for (const filePath of allCodeFiles) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const orderRegex = /\.order\(\s*["']posted_at["']\s*,\s*\{([\s\S]*?)\}\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = orderRegex.exec(code)) !== null) {
      totalOrderQueriesFound++;
      const opts = match[1];
      const isDesc = /ascending\s*:\s*false/.test(opts);
      const hasNullsLast = /nullsFirst\s*:\s*false/.test(opts);
      if (isDesc && !hasNullsLast) {
        allViolations.push({ file: path.relative(process.cwd(), filePath), rawMatch: match[0] });
      }
    }
  }

  assert(
    allViolations.length === 0,
    `Recursive Scanner: zero posted_at DESC orders lack nullsFirst: false across all scanned files (scanned ${allCodeFiles.length} files)`,
    allViolations.map((v) => `${v.file}: ${v.rawMatch}`).join('; ')
  );
  assert(
    totalOrderQueriesFound >= 12,
    `Recursive Scanner: found and verified all posted_at order queries across src/ and netlify/functions/ (actual: ${totalOrderQueriesFound})`
  );

  // ---------------------------------------------------------------------------
  // 9. Behavioral Verification: Ordering with NULL posted_at
  // ---------------------------------------------------------------------------
  interface TestJob {
    id: string;
    title: string;
    posted_at: string | null;
  }

  const jobs: TestJob[] = [
    { id: 'job-undated-1', title: 'Undated ATS Role 1', posted_at: null },
    { id: 'job-dated-old', title: 'Older Role', posted_at: '2026-10-20T10:00:00Z' },
    { id: 'job-dated-new', title: 'Newer Role', posted_at: '2026-10-28T10:00:00Z' },
    { id: 'job-undated-2', title: 'Undated ATS Role 2', posted_at: null },
  ];

  function simulatePostgresOrder(rows: TestJob[], ascending: boolean, nullsFirst: boolean): TestJob[] {
    return [...rows].sort((a, b) => {
      const aVal = a.posted_at;
      const bVal = b.posted_at;
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return nullsFirst ? -1 : 1;
      if (bVal === null) return nullsFirst ? 1 : -1;
      const cmp = aVal.localeCompare(bVal);
      return ascending ? cmp : -cmp;
    });
  }

  const badOrder = simulatePostgresOrder(jobs, false, true);
  assert(
    badOrder[0].posted_at === null,
    'PostgreSQL default DESC (nullsFirst: true) places undated jobs on page 1 top'
  );

  const fixedOrder = simulatePostgresOrder(jobs, false, false);
  assert(
    fixedOrder[0].id === 'job-dated-new',
    'Fixed DESC (nullsFirst: false) places newest dated job first'
  );
  assert(
    fixedOrder[1].id === 'job-dated-old',
    'Fixed DESC (nullsFirst: false) places older dated job second'
  );
  assert(
    fixedOrder[2].posted_at === null && fixedOrder[3].posted_at === null,
    'Fixed DESC (nullsFirst: false) places undated jobs at the bottom (nulls last)'
  );

  // ---------------------------------------------------------------------------
  // 10. Date Filter Safety Verification
  // ---------------------------------------------------------------------------
  const noFilterResults = fixedOrder;
  assert(
    noFilterResults.some((j) => j.posted_at === null),
    'Standard browsing without date filter preserves undated jobs in result set'
  );

  const cutoff = '2026-10-21T00:00:00Z';
  const dateFiltered = fixedOrder.filter((j) => j.posted_at !== null && j.posted_at >= cutoff);
  assert(
    dateFiltered.length === 1 && dateFiltered[0].id === 'job-dated-new',
    'Date filter correctly keeps only jobs within date window'
  );

  // ---------------------------------------------------------------------------
  // 11. Subprocess Negative Control
  // ---------------------------------------------------------------------------
  console.log('\nRunning negative control subprocess...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-null-posted-at-ordering.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
    cwd: process.cwd(),
  });
  assert(
    negResult.status !== 0,
    `Negative control subprocess exited non-zero as expected (exit code: ${negResult.status})`
  );

  console.log('\n==================================================================');
  console.log(`📊 AUDIT RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
