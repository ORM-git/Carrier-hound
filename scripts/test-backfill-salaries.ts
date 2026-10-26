import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  evaluateBackfillCandidates,
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
    console.log('[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (asserting existing salary should be overwritten)...\n');
    const existing: ExistingJobRecord[] = [
      {
        id: 'mock-1',
        source: 'greenhouse',
        source_job_id: 'gh-101',
        company: 'Stripe',
        title: 'Backend Engineer',
        salary_min: 150000,
        salary_max: 190000,
        salary_text: '$150k–$190k',
        currency: 'USD',
        salary_period: 'yearly',
      },
    ];
    const remote: NormalizedJob[] = [
      {
        source: 'greenhouse',
        source_job_id: 'gh-101',
        company: 'Stripe',
        title: 'Backend Engineer',
        salary_min: 180000,
        salary_max: 220000,
        salary_text: '$180k–$220k',
        currency: 'USD',
        salary_period: 'yearly',
        apply_url: 'https://boards.greenhouse.io/stripe/jobs/101',
      } as NormalizedJob,
    ];

    const report = evaluateBackfillCandidates(existing, remote);

    // Deliberate negative control assertion: expect candidatesToUpdate to contain the already-populated job
    assert.strictEqual(
      report.candidatesToUpdate.length,
      1,
      'Negative control expected failure: already-populated jobs must NEVER be included in update candidates!'
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Backfill Candidate Categorization (would-fill, already-populated, no-salary)
  // ---------------------------------------------------------------------------
  console.log('Test 1: Verifying evaluation and candidate categorization logic...');
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
    // 2. Would fill: salary_min IS NULL and remote has structured salary
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
  ];

  const report = evaluateBackfillCandidates(mockExisting, mockRemote);

  assert.strictEqual(report.totalAlreadyPopulated, 1, 'Expected exactly 1 already-populated job');
  assert.strictEqual(report.totalWouldFill, 2, 'Expected exactly 2 would-fill jobs (stripe-2 and netflix-4)');
  assert.strictEqual(report.totalNoSalary, 1, 'Expected exactly 1 no-salary job (ramp-3)');
  assert.strictEqual(report.totalMinGreaterThanMax, 1, 'Expected exactly 1 min > max inconsistency (netflix-4)');
  assert.strictEqual(report.candidatesToUpdate.length, 2, 'Candidates to update must contain only qualified rows');
  console.log('  -> [PASS-LOCAL] Candidate evaluation accurately categorized all 4 states.');

  // ---------------------------------------------------------------------------
  // TEST 2: Negative Control: Existing Non-Null Salary is NEVER Overwritten
  // ---------------------------------------------------------------------------
  console.log('\nTest 2: Verifying existing non-null salary is NEVER overwritten with null or any new value...');
  const populatedCandidate = report.candidatesToUpdate.find((c) => c.id === 'job-1');
  assert.strictEqual(populatedCandidate, undefined, 'A job with existing salary_min must NEVER appear in candidatesToUpdate');

  // Edge case: remote returns null for existing populated job
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
  // TEST 3: Negative Control: Other Columns are Strictly UNTOUCHED
  // ---------------------------------------------------------------------------
  console.log('\nTest 3: Verifying update payload touches strictly ONLY the 5 salary columns...');
  for (const candidate of report.candidatesToUpdate) {
    const payload = buildUpdatePayload(candidate);
    const keys = Object.keys(payload);
    const allowedKeys = new Set(['salary_min', 'salary_max', 'salary_text', 'currency', 'salary_period']);

    for (const key of keys) {
      assert.ok(
        allowedKeys.has(key),
        `Update payload contains forbidden non-salary column: ${key}`
      );
    }

    // Explicit check that core table columns are completely absent
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
  // TEST 4: CSV Backup Generation (Local File, Correct Headers, Correct Values)
  // ---------------------------------------------------------------------------
  console.log('\nTest 4: Verifying CSV backup format, headers, and affected row snapshot...');
  const testBackupDir = path.resolve(process.cwd(), 'backups/test-run');
  const testBackupFile = path.resolve(testBackupDir, `test-salary-backup-${Date.now()}.csv`);

  try {
    const backup = createCsvBackup(report.candidatesToUpdate, testBackupFile);
    assert.ok(fs.existsSync(backup.filePath), 'Backup file must exist on disk');

    const content = fs.readFileSync(backup.filePath, 'utf-8');
    const lines = content.trim().split(/\r?\n/);

    // Verify header line matches exact expected schema
    assert.strictEqual(
      lines[0],
      'id,source,source_job_id,salary_min,salary_max,salary_text,currency,salary_period',
      'CSV header must contain exact 8 specified columns'
    );

    // Number of data lines must equal candidatesToUpdate length
    assert.strictEqual(lines.length - 1, report.candidatesToUpdate.length, 'CSV must contain exactly the affected rows');

    // Parse backup and verify fidelity
    const parsedRecords = parseCsvBackup(content);
    assert.strictEqual(parsedRecords.length, report.candidatesToUpdate.length);
    assert.strictEqual(parsedRecords[0].id, 'job-2');
    assert.strictEqual(parsedRecords[0].source, 'greenhouse');
    assert.strictEqual(parsedRecords[0].source_job_id, 'stripe-2');
    assert.strictEqual(parsedRecords[0].salary_min, null, 'Pre-backfill salary_min must be preserved as null in backup');
    console.log('  -> [PASS-LOCAL] CSV backup successfully verified with exact 8-column header and row fidelity.');
  } finally {
    // Cleanup temporary test backup
    if (fs.existsSync(testBackupFile)) fs.unlinkSync(testBackupFile);
    if (fs.existsSync(testBackupDir)) fs.rmdirSync(testBackupDir);
  }

  // ---------------------------------------------------------------------------
  // TEST 5: CSV Restore Functionality (Dry-Run and Batch Validation)
  // ---------------------------------------------------------------------------
  console.log('\nTest 5: Verifying CSV restore dry-run and record parsing...');
  const sampleCsv = `id,source,source_job_id,salary_min,salary_max,salary_text,currency,salary_period
rec-1,greenhouse,stripe-10,120000,160000,"$120k–$160k",USD,yearly
rec-2,ashby,ramp-20,45,65,"$45 - $65 / hr",USD,hourly`;

  const parsed = parseCsvBackup(sampleCsv);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].id, 'rec-1');
  assert.strictEqual(parsed[0].salary_min, 120000);
  assert.strictEqual(parsed[0].salary_period, 'yearly');
  assert.strictEqual(parsed[1].salary_period, 'hourly');

  const restoreRes = await restoreFromCsv('mock.csv', null, false).catch(() => null);
  // Restore dry-run with actual temp file
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
  // TEST 6: Documentation Shapes (SQL, PostgREST, and CLI commands)
  // ---------------------------------------------------------------------------
  console.log('\nTest 6: Verifying documented SQL/PostgREST shapes and restore command strings...');
  const doc = getUpdateShapeDocumentation();
  assert.ok(doc.sqlShape.includes('UPDATE public.jobs AS j'), 'SQL shape must specify jobs update');
  assert.ok(doc.sqlShape.includes('j.salary_min IS NULL'), 'SQL shape must include salary_min IS NULL guard');
  assert.ok(doc.postgrestShape.includes('.is(\'salary_min\', null)'), 'PostgREST shape must include wire guard');
  assert.ok(doc.restoreSqlShape.includes('CREATE TEMP TABLE temp_salary_restore'), 'Restore SQL must create temp table');
  assert.ok(doc.restoreCliShape.includes('--restore'), 'Restore CLI command must reference --restore flag');
  console.log('  -> [PASS-LOCAL] All documentation shapes and restore instructions present and verified.');

  // ---------------------------------------------------------------------------
  // TEST 7: End-to-End Orchestrator Dry-Run (runSalaryBackfill with mock data)
  // ---------------------------------------------------------------------------
  console.log('\nTest 7: Verifying end-to-end runSalaryBackfill orchestrator in dry-run mode...');
  const e2eReport = await runSalaryBackfill({
    isApply: false,
    mockExistingJobs: mockExisting,
    mockReFetchedJobs: mockRemote,
  });
  assert.strictEqual(e2eReport.totalAlreadyPopulated, 1);
  assert.strictEqual(e2eReport.totalWouldFill, 2);
  assert.strictEqual(e2eReport.totalNoSalary, 1);
  assert.strictEqual(e2eReport.totalMinGreaterThanMax, 1);
  assert.strictEqual(e2eReport.candidatesToUpdate.length, 2);
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
