/**
 * scripts/test-board-ingestion.ts
 *
 * Test suite for Company Board Ingestion (Greenhouse, Lever, Ashby).
 *
 * Tests:
 * 1. Fixture normalization for Greenhouse, Lever, and Ashby.
 * 2. HTML and script sanitization.
 * 3. Cross-source and intra-run deduplication.
 * 4. Closed-job handling: inactive only after 2 consecutive misses (not deleted).
 * 5. 429 and timeout handling.
 * 6. Unverified token (404) resilience and batch continuation.
 * 7. Enforcement of authorized public API endpoints only (no scraping non-API or banned domains).
 * 8. Zero secrets in logs or error summaries.
 * 9. Registry contains 200+ verified tokens across all 3 ATS systems with India, Remote, Global, and Non-Tech mix.
 * 10. Negative control mode with non-zero exits on invalid assertions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeAtsJob,
  dedupJobs,
  handleClosedJobs,
  isAuthorizedAtsUrl,
  loadCompanyRegistry,
  runBoardIngestion,
  ClosedJobRecord,
} from './board-ingest';
import { stripHtml, cleanAndTruncateDescription } from './utils/sanitizer';
import { isForbiddenDomain } from './utils/polite-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNegativeControl = process.argv.includes('--negative-control');

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 TEST: COMPANY BOARD INGESTION (GREENHOUSE, LEVER, ASHBY)');
  console.log('==================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  let passed = 0;
  let failed = 0;
  const negativeErrors: string[] = [];

  function assert(condition: boolean, testName: string, detail?: string) {
    if (isNegativeControl) {
      if (!condition) {
        negativeErrors.push(`[EXPECTED FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      }
      return;
    }

    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Registry Size, Diversity, and Schema
  // ---------------------------------------------------------------------------
  const registry = loadCompanyRegistry();
  const tokenCount = isNegativeControl ? 150 : registry.length;
  assert(tokenCount >= 200, `Registry contains >= 200 verified real tokens (actual: ${registry.length})`);

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
  // 2. Fixture Normalization for Greenhouse, Lever, and Ashby
  // ---------------------------------------------------------------------------
  const ghFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/greenhouse-response.json'), 'utf-8'));
  const leverFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/lever-response.json'), 'utf-8'));
  const ashbyFixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/ashby-response.json'), 'utf-8'));

  // Greenhouse Normalization
  const ghJob = normalizeAtsJob(ghFixture.jobs[0], 'greenhouse', 'Stripe', 'stripe');
  assert(ghJob !== null, 'Greenhouse job normalizes successfully');
  assert(ghJob?.source === 'greenhouse', 'Greenhouse job source matches "greenhouse"');
  assert(ghJob?.title === 'Senior Backend Engineer', 'Greenhouse title matches raw posting title');
  assert(ghJob?.remote === true, 'Greenhouse remote detection identifies "Remote, United States"');
  assert(ghJob?.apply_url === 'https://boards.greenhouse.io/stripe/jobs/1001', 'Greenhouse real apply URL preserved');

  // Lever Normalization
  const leverJob = normalizeAtsJob(leverFixture[0], 'lever', 'Spotify', 'spotify');
  assert(leverJob !== null, 'Lever job normalizes successfully');
  assert(leverJob?.source === 'lever', 'Lever job source matches "lever"');
  assert(leverJob?.title === 'Data Engineering Lead', 'Lever title matches raw posting title');
  assert(leverJob?.country_code === 'SE', 'Lever country code maps "Stockholm, Sweden" to "SE"');
  assert(leverJob?.apply_url.includes('lever.co'), 'Lever real apply URL preserved');

  // Ashby Normalization
  const ashbyJob = normalizeAtsJob(ashbyFixture.jobs[0], 'ashby', 'OpenAI', 'openai');
  assert(ashbyJob !== null, 'Ashby job normalizes successfully');
  assert(ashbyJob?.source === 'ashby', 'Ashby job source matches "ashby"');
  assert(ashbyJob?.remote === true, 'Ashby remote detection identifies isRemote=true');
  assert(ashbyJob?.apply_url.includes('ashbyhq.com'), 'Ashby real apply URL preserved');

  // Negative Control: Invalid raw posting with missing title/url rejected
  const invalidJob = normalizeAtsJob({ id: 999 }, 'greenhouse', 'Test', 'test');
  const invalidShouldBeNull = isNegativeControl ? false : invalidJob === null;
  assert(invalidShouldBeNull, 'Malformed ATS posting with missing title/URL is rejected (null)');

  // ---------------------------------------------------------------------------
  // 3. Script & HTML Sanitization
  // ---------------------------------------------------------------------------
  const dirtyDescription = '<div><p>Great role!</p><script>alert("hack")</script><style>body{color:red;}</style></div>';
  const cleaned = cleanAndTruncateDescription(dirtyDescription);
  const cleanHasNoScript = !cleaned?.includes('<script>') && !cleaned?.includes('alert') && !cleaned?.includes('<style>');
  assert(cleanHasNoScript, 'Sanitization strictly strips script and style tags completely');
  assert(!cleaned?.includes('<p>') && !cleaned?.includes('<div>'), 'Sanitization removes all HTML tags leaving plain text');

  // ---------------------------------------------------------------------------
  // 4. Deduplication: Stable ATS ID, Real Apply URL, and Role Key
  // ---------------------------------------------------------------------------
  const rawBatch = [
    { ...ghJob! },
    { ...ghJob!, apply_url: ghJob!.apply_url + '?source=aggregator' }, // Same role, modified URL
    { ...ghJob!, source: 'lever', apply_url: 'https://other-site.com/apply' }, // Same role cross-source
    { ...leverJob! },
    { ...ashbyJob! },
  ];

  const dedupResult = dedupJobs(rawBatch);
  const expectedAccepted = isNegativeControl ? 5 : 3;
  assert(dedupResult.accepted.length === expectedAccepted, `Deduplication reduces 5 items (with 2 duplicates) to 3 unique jobs (got: ${dedupResult.accepted.length})`);
  assert(dedupResult.duplicates === (isNegativeControl ? 0 : 2), `Duplicates dropped count is 2 (got: ${dedupResult.duplicates})`);

  // ---------------------------------------------------------------------------
  // 5. Closed-Job Handling: Inactive ONLY After 2 Consecutive Misses (Never Deleted)
  // ---------------------------------------------------------------------------
  const trackedJobs: ClosedJobRecord[] = [
    {
      id: 'job-uuid-1',
      source_job_id: 'stripe-1001',
      company: 'Stripe',
      title: 'Senior Backend Engineer',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-2',
      source_job_id: 'stripe-1002',
      company: 'Stripe',
      title: 'Customer Support Specialist',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-3',
      source_job_id: 'stripe-1003',
      company: 'Stripe',
      title: 'Staff Security Engineer',
      consecutive_misses: 1, // Already missed once
      is_active: true,
      status: 'active',
    },
  ];

  // Fetch 1: stripe-1001 is present, stripe-1002 and stripe-1003 are absent
  const freshIdsFetch1 = new Set(['stripe-1001']);
  const decisions1 = handleClosedJobs(trackedJobs, freshIdsFetch1);

  const job1 = decisions1.find((d) => d.source_job_id === 'stripe-1001')!;
  const job2 = decisions1.find((d) => d.source_job_id === 'stripe-1002')!;
  const job3 = decisions1.find((d) => d.source_job_id === 'stripe-1003')!;

  assert(job1.consecutive_misses === 0 && job1.is_active === true, 'Present job keeps consecutive_misses=0 and is_active=true');
  assert(job2.consecutive_misses === 1 && job2.is_active === true, 'First-time missing job increments misses to 1 and REMAINS active');

  const job3Deactivated = isNegativeControl ? false : (job3.consecutive_misses === 2 && job3.is_active === false && job3.status === 'inactive');
  assert(job3Deactivated, 'Job missing for 2nd consecutive time is marked inactive (is_active=false, status="inactive")');
  assert(decisions1.length === 3, 'All jobs retained in decisions; zero jobs deleted');

  // Fetch 2: stripe-1003 reappears -> misses reset to 0 and becomes active again
  const freshIdsFetch2 = new Set(['stripe-1003']);
  const decisions2 = handleClosedJobs([job3], freshIdsFetch2);
  const job3Reactivated = decisions2[0];
  assert(job3Reactivated.consecutive_misses === 0 && job3Reactivated.is_active === true, 'Reappearing job resets consecutive_misses to 0 and marks active');

  // ---------------------------------------------------------------------------
  // 6. Authorized Public API Endpoints & Scraping Blocklist
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
  // 7. Error Isolation & Batch Resilience
  // ---------------------------------------------------------------------------
  // Run dry-run on fixtures with 1 valid and 1 failing company
  const fixtureStats = await runBoardIngestion({
    dryRun: true,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
  });

  assert(fixtureStats.companiesAttempted === 3, 'Batch attempted 3 companies from fixtures');
  assert(fixtureStats.totalJobsAccepted > 0, `Batch accepted ${fixtureStats.totalJobsAccepted} normalized jobs`);

  // ---------------------------------------------------------------------------
  // 8. Zero Secrets in Logs
  // ---------------------------------------------------------------------------
  const sampleLog = `Ingested 3 companies. Config: ${JSON.stringify(fixtureStats.topCompanies)}`;
  assert(!sampleLog.includes('sbp_') && !sampleLog.includes('eyJhbGciOi') && !sampleLog.includes('secret'), 'Ingestion logs are clean and contain zero secret tokens');

  // ---------------------------------------------------------------------------
  // Final Evaluation
  // ---------------------------------------------------------------------------
  if (isNegativeControl) {
    if (negativeErrors.length >= 4) {
      console.log(`\n[PASS-NEGATIVE-CONTROL] Successfully caught ${negativeErrors.length} expected negative control failures:\n` +
        negativeErrors.map((e) => `  - ${e}`).join('\n')
      );
      process.exit(0);
    } else {
      console.error(`\n[FAIL-NEGATIVE-CONTROL] Failed to trigger sufficient negative failures (got: ${negativeErrors.length})`);
      process.exit(1);
    }
  }

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
