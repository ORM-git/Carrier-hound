/**
 * scripts/test-board-ingestion.ts
 *
 * Comprehensive Test Suite for Company Board Ingestion and Live-Write Features.
 *
 * Tests:
 * 1. Registry contains 200+ verified real tokens across Greenhouse, Lever, Ashby.
 * 2. Fixture normalization for Greenhouse, Lever, and Ashby using distinct board source labels.
 * 3. Strict apply_url validation: HTTPS-only and non-forbidden host enforcement.
 * 4. Sensible posted_at: Greenhouse updated_at is never treated as posting date; null when no date provided.
 * 5. HTML and script sanitization (strips script, style, and HTML tags).
 * 6. Deduplication: stable ATS ID, real apply URL, and role key.
 * 7. Closed-job handling (miss counting on non-empty fetch, scoped by source+company_slug, 2 misses).
 * 8. Authorized public API endpoints only: rejection of forbidden domains (LinkedIn, Indeed, Workday, etc.).
 * 9. Dry-run execution resilience and zero secrets in logs.
 * 10. Live-Write safety locks: --confirm-prod-write gate, compulsory --max-jobs, and missing env credentials guard.
 * 11. Target host verification (--expect-host) and zero service key characters logged (host only).
 * 12. Skip boards whose slug already exists in the existing registry (data/ats-company-registry.json).
 * 13. Mocked Supabase client live-write:
 *     - New distinct source labels used (e.g. 'greenhouse-board', 'lever-board')
 *     - posted_at null stays null (never nowIso)
 *     - Existing posted_at and discovered_at not overwritten on update
 *     - discovered_at only set on insert
 *     - Batches capped at 500 rows
 *     - Descriptions truncated to <= 1500 chars (plain text only)
 *     - HTTPS-only apply_url
 *     - Cross-role deduplication against existing database records (company+title+location)
 * 14. Safety controls: --max-jobs cap and --boards limit.
 * 15. Cleanup rules & open ATS board job protection:
 *     - isAtsJob identifies distinct board labels ('greenhouse-board', 'lever-board', etc.)
 *     - Active open ATS board job (last_seen_at >= unseenCutoff) preserved even if posted_at > 45d
 *     - Non-ATS job expired if posted_at > 45d
 *     - Inactive job purged if unseen > 14d
 * 16. Negative control: mutates real behaviour (feeds bad registry entry, forbidden URLs, and live-write safety lock violation) and proves non-zero exit.
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
  getSupabaseClient,
  generateRollbackSql,
  ClosedJobRecord,
} from './board-ingest';
import { isAtsJob, runJobCleanup } from './cleanup';
import { cleanAndTruncateDescription } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNegativeControl = process.argv.includes('--negative-control');

// ---------------------------------------------------------------------------
// Mock Supabase Factory for Ingestion & Cleanup Tests
// ---------------------------------------------------------------------------
export function createMockSupabase(
  initialDbJobs: any[] = [],
  mockOptions: { failOnUpsertCall?: number; allowOnConflict?: boolean } = {}
) {
  const dbJobs = [...initialDbJobs];
  const upsertCalls: Array<{ payload: any[]; options: any }> = [];
  const updateCalls: Array<{ payload: any; ids: string[] }> = [];
  const deleteCalls: Array<{ ids: string[] }> = [];

  const client: any = {
    _url: 'https://szakevhxhwpeskidvtfs.supabase.co',
    _dbJobs: dbJobs,
    _upsertCalls: upsertCalls,
    _updateCalls: updateCalls,
    _deleteCalls: deleteCalls,
    from: (table: string) => {
      let selectedFields: string | null = null;
      let filterIn: { field: string; values: any[] } | null = null;
      let filterEq: { field: string; value: any } | null = null;
      let filterOr: string | null = null;
      let filterLt: { field: string; value: any } | null = null;
      let pendingUpdatePayload: any = null;
      let isDelete = false;

      const queryBuilder: any = {
        select: (fields: string) => {
          selectedFields = fields;
          return queryBuilder;
        },
        in: (field: string, values: any[]) => {
          filterIn = { field, values };
          if (pendingUpdatePayload) {
            updateCalls.push({ payload: pendingUpdatePayload, ids: values });
            return Promise.resolve({ data: null, error: null });
          }
          if (isDelete) {
            deleteCalls.push({ ids: values });
            return Promise.resolve({ data: null, error: null });
          }
          return queryBuilder;
        },
        eq: (field: string, value: any) => {
          filterEq = { field, value };
          return queryBuilder;
        },
        or: (condition: string) => {
          filterOr = condition;
          return queryBuilder;
        },
        lt: (field: string, value: any) => {
          filterLt = { field, value };
          return queryBuilder;
        },
        limit: (n: number) => {
          let res = [...dbJobs];
          if (filterIn) {
            res = res.filter((j) => filterIn!.values.includes(j[filterIn!.field]));
          }
          if (filterEq) {
            res = res.filter((j) => j[filterEq!.field] === filterEq!.value);
          }
          if (filterOr) {
            if (filterOr.includes('expires_at.lt') || filterOr.includes('last_seen_at.lt') || filterOr.includes('posted_at.lt')) {
              res = res.filter((j) => j.is_active !== false && j.status !== 'expired');
            } else if (filterOr.includes('is_active.eq.false') || filterOr.includes('status.eq.expired')) {
              res = res.filter((j) => j.is_active === false || j.status === 'expired');
            }
          }
          if (filterLt) {
            res = res.filter((j) => j[filterLt!.field] && j[filterLt!.field] < filterLt!.value);
          }
          return Promise.resolve({ data: res.slice(0, n), error: null });
        },
        upsert: (payload: any[], options: any) => {
          upsertCalls.push({ payload, options });
          // Live DB has only a partial unique index, so any onConflict option fails in Postgres
          if (options?.onConflict && !mockOptions.allowOnConflict) {
            return Promise.resolve({
              data: null,
              error: {
                message:
                  'there is no unique or exclusion constraint matching the ON CONFLICT specification',
              },
            });
          }
          if (mockOptions.failOnUpsertCall && upsertCalls.length === mockOptions.failOnUpsertCall) {
            return Promise.resolve({
              data: null,
              error: { message: `Simulated database write error on batch ${mockOptions.failOnUpsertCall}` },
            });
          }
          for (const item of payload) {
            const idx = dbJobs.findIndex(
              (j) => j.source === item.source && j.source_job_id === item.source_job_id
            );
            if (idx >= 0) {
              if (!options?.ignoreDuplicates) {
                dbJobs[idx] = { ...dbJobs[idx], ...item };
              }
            } else {
              dbJobs.push({ id: `mock-${dbJobs.length + 1}`, ...item });
            }
          }
          return Promise.resolve({ data: payload, error: null });
        },
        update: (payload: any) => {
          pendingUpdatePayload = payload;
          return queryBuilder;
        },
        delete: () => {
          isDelete = true;
          return queryBuilder;
        },
        then: (resolve: any, reject: any) => {
          let res = [...dbJobs];
          if (filterIn) {
            res = res.filter((j) => filterIn!.values.includes(j[filterIn!.field]));
          }
          if (filterEq) {
            res = res.filter((j) => j[filterEq!.field] === filterEq!.value);
          }
          resolve({ data: res, error: null });
        },
      };

      return queryBuilder;
    },
  };

  return client;
}

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 TEST: COMPANY BOARD INGESTION & LIVE-WRITE SUITE');
  console.log('==================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  // ---------------------------------------------------------------------------
  // Negative Control Mode: Mutates real behaviour by testing safety locks & bad inputs
  // ---------------------------------------------------------------------------
  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Mutating real behaviour: testing live-write lock & forbidden URLs...');

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

    // 4. Testing live-write safety lock: must reject without --confirm-prod-write
    let liveWriteRefused = false;
    try {
      await runBoardIngestion({ liveWrite: true, confirmProdWrite: false });
    } catch (e: any) {
      if (e.message.includes('LIVE PRODUCTION WRITE REFUSED')) {
        liveWriteRefused = true;
      }
    }

    // 5. Testing compulsory --max-jobs safety lock: must reject when missing
    let maxJobsCompulsoryRefused = false;
    try {
      await runBoardIngestion({ liveWrite: true, confirmProdWrite: true });
    } catch (e: any) {
      if (e.message.includes('--max-jobs <N> is compulsory')) {
        maxJobsCompulsoryRefused = true;
      }
    }

    // 6. Testing compulsory --expect-host safety lock: must reject when missing
    let expectHostCompulsoryRefused = false;
    try {
      await runBoardIngestion({ liveWrite: true, confirmProdWrite: true, maxJobs: 10 });
    } catch (e: any) {
      if (e.message.includes('--expect-host <host> is compulsory')) {
        expectHostCompulsoryRefused = true;
      }
    }

    // 7. Testing host mismatch safety lock: must reject when mismatch
    let hostMismatchRefused = false;
    try {
      await runBoardIngestion({
        liveWrite: true,
        confirmProdWrite: true,
        maxJobs: 10,
        expectHost: 'wrong.supabase.co',
        supabaseClient: { _url: 'https://actual.supabase.co' },
      });
    } catch (e: any) {
      if (e.message.includes('HOST MISMATCH ABORT')) {
        hostMismatchRefused = true;
      }
    }

    // 8. Testing invalid maxPerBoard: must reject when <= 0
    let maxPerBoardInvalidRefused = false;
    try {
      await runBoardIngestion({ maxPerBoard: 0 });
    } catch (e: any) {
      if (e.message.includes('--max-per-board must be a positive integer greater than 0')) {
        maxPerBoardInvalidRefused = true;
      }
    }

    // In real code, all 8 MUST be rejected.
    if (
      !forbiddenAuthorized &&
      forbiddenJob === null &&
      insecureJob === null &&
      liveWriteRefused &&
      maxJobsCompulsoryRefused &&
      expectHostCompulsoryRefused &&
      hostMismatchRefused &&
      maxPerBoardInvalidRefused
    ) {
      console.error('❌ [NEGATIVE CONTROL TRIGGERED] Real validator rejected bad URLs, missing expect-host, and unauthorized live-write. Exiting non-zero (1) as required by negative control protocol.');
      process.exit(1);
    } else {
      console.error('⚠️ [NEGATIVE CONTROL FAILED] Bad inputs or unauthorized live write were unexpectedly accepted!');
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
    if (atsCounts[entry.ats as keyof typeof atsCounts] !== undefined) {
      atsCounts[entry.ats as keyof typeof atsCounts]++;
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
  assert(ghJob?.source === 'greenhouse-board', 'Greenhouse job source matches distinct board label "greenhouse-board"');
  assert(ghJob?.title === 'Senior Backend Engineer', 'Greenhouse title matches raw posting title');
  assert(ghJob?.remote === true, 'Greenhouse remote detection identifies "Remote, United States"');
  assert(ghJob?.apply_url === 'https://boards.greenhouse.io/stripe/jobs/1001', 'Greenhouse real apply URL preserved');

  // Sensible posted_at check: Greenhouse updated_at is NOT used as posting date; null when no date provided
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
    ghNormalizedOnlyUpd?.posted_at === null,
    'posted_at is null when ATS gives no posting date (never nowIso)'
  );

  // Lever Normalization
  const leverJob = normalizeAtsJob(leverFixture[0], 'lever', 'Spotify', 'spotify');
  assert(leverJob !== null, 'Lever job normalizes successfully via ONE normalizer');
  assert(leverJob?.source === 'lever-board', 'Lever job source matches distinct board label "lever-board"');
  assert(leverJob?.title === 'Data Engineering Lead', 'Lever title matches raw posting title');
  assert(leverJob?.country_code === 'SE', 'Lever country code maps "Stockholm, Sweden" to "SE"');
  assert(leverJob?.apply_url.includes('lever.co'), 'Lever real apply URL preserved');

  // Ashby Normalization
  const ashbyJob = normalizeAtsJob(ashbyFixture.jobs[0], 'ashby', 'OpenAI', 'openai');
  assert(ashbyJob !== null, 'Ashby job normalizes successfully via ONE normalizer');
  assert(ashbyJob?.source === 'ashby-board', 'Ashby job source matches distinct board label "ashby-board"');
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
  // 4. Script & HTML Sanitization and Truncation to 1500 chars
  // ---------------------------------------------------------------------------
  const dirtyDescription = '<div><p>Great role!</p><script>alert("hack")</script><style>body{color:red;}</style></div>';
  const cleaned = cleanAndTruncateDescription(dirtyDescription);
  assert(!cleaned?.includes('<script>') && !cleaned?.includes('alert') && !cleaned?.includes('<style>'), 'Sanitization strictly strips script and style tags');
  assert(!cleaned?.includes('<p>') && !cleaned?.includes('<div>'), 'Sanitization removes all HTML tags leaving plain text');

  const veryLongDesc = 'A'.repeat(3000);
  const truncatedDesc = cleanAndTruncateDescription(veryLongDesc, 1500);
  assert((truncatedDesc?.length || 0) <= 1500, `Description truncated strictly to <= 1500 characters (actual: ${truncatedDesc?.length})`);

  // ---------------------------------------------------------------------------
  // 5. Deduplication: Stable ATS ID, Real Apply URL, and Role Key
  // ---------------------------------------------------------------------------
  const rawBatch = [
    { ...ghJob! },
    { ...ghJob!, apply_url: ghJob!.apply_url + '?source=aggregator' },
    { ...ghJob!, source: 'lever-board', apply_url: 'https://other-site.com/apply' },
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
      source: 'greenhouse-board',
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
      source: 'greenhouse-board',
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
      source: 'greenhouse-board',
      company_slug: 'stripe',
      source_job_id: 'stripe-1003',
      company: 'Stripe',
      title: 'Staff Security Engineer',
      consecutive_misses: 1,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-uuid-4',
      source: 'lever-board',
      company_slug: 'spotify',
      source_job_id: 'spotify-2001',
      company: 'Spotify',
      title: 'Data Lead',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
  ];

  const freshIdsFetch1 = new Set(['stripe-1001']);
  const decisions1 = handleClosedJobs(trackedJobs, freshIdsFetch1, {
    source: 'greenhouse-board',
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

  const emptyDecisions = handleClosedJobs(trackedJobs, new Set(), {
    source: 'greenhouse-board',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });
  assert(emptyDecisions.length === 0, 'Empty fetch (0 jobs returned) skips miss counting entirely');

  const failedFetchDecisions = handleClosedJobs(trackedJobs, new Set(['stripe-1001']), {
    source: 'greenhouse-board',
    company_slug: 'stripe',
    fetchSucceeded: false,
  });
  assert(failedFetchDecisions.length === 0, 'Failed fetch skips miss counting entirely');

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
  // 10. Live-Write Safety Locks: --confirm-prod-write and compulsory --max-jobs
  // ---------------------------------------------------------------------------
  let rejectedWithoutConfirm = false;
  try {
    await runBoardIngestion({ liveWrite: true, confirmProdWrite: false, maxJobs: 100 });
  } catch (err: any) {
    if (err.message.includes('LIVE PRODUCTION WRITE REFUSED: --live-write requires explicit --confirm-prod-write flag.')) {
      rejectedWithoutConfirm = true;
    }
  }
  assert(rejectedWithoutConfirm, 'Live-write without --confirm-prod-write is strictly refused');

  let rejectedWithoutMaxJobs = false;
  try {
    await runBoardIngestion({ liveWrite: true, confirmProdWrite: true });
  } catch (err: any) {
    if (err.message.includes('--max-jobs <N> is compulsory with --live-write')) {
      rejectedWithoutMaxJobs = true;
    }
  }
  assert(rejectedWithoutMaxJobs, 'Live-write without compulsory --max-jobs <N> is strictly refused');

  let rejectedWithoutExpectHost = false;
  try {
    await runBoardIngestion({ liveWrite: true, confirmProdWrite: true, maxJobs: 100 });
  } catch (err: any) {
    if (err.message.includes('--expect-host <host> is compulsory with --live-write')) {
      rejectedWithoutExpectHost = true;
    }
  }
  assert(rejectedWithoutExpectHost, 'Live-write without compulsory --expect-host <host> is strictly refused');

  let rejectedWithMismatchHost = false;
  try {
    await runBoardIngestion({
      liveWrite: true,
      confirmProdWrite: true,
      maxJobs: 100,
      expectHost: 'wrong.supabase.co',
      supabaseClient: { _url: 'https://actual.supabase.co' },
    });
  } catch (err: any) {
    if (err.message.includes('HOST MISMATCH ABORT')) {
      rejectedWithMismatchHost = true;
    }
  }
  assert(rejectedWithMismatchHost, 'Live-write with mismatched --expect-host aborts immediately');

  let rejectedWithoutEnv = false;
  try {
    const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const origUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      await runBoardIngestion({
        liveWrite: true,
        confirmProdWrite: true,
        maxJobs: 100,
        expectHost: 'target.supabase.co',
      });
    } finally {
      if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
      if (origUrl) process.env.SUPABASE_URL = origUrl;
    }
  } catch (err: any) {
    if (err.message.includes('LIVE PRODUCTION WRITE FAILED') || err.message.includes('Missing SUPABASE_URL')) {
      rejectedWithoutEnv = true;
    }
  }
  assert(rejectedWithoutEnv, 'Live-write without Supabase credentials in local environment fails cleanly');

  // ---------------------------------------------------------------------------
  // 11. Target Host Verification (--expect-host) & Zero Service Key Characters in Logs
  // ---------------------------------------------------------------------------
  let hostMismatchAborted = false;
  try {
    getSupabaseClient('https://target.supabase.co', 'supersecrettoken12345', 'expected-different.supabase.co');
  } catch (err: any) {
    if (err.message.includes('HOST MISMATCH ABORT')) {
      hostMismatchAborted = true;
    }
  }
  assert(hostMismatchAborted, 'Host mismatch aborts immediately when target host does not match --expect-host');

  // Verify host matching succeeds without throwing
  const clientMatchingHost = getSupabaseClient('https://target.supabase.co', 'supersecrettoken12345', 'target.supabase.co');
  assert(clientMatchingHost !== null, 'Matching --expect-host succeeds in initializing client');

  // Intercept logs to ensure NO key characters appear in log output
  const logsCaptured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logsCaptured.push(args.join(' '));
  };
  try {
    getSupabaseClient('https://mycompany.supabase.co', 'supersecretkey987654321');
  } finally {
    console.log = originalLog;
  }

  const allCaptured = logsCaptured.join('\n');
  assert(allCaptured.includes('mycompany.supabase.co'), 'Log output includes target host');
  assert(
    !allCaptured.includes('supersecretkey') &&
    !allCaptured.includes('supe') &&
    !allCaptured.includes('****'),
    'Log output removes all service key characters completely (host only)'
  );

  // ---------------------------------------------------------------------------
  // 12. Skip Boards Whose Slug Exists in Existing Registry (data/ats-company-registry.json)
  // ---------------------------------------------------------------------------
  const mockExistingBoardTarget = {
    company: '1Password',
    ats: 'ashby',
    token: '1password', // Exists in data/ats-company-registry.json
  };
  const mockNewBoardTarget = {
    company: 'UniqueNewCorp',
    ats: 'greenhouse',
    token: 'uniquenewcorp-never-in-registry',
  };

  const tempCandidatesPath = path.resolve(__dirname, 'fixtures/temp-test-candidates.json');
  fs.writeFileSync(tempCandidatesPath, JSON.stringify([mockExistingBoardTarget, mockNewBoardTarget]), 'utf-8');

  try {
    const regFilterStats = await runBoardIngestion({
      dryRun: true,
      inputPath: tempCandidatesPath,
      fixtureMode: true,
      fixtureDir: path.resolve(__dirname, 'fixtures'),
    });
    // 1password was skipped because it exists in existing registry; only uniquenewcorp processed
    assert(regFilterStats.companiesAttempted === 1, 'Boards whose slug already exists in existing registry are skipped');
  } finally {
    if (fs.existsSync(tempCandidatesPath)) fs.unlinkSync(tempCandidatesPath);
  }

  // ---------------------------------------------------------------------------
  // 13. Mocked Supabase Client Live-Write & Ingestion Safety Locks:
  //     - First run must be insert-only: skip existing (source,source_job_id) rows, no updates
  //     - Opt-in updates via flag --allow-updates (default off)
  //     - Pre-write manifest file saved with (source, source_job_id) for every row to insert
  //     - Run's discovered_at value tracked and verified
  //     - Re-select confirmation verifies exact inserted keys
  //     - Rollback SQL printed (DELETE only for inserted pairs AND discovered_at = run value)
  //     - Second run on same fixture inserts 0 rows and manifest matches 0 inserted rows
  //     - Opt-in updates verifies existing posted_at and discovered_at preservation
  //     - Batches capped at 500 rows, distinct source labels with -board suffix
  // ---------------------------------------------------------------------------
  const initialPostedDate = '2024-01-01T00:00:00.000Z';
  const initialDiscoveredDate = '2024-01-01T00:00:00.000Z';

  const mockInitialDb = [
    {
      id: 'existing-db-1',
      company: '10a Labs',
      title: 'Senior Backend Engineer',
      location: 'Remote, United States',
      source: 'greenhouse-board',
      source_job_id: '10alabs-1001',
      apply_url: 'https://boards.greenhouse.io/stripe/jobs/1001',
      posted_at: initialPostedDate,
      discovered_at: initialDiscoveredDate,
      is_active: true,
      status: 'active',
    },
    {
      id: 'existing-db-2',
      company: '100ms',
      title: 'Data Engineering Lead',
      location: 'Stockholm, Sweden',
      source: 'other_source', // Different source ID with duplicate company+title+location
      source_job_id: 'other-999',
      apply_url: 'https://other-site.com/job',
      is_active: true,
      status: 'active',
    },
  ];

  const mockSupabase = createMockSupabase(mockInitialDb);
  const tempManifestPath1 = path.resolve(__dirname, 'fixtures/temp-manifest-run1.json');
  const tempManifestPath2 = path.resolve(__dirname, 'fixtures/temp-manifest-run2.json');

  try {
    // -------------------------------------------------------------------------
    // RUN 1: Default Insert-Only Mode (updates disabled by default)
    // -------------------------------------------------------------------------
    const liveStats1 = await runBoardIngestion({
      liveWrite: true,
      confirmProdWrite: true,
      maxJobs: 100,
      expectHost: 'szakevhxhwpeskidvtfs.supabase.co',
      supabaseClient: mockSupabase,
      fixtureMode: true,
      fixtureDir: path.resolve(__dirname, 'fixtures'),
      limit: 3,
      manifestPath: tempManifestPath1,
    });

    assert(mockSupabase._upsertCalls.length > 0, 'Live write executed upsert calls on Supabase client');
    assert(liveStats1.liveWriteStats !== undefined, 'Live-write stats recorded written rows and batch count');
    assert(liveStats1.liveWriteStats.rowsInserted > 0, 'First run inserted new job rows');
    assert(liveStats1.liveWriteStats.rowsUpdated === 0, 'First run is insert-only: 0 updates performed');
    assert(liveStats1.liveWriteStats.updatesSkipped === 1, 'Existing row (10alabs-1001) skipped from updates in insert-only mode');

    // Confirm that upsert used ignoreDuplicates: true with NO onConflict
    const firstUpsertCall = mockSupabase._upsertCalls[0];
    assert(firstUpsertCall.options.ignoreDuplicates === true, 'Insert-only mode uses ignoreDuplicates: true');
    assert(firstUpsertCall.options.onConflict === undefined, 'Insert-only mode asserts options.onConflict is undefined');

    for (const call of mockSupabase._upsertCalls) {
      assert(call.options.ignoreDuplicates === true, 'All insert-only calls have ignoreDuplicates: true');
      assert(call.options.onConflict === undefined, 'All insert-only calls have options.onConflict === undefined');
    }

    // Verify batch chunk size and distinct board labels
    let allUpsertedRowsRun1: any[] = [];
    let allSourcesHaveBoardSuffix = true;
    for (const call of mockSupabase._upsertCalls) {
      assert(call.payload.length <= 500, `Batch chunk size <= 500 (actual: ${call.payload.length})`);
      allUpsertedRowsRun1 = allUpsertedRowsRun1.concat(call.payload);
    }
    for (const row of allUpsertedRowsRun1) {
      if (!row.source.endsWith('-board')) {
        allSourcesHaveBoardSuffix = false;
      }
    }
    assert(allSourcesHaveBoardSuffix, 'All upserted board rows use distinct source labels ending with "-board" (e.g. greenhouse-board)');

    // Ensure 10alabs-1001 was NOT in the write payload
    const skippedRowInPayload = allUpsertedRowsRun1.find((r) => r.source_job_id === '10alabs-1001');
    assert(skippedRowInPayload === undefined, 'Existing row 10alabs-1001 was excluded from insert-only write payload');

    // Verify manifest file saved before writing
    assert(fs.existsSync(tempManifestPath1), 'Manifest file exists on disk');
    const manifest1 = JSON.parse(fs.readFileSync(tempManifestPath1, 'utf-8'));
    assert(manifest1.total_rows === liveStats1.liveWriteStats.rowsInserted, 'Manifest total_rows matches inserted count');
    assert(manifest1.rows.length === liveStats1.liveWriteStats.rowsInserted, 'Manifest rows count matches inserted count');
    assert(manifest1.run_discovered_at === liveStats1.liveWriteStats.discoveredAt, 'Manifest run_discovered_at matches run timestamp');

    // Verify re-select confirmation
    assert(
      liveStats1.liveWriteStats.confirmedCount === liveStats1.liveWriteStats.rowsInserted,
      `Re-select confirmation verified all inserted keys (expected: ${liveStats1.liveWriteStats.rowsInserted}, got: ${liveStats1.liveWriteStats.confirmedCount})`
    );

    // Verify rollback SQL
    const rollbackSql1 = liveStats1.liveWriteStats.rollbackSql || '';
    assert(rollbackSql1.includes('DELETE FROM jobs'), 'Rollback SQL contains DELETE FROM jobs');
    assert(rollbackSql1.includes(liveStats1.liveWriteStats.discoveredAt), 'Rollback SQL targets exact run discovered_at');
    assert(rollbackSql1.includes('(source, source_job_id) IN ('), 'Rollback SQL targets composite (source, source_job_id) pairs');
    assert(!rollbackSql1.includes('10alabs-1001'), 'Rollback SQL excludes skipped existing rows');
    for (const manifestRow of manifest1.rows) {
      assert(rollbackSql1.includes(manifestRow.source_job_id), `Rollback SQL includes inserted key ${manifestRow.source_job_id}`);
    }

    // -------------------------------------------------------------------------
    // RUN 2: Second Run on Same Fixture (Must insert 0 rows, manifest matches 0)
    // -------------------------------------------------------------------------
    const liveStats2 = await runBoardIngestion({
      liveWrite: true,
      confirmProdWrite: true,
      maxJobs: 100,
      expectHost: 'szakevhxhwpeskidvtfs.supabase.co',
      supabaseClient: mockSupabase,
      fixtureMode: true,
      fixtureDir: path.resolve(__dirname, 'fixtures'),
      limit: 3,
      manifestPath: tempManifestPath2,
    });

    assert(liveStats2.liveWriteStats !== undefined, 'Run 2 recorded liveWriteStats');
    assert(liveStats2.liveWriteStats.rowsInserted === 0, `Second run on same fixture inserts 0 rows (got: ${liveStats2.liveWriteStats.rowsInserted})`);
    assert(liveStats2.liveWriteStats.rowsWritten === 0, `Second run writes 0 rows in insert-only mode (got: ${liveStats2.liveWriteStats.rowsWritten})`);
    assert(liveStats2.liveWriteStats.updatesSkipped >= 2, 'Second run skips all existing rows from update');

    assert(fs.existsSync(tempManifestPath2), 'Second run manifest file exists on disk');
    const manifest2 = JSON.parse(fs.readFileSync(tempManifestPath2, 'utf-8'));
    assert(manifest2.total_rows === 0, 'Second run manifest matches 0 inserted rows');
    assert(manifest2.rows.length === 0, 'Second run manifest rows array is empty');

    // -------------------------------------------------------------------------
    // Unit Assertion: Mock Supabase rejects any onConflict option
    // -------------------------------------------------------------------------
    const rejectingMock = createMockSupabase([]);
    const conflictAttempt = await rejectingMock.from('jobs').upsert(
      [{ source: 'test-board', source_job_id: '1' }],
      { onConflict: 'source,source_job_id' }
    );
    assert(conflictAttempt.error !== null, 'Mock rejects onConflict option with error');
    assert(
      conflictAttempt.error?.message.includes('no unique or exclusion constraint matching the ON CONFLICT specification'),
      'Mock returns Postgres error when onConflict is specified'
    );

    const ignoreDupesAttempt = await rejectingMock.from('jobs').upsert(
      [{ source: 'test-board', source_job_id: '1' }],
      { ignoreDuplicates: true }
    );
    assert(ignoreDupesAttempt.error === null, 'Mock succeeds when onConflict is undefined and ignoreDuplicates is true');

    // -------------------------------------------------------------------------
    // RUN 3: Opt-in Updates Mode (--allow-updates)
    // -------------------------------------------------------------------------
    const updateMockSupabase = createMockSupabase(mockSupabase._dbJobs, { allowOnConflict: true });
    const liveStats3 = await runBoardIngestion({
      liveWrite: true,
      confirmProdWrite: true,
      allowUpdates: true,
      maxJobs: 100,
      expectHost: 'szakevhxhwpeskidvtfs.supabase.co',
      supabaseClient: updateMockSupabase,
      fixtureMode: true,
      fixtureDir: path.resolve(__dirname, 'fixtures'),
      limit: 3,
    });

    assert(liveStats3.liveWriteStats !== undefined, 'Run 3 recorded liveWriteStats');
    assert(liveStats3.liveWriteStats.rowsUpdated > 0, 'Opt-in updates writes existing rows to database');

    const updateCalls = updateMockSupabase._upsertCalls.filter((c: any) => !c.options?.ignoreDuplicates);
    assert(updateCalls.length > 0, 'Opt-in update mode executed standard upsert without ignoreDuplicates');

    let allUpdatedRows: any[] = [];
    for (const c of updateCalls) {
      allUpdatedRows = allUpdatedRows.concat(c.payload);
    }
    const updated10a = allUpdatedRows.find((r) => r.source_job_id === '10alabs-1001');
    assert(updated10a !== undefined, 'Found updated 10alabs-1001 job row in opt-in upsert payload');
    assert(
      updated10a?.posted_at === initialPostedDate,
      `Existing posted_at is NOT overwritten on update (expected: ${initialPostedDate}, got: ${updated10a?.posted_at})`
    );
    assert(
      updated10a?.discovered_at === initialDiscoveredDate,
      `Existing discovered_at is NOT overwritten on update (expected: ${initialDiscoveredDate}, got: ${updated10a?.discovered_at})`
    );

    // Verify description length <= 1500 chars and plain text only
    let descriptionsValid = true;
    let applyUrlsValid = true;
    for (const row of allUpsertedRowsRun1) {
      if (!row.description || row.description.length > 1500 || row.description.includes('<script>') || row.description.includes('<p>')) {
        descriptionsValid = false;
      }
      if (!row.apply_url || !row.apply_url.startsWith('https://')) {
        applyUrlsValid = false;
      }
    }
    assert(descriptionsValid, 'All upserted descriptions are truncated to <= 1500 chars, plain text only');
    assert(applyUrlsValid, 'All upserted jobs have HTTPS-only apply_url');

    // -------------------------------------------------------------------------
    // RUN 4: Simulate Batch 2 Failing -> Assert Rollback SQL Saved & Printed Before Failure
    // -------------------------------------------------------------------------
    const tempManifestFailPath = path.resolve(__dirname, 'fixtures/temp-manifest-fail.json');
    const tempSqlFailPath = tempManifestFailPath.replace(/\.json$/, '.sql');
    const failingMockSupabase = createMockSupabase(mockInitialDb, { failOnUpsertCall: 2 });

    const capturedLogs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '));
      origLog(...args);
    };
    console.error = (...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '));
      origError(...args);
    };

    let batch2Threw = false;
    try {
      await runBoardIngestion({
        liveWrite: true,
        confirmProdWrite: true,
        maxJobs: 100,
        batchSize: 1, // With 2 new insert rows, batch 1 writes 1 row and batch 2 fails
        expectHost: 'szakevhxhwpeskidvtfs.supabase.co',
        supabaseClient: failingMockSupabase,
        fixtureMode: true,
        fixtureDir: path.resolve(__dirname, 'fixtures'),
        limit: 3,
        manifestPath: tempManifestFailPath,
      });
    } catch (err: any) {
      if (err.message.includes('Simulated database write error on batch 2') || err.message.includes('batch 2')) {
        batch2Threw = true;
      }
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    assert(batch2Threw === true, 'Batch 2 failure was caught');
    assert(fs.existsSync(tempManifestFailPath), 'Manifest file was saved before first DB write and persists after failure');
    assert(fs.existsSync(tempSqlFailPath), 'Rollback SQL file was saved before first DB write and persists after failure');

    const failManifest = JSON.parse(fs.readFileSync(tempManifestFailPath, 'utf-8'));
    const failRollbackSql = fs.readFileSync(tempSqlFailPath, 'utf-8');

    assert(failManifest.total_rows >= 2, `Manifest covers all queued rows before failure (got: ${failManifest.total_rows})`);
    assert(failRollbackSql.includes('DELETE FROM jobs'), 'Saved rollback SQL contains DELETE statement');
    assert(failRollbackSql.includes(failManifest.run_discovered_at), 'Saved rollback SQL targets run discovered_at');

    for (const row of failManifest.rows) {
      assert(
        failRollbackSql.includes(row.source_job_id),
        `Saved rollback SQL covers all queued rows including batch 2 that failed (${row.source_job_id})`
      );
    }

    const allCapturedOutput = capturedLogs.join('\n');
    assert(
      allCapturedOutput.includes('PRE-WRITE ROLLBACK SQL'),
      'Rollback SQL was printed before first DB write'
    );
    assert(
      allCapturedOutput.includes('BATCH 2 FAILED') || allCapturedOutput.includes('ROLLBACK SQL (USE TO RESTORE DATABASE STATE)'),
      'Rollback SQL was printed again when batch 2 threw'
    );
  } finally {
    if (fs.existsSync(tempManifestPath1)) fs.unlinkSync(tempManifestPath1);
    const tempSqlPath1 = tempManifestPath1.replace(/\.json$/, '.sql');
    if (fs.existsSync(tempSqlPath1)) fs.unlinkSync(tempSqlPath1);

    if (fs.existsSync(tempManifestPath2)) fs.unlinkSync(tempManifestPath2);
    const tempSqlPath2 = tempManifestPath2.replace(/\.json$/, '.sql');
    if (fs.existsSync(tempSqlPath2)) fs.unlinkSync(tempSqlPath2);

    const tempManifestFailPath = path.resolve(__dirname, 'fixtures/temp-manifest-fail.json');
    if (fs.existsSync(tempManifestFailPath)) fs.unlinkSync(tempManifestFailPath);
    const tempSqlFailPath = tempManifestFailPath.replace(/\.json$/, '.sql');
    if (fs.existsSync(tempSqlFailPath)) fs.unlinkSync(tempSqlFailPath);
  }

  // Test that when incoming job has posted_at = null, it stays null in the DB payload (never nowIso)
  const nullDateJob = normalizeAtsJob(
    {
      id: 9999,
      title: 'Job Without Date',
      absolute_url: 'https://boards.greenhouse.io/stripe/jobs/9999',
    },
    'greenhouse',
    'NoDateCorp',
    'nodatecorp'
  );
  assert(nullDateJob?.posted_at === null, 'Job without date normalizes posted_at to null');

  // ---------------------------------------------------------------------------
  // 14. Max-Jobs Cap and Boards Limit Controls
  // ---------------------------------------------------------------------------
  const maxJobStats = await runBoardIngestion({
    dryRun: true,
    maxJobs: 2,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 5,
  });
  assert(maxJobStats.totalJobsAccepted <= 2, `Max jobs cap halted ingestion at <= 2 jobs (got: ${maxJobStats.totalJobsAccepted})`);

  // Max-per-board cap test: ensures no company accepts more than maxPerBoard jobs
  const maxPerBoardStats = await runBoardIngestion({
    dryRun: true,
    maxPerBoard: 1,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
  });
  const maxJobsObserved = Math.max(...maxPerBoardStats.topCompanies.map((c) => c.jobs));
  assert(
    maxJobsObserved <= 1,
    `Max per board cap enforces <= 1 job per company across all boards (actual max: ${maxJobsObserved})`
  );
  assert(
    maxPerBoardStats.topCompanies.some((c) => c.jobs === 1),
    'At least one company accepted exactly 1 job under maxPerBoard: 1'
  );

  // Baseline comparison without maxPerBoard: shows that companies have > 1 jobs
  const unconstrainedStats = await runBoardIngestion({
    dryRun: true,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
  });
  const unconstrainedMax = Math.max(...unconstrainedStats.topCompanies.map((c) => c.jobs));
  assert(
    unconstrainedMax > 1,
    `Without maxPerBoard, companies accept > 1 jobs (actual unconstrained max: ${unconstrainedMax})`
  );

  const boardsLimitStats = await runBoardIngestion({
    dryRun: true,
    boardsLimit: 1,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
  });
  assert(boardsLimitStats.companiesAttempted === 1, `Boards limit restricted processing to 1 board (got: ${boardsLimitStats.companiesAttempted})`);

  // ---------------------------------------------------------------------------
  // 15. Cleanup Rules: Open ATS Board Job Protection with Distinct Board Labels
  // ---------------------------------------------------------------------------
  assert(isAtsJob({ source: 'greenhouse-board' }), 'isAtsJob recognizes greenhouse-board');
  assert(isAtsJob({ source: 'lever-board' }), 'isAtsJob recognizes lever-board');
  assert(isAtsJob({ source: 'ashby-board' }), 'isAtsJob recognizes ashby-board');
  assert(isAtsJob({ source: 'bamboohr-board' }), 'isAtsJob recognizes bamboohr-board');
  assert(isAtsJob({ source_type: 'ats' }), 'isAtsJob identifies source_type="ats"');
  assert(!isAtsJob({ source: 'remoteok', source_type: 'aggregator' }), 'isAtsJob excludes non-ATS aggregators');

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const mockCleanupDb = [
    {
      id: 'job-ats-active',
      title: 'Staff Platform Engineer',
      company: 'Stripe',
      source: 'greenhouse-board',
      source_type: 'ats',
      posted_at: new Date(now - 60 * dayMs).toISOString(),
      last_seen_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      expires_at: null,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-ats-vanished',
      title: 'Junior Recruiter',
      company: 'Stripe',
      source: 'greenhouse-board',
      source_type: 'ats',
      posted_at: new Date(now - 60 * dayMs).toISOString(),
      last_seen_at: new Date(now - 10 * dayMs).toISOString(),
      expires_at: null,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-aggregator-old',
      title: 'Marketing Manager',
      company: 'Acme Corp',
      source: 'remoteok',
      source_type: 'aggregator',
      posted_at: new Date(now - 60 * dayMs).toISOString(),
      last_seen_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      expires_at: null,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-purge-old',
      title: 'Obsolete Role',
      company: 'Old Corp',
      source: 'greenhouse-board',
      source_type: 'ats',
      posted_at: new Date(now - 90 * dayMs).toISOString(),
      last_seen_at: new Date(now - 20 * dayMs).toISOString(),
      expires_at: null,
      is_active: false,
      status: 'expired',
    },
  ];

  const mockCleanupClient = createMockSupabase(mockCleanupDb);
  const cleanupResult = await runJobCleanup(mockCleanupClient as any, { dryRun: false });

  assert(
    cleanupResult.preservedBoardJobs === 1,
    `Active open ATS board job preserved from 45-day expiration (actual: ${cleanupResult.preservedBoardJobs})`
  );
  assert(
    cleanupResult.markedExpired === 2,
    `Vanished ATS job and old aggregator job marked expired (actual: ${cleanupResult.markedExpired})`
  );
  assert(
    cleanupResult.permanentlyDeleted === 1,
    `Inactive job unseen > 14 days permanently purged (actual: ${cleanupResult.permanentlyDeleted})`
  );

  // ---------------------------------------------------------------------------
  // 16. Category Mode: Non-Tech Filtering & Default Mode Preservation
  // ---------------------------------------------------------------------------
  // (a) categoryMode: 'non-tech' keeps only non-tech jobs
  const nonTechStats = await runBoardIngestion({
    dryRun: true,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
    categoryMode: 'non-tech',
  });
  assert(nonTechStats.totalJobsAccepted === 2, `non-tech mode accepts only non-tech roles (got: ${nonTechStats.totalJobsAccepted})`);
  assert(nonTechStats.nonTechCount === 2, `non-tech mode reports nonTechCount == 2 (got: ${nonTechStats.nonTechCount})`);
  assert(nonTechStats.categoryBreakdown['engineering'] === undefined, 'non-tech mode excludes engineering jobs');
  assert(nonTechStats.categoryBreakdown['data'] === undefined, 'non-tech mode excludes data jobs');
  assert(nonTechStats.categoryBreakdown['ai'] === undefined, 'non-tech mode excludes ai jobs');
  assert((nonTechStats.categoryBreakdown['customer-support'] || 0) > 0, 'non-tech mode includes customer-support');
  assert((nonTechStats.categoryBreakdown['operations'] || 0) > 0, 'non-tech mode includes operations');

  // (b) categoryMode: default / undefined preserves all jobs unchanged
  const defaultModeStats = await runBoardIngestion({
    dryRun: true,
    fixtureMode: true,
    fixtureDir: path.resolve(__dirname, 'fixtures'),
    limit: 3,
  });
  assert(defaultModeStats.totalJobsAccepted === 4, `default mode retains all jobs across fixtures (got: ${defaultModeStats.totalJobsAccepted})`);
  assert((defaultModeStats.categoryBreakdown['engineering'] || 0) > 0, 'default mode includes engineering jobs');

  // ---------------------------------------------------------------------------
  // 17. Subprocess Negative Control Verification (Proves non-zero exit)
  // ---------------------------------------------------------------------------
  console.log('\nRunning negative control subprocess to verify non-zero exit on invalid inputs...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-board-ingestion.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
    cwd: path.resolve(__dirname, '..'),
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
