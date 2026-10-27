import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  evaluateBackfillCandidates,
  isSuspiciousSalary,
  buildUpdatePayload,
  createCsvBackup,
  parseCsvBackup,
  getUpdateShapeDocumentation,
  restoreFromCsv,
  runSalaryBackfill,
  ExistingJobRecord,
  SalaryUpdateCandidate,
} from './backfill-salaries';
import { NormalizedJob } from './types';

const isNegativeControl = process.argv.includes('--negative-control');

async function runTestSuite() {
  console.log('================================================================================');
  console.log('         SALARY-ONLY BACKFILL OFFLINE TEST SUITE [PASS-LOCAL]                  ');
  console.log('================================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (asserting suspicious job should be in candidatesToUpdate when skipSuspicious is true)...\n');
    const existing: ExistingJobRecord[] = [
      {
        id: 'mock-suspicious',
        source: 'greenhouse',
        source_job_id: 'gh-small',
        company: 'Stripe',
        title: 'Intern',
        salary_min: null,
        salary_max: null,
        salary_text: null,
        currency: 'USD',
        salary_period: null,
      },
    ];
    const remote: NormalizedJob[] = [
      {
        source: 'greenhouse',
        source_job_id: 'gh-small',
        company: 'Stripe',
        title: 'Intern',
        salary_min: 25,
        salary_max: 40,
        salary_text: '$25 - $40 / hr',
        currency: 'USD',
        salary_period: undefined,
        apply_url: 'https://boards.greenhouse.io/stripe/jobs/small',
      } as NormalizedJob,
    ];

    const report = evaluateBackfillCandidates(existing, remote, { skipSuspicious: true });

    // Deliberate negative control assertion: expect candidatesToUpdate to contain the skipped suspicious job
    assert.strictEqual(
      report.candidatesToUpdate.length,
      1,
      'Negative control expected failure: suspicious job must be excluded when skipSuspicious is true!'
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Backfill Candidate Categorization & Suspicious Detection
  // ---------------------------------------------------------------------------
  console.log('Test 1: Verifying evaluation, candidate categorization, and suspicious detection...');
  const mockExisting: ExistingJobRecord[] = [
    // 1. Already populated: salary_min IS NOT NULL
    {
      id: 'job-1',
      source: 'greenhouse',
      source_job_id: 'stripe-1',
      company: 'Stripe',
      title: 'Infrastructure Engineer',
      salary_min: 160000,
      salary_max: 210000,
      salary_text: '$160,000 - $210,000',
      currency: 'USD',
      salary_period: 'yearly',
    },
    // 2. Would fill (normal): salary_min IS NULL and remote has structured salary
    {
      id: 'job-2',
      source: 'greenhouse',
      source_job_id: 'stripe-2',
      company: 'Stripe',
      title: 'Senior Software Engineer',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
    // 3. No salary: salary_min IS NULL and remote also has null salary
    {
      id: 'job-3',
      source: 'ashby',
      source_job_id: 'ramp-3',
      company: 'Ramp',
      title: 'Product Operations',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
    // 4. Inconsistency: salary_min > salary_max
    {
      id: 'job-4',
      source: 'lever',
      source_job_id: 'netflix-4',
      company: 'Netflix',
      title: 'Creative Assistant',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
    // 5. Suspicious Group A: period is unset AND salary_min < 1000 (likely hourly)
    {
      id: 'job-5-small-unset',
      source: 'greenhouse',
      source_job_id: 'stripe-5',
      company: 'Stripe',
      title: 'Customer Advocate',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
    // 6. Suspicious Group B: salary_max > 2,000,000
    {
      id: 'job-6-large-max',
      source: 'lever',
      source_job_id: 'netflix-6',
      company: 'Netflix',
      title: 'Principal Architect',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
    // 7. Valid INR high package: 94L - 3Cr (valid tech compensation, must NOT be suspicious)
    {
      id: 'job-7-inr-valid',
      source: 'ashby',
      source_job_id: 'swiggy-7',
      company: 'Swiggy',
      title: 'VP Engineering',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'INR',
      salary_period: null,
    },
    // 8. Suspicious Group A: USD under 1k per year (must stay suspicious)
    {
      id: 'job-8-usd-small-yearly',
      source: 'lever',
      source_job_id: 'corp-8',
      company: 'Corp',
      title: 'Part-Time Clerk',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: null,
    },
  ];

  const mockRemote: NormalizedJob[] = [
    {
      source: 'greenhouse',
      source_job_id: 'stripe-1',
      company: 'Stripe',
      title: 'Infrastructure Engineer',
      salary_min: 170000,
      salary_max: 220000,
      salary_text: '$170k–$220k',
      currency: 'USD',
      salary_period: 'yearly',
      apply_url: 'https://boards.greenhouse.io/stripe/jobs/1',
    } as NormalizedJob,
    {
      source: 'greenhouse',
      source_job_id: 'stripe-2',
      company: 'Stripe',
      title: 'Senior Software Engineer',
      salary_min: 140000,
      salary_max: 180000,
      salary_text: '$140k–$180k',
      currency: 'USD',
      salary_period: 'yearly',
      apply_url: 'https://boards.greenhouse.io/stripe/jobs/2',
    } as NormalizedJob,
    {
      source: 'ashby',
      source_job_id: 'ramp-3',
      company: 'Ramp',
      title: 'Product Operations',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      currency: 'USD',
      salary_period: undefined,
      apply_url: 'https://jobs.ashbyhq.com/ramp/3',
    } as NormalizedJob,
    {
      source: 'lever',
      source_job_id: 'netflix-4',
      company: 'Netflix',
      title: 'Creative Assistant',
      salary_min: 90000,
      salary_max: 50000, // Invalid range: min > max
      salary_text: '$90k–$50k',
      currency: 'USD',
      salary_period: 'yearly',
      apply_url: 'https://jobs.lever.co/netflix/4',
    } as NormalizedJob,
    {
      source: 'greenhouse',
      source_job_id: 'stripe-5',
      company: 'Stripe',
      title: 'Customer Advocate',
      salary_min: 30,
      salary_max: 45,
      salary_text: '$30 - $45',
      currency: 'USD',
      salary_period: undefined, // period is unset AND figure < 1000
      apply_url: 'https://boards.greenhouse.io/stripe/jobs/5',
    } as NormalizedJob,
    {
      source: 'lever',
      source_job_id: 'netflix-6',
      company: 'Netflix',
      title: 'Principal Architect',
      salary_min: 1800000,
      salary_max: 2500000, // salary_max > 2,000,000
      salary_text: '$1.8M - $2.5M',
      currency: 'USD',
      salary_period: 'yearly',
      apply_url: 'https://jobs.lever.co/netflix/6',
    } as NormalizedJob,
    {
      source: 'ashby',
      source_job_id: 'swiggy-7',
      company: 'Swiggy',
      title: 'VP Engineering',
      salary_min: 9400000,
      salary_max: 30000000, // 94L - 3Cr INR (valid tech package)
      salary_text: '₹94,00,000 - ₹3,00,00,000 /yr',
      currency: 'INR',
      salary_period: 'yearly',
      apply_url: 'https://swiggy.careers/7',
    } as NormalizedJob,
    {
      source: 'lever',
      source_job_id: 'corp-8',
      company: 'Corp',
      title: 'Part-Time Clerk',
      salary_min: 500,
      salary_max: 800, // USD under 1k per year -> suspicious
      salary_text: '$500 - $800 /yr',
      currency: 'USD',
      salary_period: 'yearly',
      apply_url: 'https://corp.com/8',
    } as NormalizedJob,
  ];

  // Default evaluation (skipSuspicious: false)
  const defaultReport = evaluateBackfillCandidates(mockExisting, mockRemote);

  assert.strictEqual(defaultReport.totalAlreadyPopulated, 1, 'Expected exactly 1 already-populated job');
  assert.strictEqual(defaultReport.totalWouldFill, 6, 'Expected 6 would-fill jobs (jobs 2, 4, 5, 6, 7, 8)');
  assert.strictEqual(defaultReport.totalNoSalary, 1, 'Expected exactly 1 no-salary job (job 3)');
  assert.strictEqual(defaultReport.totalMinGreaterThanMax, 1, 'Expected exactly 1 min > max inconsistency (job 4)');
  assert.strictEqual(defaultReport.totalUnsetPeriodSmall, 2, 'Expected 2 unset/small figure jobs (jobs 5 and 8)');
  assert.strictEqual(defaultReport.totalLargeSalaryMax, 1, 'Expected 1 large salary max > $2M USD job (job 6; INR 30M is valid)');
  assert.strictEqual(defaultReport.candidatesToUpdate.length, 6, 'Default mode includes all 6 would-fill candidates');
  console.log('  -> [PASS-LOCAL] Default evaluation accurately categorized all rows and identified suspicious groups.');

  // ---------------------------------------------------------------------------
  // TEST 2: --skip-suspicious Flag Evaluation (Currency-Aware)
  // ---------------------------------------------------------------------------
  console.log('\nTest 2: Verifying --skip-suspicious excludes suspicious rows while preserving valid INR high salaries...');
  const filteredReport = evaluateBackfillCandidates(mockExisting, mockRemote, { skipSuspicious: true });

  assert.strictEqual(filteredReport.totalWouldFill, 6, 'Would fill count remains 6 in statistics');
  assert.strictEqual(filteredReport.totalSkippedSuspicious, 3, 'Must report exactly 3 skipped suspicious rows (jobs 5, 6, 8)');
  assert.strictEqual(filteredReport.candidatesToUpdate.length, 3, 'Only 3 non-suspicious candidates should remain (jobs 2, 4, 7)');

  // Verify retained & excluded IDs
  const candidateIds = new Set(filteredReport.candidatesToUpdate.map((c) => c.id));
  assert.ok(candidateIds.has('job-2'), 'Standard USD job-2 must be retained');
  assert.ok(candidateIds.has('job-4'), 'Job-4 must be retained');
  assert.ok(candidateIds.has('job-7-inr-valid'), 'Job-7 (INR 94L-3Cr) must be retained as valid tech compensation');
  assert.strictEqual(candidateIds.has('job-5-small-unset'), false, 'Job-5 (<1000 unset) must be EXCLUDED');
  assert.strictEqual(candidateIds.has('job-6-large-max'), false, 'Job-6 (>2M USD) must be EXCLUDED');
  assert.strictEqual(candidateIds.has('job-8-usd-small-yearly'), false, 'Job-8 (USD < 1k/yr) must be EXCLUDED');
  console.log('  -> [PASS-LOCAL] --skip-suspicious strictly excluded suspicious rows while retaining INR 94L-3Cr.');

  // ---------------------------------------------------------------------------
  // TEST 2B: Direct Unit Test for isSuspiciousSalary (Currency-Aware)
  // ---------------------------------------------------------------------------
  console.log('\nTest 2B: Direct validation of isSuspiciousSalary across currencies and periods...');
  // 1. Valid INR 94L - 3Cr
  const inrValid = isSuspiciousSalary(9400000, 30000000, 'INR', 'yearly');
  assert.strictEqual(inrValid.isSuspicious, false, 'INR 94L-3Cr must NOT be suspicious');
  assert.strictEqual(inrValid.isLargeSalary, false, 'INR 30M is not abnormally large for INR');

  // 2. Suspicious USD under 1k yearly
  const usdYearlySmall = isSuspiciousSalary(500, 800, 'USD', 'yearly');
  assert.strictEqual(usdYearlySmall.isSuspicious, true, 'USD under 1k per year must be suspicious');
  assert.strictEqual(usdYearlySmall.isUnsetSmall, true);

  // 3. Suspicious USD unset period under 1k
  const usdUnsetSmall = isSuspiciousSalary(25, 45, 'USD', null);
  assert.strictEqual(usdUnsetSmall.isSuspicious, true, 'USD unset period under 1k must be suspicious');

  // 4. Suspicious USD > 2M
  const usdLarge = isSuspiciousSalary(1800000, 2500000, 'USD', 'yearly');
  assert.strictEqual(usdLarge.isSuspicious, true, 'USD > 2M must be suspicious');
  assert.strictEqual(usdLarge.isLargeSalary, true);

  // 5. Standard valid USD salary
  const usdStandard = isSuspiciousSalary(140000, 180000, 'USD', 'yearly');
  assert.strictEqual(usdStandard.isSuspicious, false, 'USD 140k-180k must be valid');

  // 6. Suspicious abnormal INR > 20 Cr
  const inrAbnormal = isSuspiciousSalary(500000000, 1000000000, 'INR', 'yearly');
  assert.strictEqual(inrAbnormal.isSuspicious, true, 'INR > 20 Cr must be flagged as abnormal');
  console.log('  -> [PASS-LOCAL] isSuspiciousSalary correctly validates currency-aware compensation thresholds.');

  // ---------------------------------------------------------------------------
  // TEST 3: Negative Control: Existing Non-Null Salary is NEVER Overwritten
  // ---------------------------------------------------------------------------
  console.log('\nTest 3: Verifying existing non-null salary is NEVER overwritten with null or any new value...');
  const populatedCandidate = defaultReport.candidatesToUpdate.find((c) => c.id === 'job-1');
  assert.strictEqual(populatedCandidate, undefined, 'A job with existing salary_min must NEVER appear in candidatesToUpdate');

  const existingJobWithSalary: ExistingJobRecord = {
    id: 'job-populated',
    source: 'greenhouse',
    source_job_id: 'gh-safe',
    salary_min: 130000,
    salary_max: 170000,
    salary_text: '$130,000 - $170,000',
    currency: 'USD',
    salary_period: 'yearly',
  };
  const remoteJobWithNullSalary: NormalizedJob = {
    source: 'greenhouse',
    source_job_id: 'gh-safe',
    company: 'TestCo',
    title: 'Developer',
    salary_min: null,
    salary_max: null,
    salary_text: null,
    currency: 'USD',
    salary_period: undefined,
    apply_url: 'https://example.com',
  } as NormalizedJob;

  const safeReport = evaluateBackfillCandidates([existingJobWithSalary], [remoteJobWithNullSalary]);
  assert.strictEqual(safeReport.candidatesToUpdate.length, 0, 'Must NOT touch existing job even if remote returns null');
  assert.strictEqual(safeReport.statsBySource.greenhouse.alreadyPopulated, 1);
  console.log('  -> [PASS-LOCAL] Verified 100% preservation of existing salary data.');

  // ---------------------------------------------------------------------------
  // TEST 4: Negative Control: Other Columns are Strictly UNTOUCHED
  // ---------------------------------------------------------------------------
  console.log('\nTest 4: Verifying update payload touches strictly ONLY the 5 salary columns...');
  for (const candidate of defaultReport.candidatesToUpdate) {
    const payload = buildUpdatePayload(candidate);
    const keys = Object.keys(payload);
    const allowedKeys = new Set(['salary_min', 'salary_max', 'salary_text', 'currency', 'salary_period']);

    for (const key of keys) {
      assert.ok(
        allowedKeys.has(key),
        `Update payload contains forbidden non-salary column: ${key}`
      );
    }

    const forbiddenKeys = ['title', 'company', 'location', 'description', 'remote', 'status', 'is_active', 'job_type', 'apply_url'];
    for (const fKey of forbiddenKeys) {
      assert.strictEqual(
        (payload as any)[fKey],
        undefined,
        `Forbidden column ${fKey} must NOT be present in update payload`
      );
    }
  }
  console.log('  -> [PASS-LOCAL] Update payload is strictly restricted to salary columns only.');

  // ---------------------------------------------------------------------------
  // TEST 5: CSV Backup Generation & Batch Size
  // ---------------------------------------------------------------------------
  console.log('\nTest 5: Verifying CSV backup format, headers, and affected row snapshot...');
  const testBackupDir = path.resolve(process.cwd(), 'backups/test-run');
  const testBackupFile = path.resolve(testBackupDir, `test-salary-backup-${Date.now()}.csv`);

  try {
    const backup = createCsvBackup(defaultReport.candidatesToUpdate, testBackupFile);
    assert.ok(fs.existsSync(backup.filePath), 'Backup file must exist on disk');

    const content = fs.readFileSync(backup.filePath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);

    assert.strictEqual(
      lines[0],
      'id,source,source_job_id,salary_min,salary_max,salary_text,currency,salary_period',
      'CSV header must contain exact 8 specified columns'
    );
    assert.strictEqual(lines.length - 1, defaultReport.candidatesToUpdate.length, 'CSV must contain exactly the affected rows');

    const parsedRecords = parseCsvBackup(content);
    assert.strictEqual(parsedRecords.length, defaultReport.candidatesToUpdate.length);
    assert.strictEqual(parsedRecords[0].id, 'job-2');
    console.log('  -> [PASS-LOCAL] CSV backup successfully verified with exact 8-column header and row fidelity.');
  } finally {
    if (fs.existsSync(testBackupFile)) fs.unlinkSync(testBackupFile);
    if (fs.existsSync(testBackupDir)) fs.rmdirSync(testBackupDir);
  }

  // ---------------------------------------------------------------------------
  // TEST 6: CSV Restore Functionality (Dry-Run and Batch Validation)
  // ---------------------------------------------------------------------------
  console.log('\nTest 6: Verifying CSV restore dry-run and record parsing...');
  const sampleCsv = `id,source,source_job_id,salary_min,salary_max,salary_text,currency,salary_period
rec-1,greenhouse,stripe-10,120000,160000,"$120k–$160k",USD,yearly
rec-2,ashby,ramp-20,45,65,"$45 - $65 / hr",USD,hourly`;

  const parsed = parseCsvBackup(sampleCsv);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].id, 'rec-1');
  assert.strictEqual(parsed[0].salary_min, 120000);
  assert.strictEqual(parsed[0].salary_period, 'yearly');
  assert.strictEqual(parsed[1].salary_period, 'hourly');

  const tempRestoreFile = path.resolve(process.cwd(), `temp-test-restore-${Date.now()}.csv`);
  try {
    fs.writeFileSync(tempRestoreFile, sampleCsv, 'utf-8');
    const dryRestore = await restoreFromCsv(tempRestoreFile, null, false);
    assert.strictEqual(dryRestore.restoredCount, 2, 'Dry-run restore must report 2 records');
    console.log('  -> [PASS-LOCAL] CSV restore dry-run verified successfully.');
  } finally {
    if (fs.existsSync(tempRestoreFile)) fs.unlinkSync(tempRestoreFile);
  }

  // ---------------------------------------------------------------------------
  // TEST 7: End-to-End Orchestrator Dry-Run & Documented Shapes
  // ---------------------------------------------------------------------------
  console.log('\nTest 7: Verifying end-to-end runSalaryBackfill orchestrator in dry-run mode...');
  const e2eReport = await runSalaryBackfill({
    isApply: false,
    mockExistingJobs: mockExisting,
    mockReFetchedJobs: mockRemote,
  });
  assert.strictEqual(e2eReport.totalAlreadyPopulated, 1);
  assert.strictEqual(e2eReport.totalWouldFill, 6);
  assert.strictEqual(e2eReport.totalUnsetPeriodSmall, 2);
  assert.strictEqual(e2eReport.totalLargeSalaryMax, 1);
  assert.strictEqual(e2eReport.candidatesToUpdate.length, 6);
  console.log('  -> [PASS-LOCAL] End-to-end dry-run orchestrator verified successfully.');

  // ---------------------------------------------------------------------------
  // TEST 8: Subprocess Negative Control
  // ---------------------------------------------------------------------------
  console.log('\nTest 8: Running self in --negative-control mode to verify non-zero exit...');
  const selfPath = path.resolve(process.cwd(), 'scripts/test-backfill-salaries.ts');
  const result = spawnSync('npx', ['tsx', selfPath, '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });

  assert.notStrictEqual(
    result.status,
    0,
    'Negative control execution MUST exit with non-zero exit code!'
  );
  console.log(`  -> [PASS-LOCAL] Subprocess negative control failed as expected with exit code ${result.status}.`);

  console.log('\n================================================================================');
  console.log('       ALL 8 SALARY BACKFILL TESTS PASSED CLEANLY [PASS-LOCAL]                  ');
  console.log('================================================================================');
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
