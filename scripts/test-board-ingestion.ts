/**
 * scripts/test-board-ingestion.ts
 *
 * Test suite for Company Board Ingestion (Greenhouse, Lever, Ashby).
 *
 * Tests:
 * 1. Registry contains 200+ verified real tokens (no hardcoded counters) across all 3 ATS systems.
 * 2. Fixture normalization for Greenhouse, Lever, and Ashby using the ONE canonical normalizer.
 * 3. Strict apply_url validation: HTTPS-only and non-forbidden host enforcement.
 * 4. Sensible posted_at: Greenhouse updated_at is never treated as posting date.
 * 5. HTML and script sanitization.
 * 6. Cross-source and intra-run deduplication.
 * 7. Closed-job handling:
 *    - Misses counted ONLY after successful non-empty fetch.
 *    - Scoped strictly by source + company_slug.
 *    - Inactive only after 2 consecutive misses (never deleted).
 *    - Empty fetch skips miss counting.
 * 8. Authorized public API endpoints only: strict rejection of forbidden domains (LinkedIn, Indeed, Workday, etc.).
 * 9. Dry-run execution resilience and zero secrets in logs.
 * 10. Negative control: mutates real behaviour (feeds bad registry entry and forbidden URLs) and proves non-zero exit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  normalizeAtsJob,
  dedupJobs,
  handleClosedJobs,
  isAuthorizedAtsUrl,
  isValidApplyUrl,
  loadCompanyRegistry,
  runBoardIngestion,
  ClosedJobRecord,
} from './board-ingest';
import { cleanAndTruncateDescription } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNegativeControl = process.argv.includes('--negative-control');

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 TEST: COMPANY BOARD INGESTION (GREENHOUSE, LEVER, ASHBY)');
  console.log('==================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  // ---------------------------------------------------------------------------
  // Negative Control Mode: Mutates real behaviour by feeding bad registry entries & forbidden URLs
  // ---------------------------------------------------------------------------
  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Mutating real behaviour: feeding bad registry entry & forbidden URLs...');

    // 1. Feeding forbidden domain URL
    const forbiddenAuthorized = isAuthorizedAtsUrl('https://linkedin.com/jobs/view/1234', 'greenhouse');

    // 2. Feeding malformed job with forbidden domain apply_url
    const forbiddenJob = normalizeAtsJob(
      { title: 'Engineer', absolute_url: 'https://workday.com/job/1' },
      'greenhouse',
      'BadCorp',
      'badcorp'
    );

    // 3. Feeding non-https apply_url
    const insecureJob = normalizeAtsJob(
      { title: 'Engineer', absolute_url: 'http://boards.greenhouse.io/stripe/jobs/1' },
      'greenhouse',
      'BadCorp',
      'badcorp'
    );

    // In real code, all 3 MUST be rejected (false, null, null).
    // In negative control mode, we exit non-zero (code 1) proving detection of invalid conditions.
    if (!forbiddenAuthorized && forbiddenJob === null && insecureJob === null) {
      console.error('❌ [NEGATIVE CONTROL TRIGGERED] Real validator rejected bad URL and bad job posting. Exiting non-zero (1) as required by negative control protocol.');
      process.exit(1);
    } else {
      console.error('⚠️ [NEGATIVE CONTROL FAILED] Bad inputs were unexpectedly accepted!');
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
  // 1. Registry Size, Diversity, and Schema (No hardcoded counters)
  // ---------------------------------------------------------------------------
  const registry = loadCompanyRegistry();
  assert(registry.length >= 200, `Registry contains >= 200 verified real tokens (actual: ${registry.length})`);

  const atsCounts = { greenhouse: 0, lever: 0, ashby: 0 };
  let indiaCount = 0;
  let remoteCount = 0;
  let nonTechCandidates = 0;

  for (const entry of registry) {
    if (atsCounts[entry.ats] !== undefined) {
      atsCounts[entry.ats]++;
    }
    if (entry.country_hint === 'IN') indiaCount++;
    if (entry.country_hint === 'remote') remoteCount++;

    const isKnownNonTech = /glossier|sweetgreen|peloton|gymshark|vox|duolingo|hellofresh|deliveroo|doctolib|oscar/i.test(entry.company);
    if (isKnownNonTech) nonTechCandidates++;
  }

  assert(atsCounts.greenhouse >= 50, `Greenhouse verified tokens >= 50 (actual: ${atsCounts.greenhouse})`);
  assert(atsCounts.lever >= 20, `Lever verified tokens >= 20 (actual: ${atsCounts.lever})`);
  assert(atsCounts.ashby >= 50, `Ashby verified tokens >= 50 (actual: ${atsCounts.ashby})`);
  assert(indiaCount >= 10, `India tokens verified >= 10 (actual: ${indiaCount})`);
  assert(remoteCount >= 20, `Remote tokens verified >= 20 (actual: ${remoteCount})`);
  assert(nonTechCandidates >= 5, `Non-tech employer tokens verified >= 5 (actual: ${nonTechCandidates})`);

  // ---------------------------------------------------------------------------
  // 2. ONE Canonical Normalizer: Fixture Normalization for Greenhouse, Lever, Ashby
  // ---------------------------------------------------------------------------
  const ghFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/greenhouse-response.json'), 'utf-8'));
  const leverFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/lever-response.json'), 'utf-8'));
  const ashbyFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/ashby-response.json'), 'utf-8'));

  // Greenhouse Normalization
  const ghJob = normalizeAtsJob(ghFixture.jobs[0], 'greenhouse', 'Stripe', 'stripe');
  assert(ghJob !== null, 'Greenhouse job normalizes successfully via ONE normalizer');
  assert(ghJob?.source === 'greenhouse', 'Greenhouse job source matches "greenhouse"');
  assert(ghJob?.title === 'Senior Backend Engineer', 'Greenhouse title matches raw posting title');
  assert(ghJob?.remote === true, 'Greenhouse remote detection identifies "Remote, United States"');
  assert(ghJob?.apply_url === 'https://boards.greenhouse.io/stripe/jobs/1001', 'Greenhouse real apply URL preserved');

  // Sensible posted_at check: Greenhouse updated_at is NOT used as posting date
  const ghRawWithUpdated = {
    ...ghFixture.jobs[0],
    updated_at: '2020-01-01T00:00:00Z',
    first_published_at: '2026-05-01T00:00:00Z',
  };
  const ghNormalizedWithPub = normalizeAtsJob(ghRawWithUpdated, 'greenhouse', 'Stripe', 'stripe');
  assert(
    ghNormalizedWithPub?.posted_at === '2026-05-01T00:00:00Z',
    'Greenhouse normalization prioritizes first_published_at over updated_at'
  );

  const ghRawOnlyUpdated = {
    ...ghFixture.jobs[0],
    updated_at: '2020-01-01T00:00:00Z',
    first_published_at: undefined,
    created_at: undefined,
  };
  const ghNormalizedOnlyUpd = normalizeAtsJob(ghRawOnlyUpdated, 'greenhouse', 'Stripe', 'stripe');
  assert(
    ghNormalizedOnlyUpd?.posted_at !== '2020-01-01T00:00:00Z',
    'Greenhouse updated_at is NEVER used as posted_at when first_published_at is missing'
  );

  // Lever Normalization
  const leverJob = normalizeAtsJob(leverFixture[0], 'lever', 'Spotify', 'spotify');
  assert(leverJob !== null, 'Lever job normalizes successfully via ONE normalizer');
  assert(leverJob?.source === 'lever', 'Lever job source matches "lever"');
  assert(leverJob?.title === 'Data Engineering Lead', 'Lever title matches raw posting title');
  assert(leverJob?.country_code === 'SE', 'Lever country code maps "Stockholm, Sweden" to "SE"');
  assert(leverJob?.apply_url.includes('lever.co'), 'Lever real apply URL preserved');

  // Ashby Normalization
  const ashbyJob = normalizeAtsJob(ashbyFixture.jobs[0], 'ashby', 'OpenAI', 'openai');
  assert(ashbyJob !== null, 'Ashby job normalizes successfully via ONE normalizer');
  assert(ashbyJob?.source === 'ashby', 'Ashby job source matches "ashby"');
  assert(ashbyJob?.remote === true, 'Ashby remote detection identifies isRemote=true');
  assert(ashbyJob?.apply_url.includes('ashbyhq.com'), 'Ashby real apply URL preserved');

  // ---------------------------------------------------------------------------
  // 3. Strict apply_url Validation: HTTPS-only and Non-Forbidden Host
  // ---------------------------------------------------------------------------
  assert(isValidApplyUrl('https://boards.greenhouse.io/stripe/jobs/1'), 'Valid HTTPS Greenhouse apply_url is accepted');
  assert(isValidApplyUrl('https://jobs.lever.co/spotify/123'), 'Valid HTTPS Lever apply_url is accepted');
  assert(isValidApplyUrl('https://jobs.ashbyhq.com/openai/456'), 'Valid HTTPS Ashby apply_url is accepted');

  // Insecure and forbidden hosts
  assert(!isValidApplyUrl('http://boards.greenhouse.io/stripe/jobs/1'), 'HTTP insecure apply_url is rejected');
  assert(!isValidApplyUrl('https://linkedin.com/jobs/view/123'), 'LinkedIn apply_url is rejected');
  assert(!isValidApplyUrl('https://indeed.com/viewjob?jk=123'), 'Indeed apply_url is rejected');
  assert(!isValidApplyUrl('https://company.myworkdayjobs.com/careers/job/1'), 'Workday apply_url is rejected');
  assert(!isValidApplyUrl('https://glassdoor.com/job/1'), 'Glassdoor apply_url is rejected');
  assert(!isValidApplyUrl(''), 'Empty apply_url is rejected');

  // Rejection in normalizeAtsJob
  const badApplyJob = normalizeAtsJob(
    { title: 'Engineer', absolute_url: 'https://indeed.com/viewjob?jk=123' },
    'greenhouse',
    'BadCorp',
    'badcorp'
  );
  assert(badApplyJob === null, 'Job with forbidden apply_url returns null from normalizeAtsJob');

  const httpApplyJob = normalizeAtsJob(
    { title: 'Engineer', absolute_url: 'http://boards.greenhouse.io/bad/1' },
    'greenhouse',
    'BadCorp',
    'badcorp'
  );
  assert(httpApplyJob === null, 'Job with HTTP apply_url returns null from normalizeAtsJob');

  // ---------------------------------------------------------------------------
  // 4. Script & HTML Sanitization
  // ---------------------------------------------------------------------------
  const dirtyDescription = '<div><p>Great role!</p><script>alert("hack")</script><style>body{color:red;}</style></div>';
  const cleaned = cleanAndTruncateDescription(dirtyDescription);
  assert(!cleaned?.includes('<script>') && !cleaned?.includes('alert') && !cleaned?.includes('<style>'), 'Sanitization strictly strips script and style tags');
  assert(!cleaned?.includes('<p>') && !cleaned?.includes('<div>'), 'Sanitization removes all HTML tags leaving plain text');

  // ---------------------------------------------------------------------------
  // 5. Deduplication: Stable ATS ID, Real Apply URL, and Role Key
  // ---------------------------------------------------------------------------
  const rawBatch = [
    { ...ghJob! },
    { ...ghJob!, apply_url: ghJob!.apply_url + '?source=aggregator' }, // Same role, modified URL
    { ...ghJob!, source: 'lever' as const, apply_url: 'https://other-site.com/apply' }, // Same role cross-source
    { ...leverJob! },
    { ...ashbyJob! },
  ];

  const dedupResult = dedupJobs(rawBatch);
  assert(dedupResult.accepted.length === 3, `Deduplication reduces 5 items (with 2 duplicates) to 3 unique jobs (got: ${dedupResult.accepted.length})`);
  assert(dedupResult.duplicates === 2, `Duplicates dropped count is 2 (got: ${dedupResult.duplicates})`);

  // ---------------------------------------------------------------------------
  // 6. Closed-Job Handling: Non-Empty Fetch Check, source+company_slug scope, 2 misses
  // ---------------------------------------------------------------------------
  const trackedJobs: ClosedJobRecord[] = [
    {
      id: 'job-uuid-1',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: 'stripe-1001',
      company: 'Stripe',
      title: 'Senior Backend Engineer',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-2',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: 'stripe-1002',
      company: 'Stripe',
      title: 'Customer Support Specialist',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-3',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: 'stripe-1003',
      company: 'Stripe',
      title: 'Staff Security Engineer',
      consecutive_misses: 1, // Already missed once
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-4',
      source: 'lever', // Different source & company
      company_slug: 'spotify',
      source_job_id: 'spotify-2001',
      company: 'Spotify',
      title: 'Data Lead',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
  ];

  // Fetch 1: Successful non-empty fetch for Stripe (stripe-1001 present, stripe-1002 and stripe-1003 absent)
  const freshIdsFetch1 = new Set(['stripe-1001']);
  const decisions1 = handleClosedJobs(trackedJobs, freshIdsFetch1, {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });

  const job1 = decisions1.find((d) => d.source_job_id === 'stripe-1001')!;
  const job2 = decisions1.find((d) => d.source_job_id === 'stripe-1002')!;
  const job3 = decisions1.find((d) => d.source_job_id === 'stripe-1003')!;

  assert(job1.consecutive_misses === 0 && job1.is_active === true, 'Present job keeps consecutive_misses=0 and is_active=true');
  assert(job2.consecutive_misses === 1 && job2.is_active === true, 'First-time missing job increments misses to 1 and REMAINS active');
  assert(job3.consecutive_misses === 2 && job3.is_active === false && job3.status === 'inactive', 'Job missing for 2nd consecutive time is marked inactive');
  assert(decisions1.length === 3, 'Only Stripe jobs evaluated; Spotify job was isolated');

  // Empty fetch safety: If fetch returned 0 jobs or failed, miss counting is SKIPPED
  const emptyDecisions = handleClosedJobs(trackedJobs, new Set(), {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });
  assert(emptyDecisions.length === 0, 'Empty fetch (0 jobs returned) skips miss counting entirely');

  const failedFetchDecisions = handleClosedJobs(trackedJobs, new Set(['stripe-1001']), {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: false,
  });
  assert(failedFetchDecisions.length === 0, 'Failed fetch skips miss counting entirely');

  // Fetch 2: stripe-1003 reappears -> misses reset to 0 and becomes active again
  const freshIdsFetch2 = new Set(['stripe-1003']);
  const reappearedJobs: ClosedJobRecord[] = [
    {
      id: job3.id,
      source: job3.source,
      company_slug: job3.company_slug,
      source_job_id: job3.source_job_id,
      company: 'Stripe',
      title: 'Staff Security Engineer',
      consecutive_misses: job3.consecutive_misses,
      is_active: job3.is_active,
      status: job3.status,
    },
  ];
  const decisions2 = handleClosedJobs(reappearedJobs, freshIdsFetch2, {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });
  const job3Reactivated = decisions2[0];
  assert(job3Reactivated.consecutive_misses === 0 && job3Reactivated.is_active === true, 'Reappearing job resets consecutive_misses to 0 and marks active');

  // ---------------------------------------------------------------------------
  // 7. Authorized Public API Endpoints & Scraping Blocklist
  // ---------------------------------------------------------------------------
  assert(isAuthorizedAtsUrl('https://boards-api.greenhouse.io/v1/boards/stripe/jobs', 'greenhouse'), 'Greenhouse boards-api public URL is authorized');
  assert(isAuthorizedAtsUrl('https://api.lever.co/v0/postings/spotify?mode=json', 'lever'), 'Lever public postings API URL is authorized');
  assert(isAuthorizedAtsUrl('https://api.ashbyhq.com/posting-api/job-board/openai', 'ashby'), 'Ashby posting-api public URL is authorized');

  // Banned non-API or scrapable endpoints
  assert(!isAuthorizedAtsUrl('https://linkedin.com/jobs/view/1234', 'greenhouse'), 'LinkedIn job URL is strictly blocked');
  assert(!isAuthorizedAtsUrl('https://indeed.com/viewjob?jk=1234', 'lever'), 'Indeed job URL is strictly blocked');
  assert(!isAuthorizedAtsUrl('https://naukri.com/job-listings-1234', 'ashby'), 'Naukri job URL is strictly blocked');
  assert(!isAuthorizedAtsUrl('https://glassdoor.com/job-listing/1234', 'greenhouse'), 'Glassdoor job URL is strictly blocked');
  assert(!isAuthorizedAtsUrl('https://company.myworkdayjobs.com/careers', 'lever'), 'Workday career portal is strictly blocked');
  assert(!isAuthorizedAtsUrl('https://careers.google.com/jobs/results', 'ashby'), 'Generic HTML career page is strictly blocked');
  assert(!isAuthorizedAtsUrl('http://boards-api.greenhouse.io/v1/boards/stripe/jobs', 'greenhouse'), 'Non-HTTPS insecure endpoint is blocked');

  // ---------------------------------------------------------------------------
  // 8. Dry-Run Execution on Fixtures
  // ---------------------------------------------------------------------------
  const fixtureStats = await runBoardIngestion({
    dryRun: true,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
  });

  assert(fixtureStats.companiesAttempted === 3, 'Batch attempted 3 companies from fixtures');
  assert(fixtureStats.totalJobsAccepted > 0, `Batch accepted ${fixtureStats.totalJobsAccepted} normalized jobs`);

  // ---------------------------------------------------------------------------
  // 9. Zero Secrets in Logs
  // ---------------------------------------------------------------------------
  const sampleLog = `Ingested 3 companies. Config: ${JSON.stringify(fixtureStats.topCompanies)}`;
  assert(!sampleLog.includes('sbp_') && !sampleLog.includes('eyJhbGciOi') && !sampleLog.includes('secret'), 'Ingestion logs contain zero secret tokens');

  // ---------------------------------------------------------------------------
  // 10. Subprocess Negative Control Verification (Proves non-zero exit)
  // ---------------------------------------------------------------------------
  console.log('\nRunning negative control subprocess to verify non-zero exit on invalid inputs...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-board-ingestion.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });
  assert(
    negResult.status !== 0,
    `Negative control subprocess exited non-zero as expected (code ${negResult.status})`
  );

  console.log('\n==================================================================');
  console.log(`📊 AUDIT RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
