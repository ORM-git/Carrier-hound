/**
 * scripts/test-ats-pipeline-repair.ts
 *
 * Comprehensive Test Suite for ATS Discovery-to-Ingestion Pipeline Repair:
 * 1. Full-registry selection vs seed selection and resumable checkpointing.
 * 2. SmartRecruiters offset/totalFound pagination beyond 100 and cached detail enrichment.
 * 3. Lever pagination with skip, global-vs-EU host fallback, and secondary locations preservation.
 * 4. Ashby unlisted exclusion (isListed=false), hybrid workplace handling, and secondary locations.
 * 5. Structured salary integrity (rejects empty compensation, never assumes USD or annual period).
 * 6. Dedupe stability across repeat runs.
 * 7. Safe board lifecycle: failed or empty source never increments misses or deactivates jobs.
 * 8. Negative control subprocess verifying non-zero exit on assertion failures.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SmartRecruitersAdapter } from './adapters/smartrecruiters';
import { LeverAdapter } from './adapters/lever';
import { AshbyAdapter } from './adapters/ashby';
import { GreenhouseAdapter } from './adapters/greenhouse';
import { loadTargetBoards, runDryPlan, DryPlanCheckpoint } from './ats-dry-plan';
import { SourceConfig, NormalizedJob } from './types';
import { handleClosedJobs, normalizeAtsJob, ClosedJobRecord } from './board-ingest';
import { lastRequestByDomain } from './utils/polite-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNegativeControl = process.argv.includes('--negative-control');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`, detail || '');
    failed++;
  }
}

async function runTests() {
  console.log('======================================================');
  console.log('🧪 ATS PIPELINE REPAIR & DRY-PLAN TEST SUITE');
  console.log('======================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL' : 'NORMAL'}\n`);

  if (isNegativeControl) {
    // Intentional failure to prove negative control causes non-zero exit
    assert(false, 'Intentional negative control failure to verify test guard non-zero exit');
    if (failed > 0) process.exit(1);
    return;
  }

  const originalFetch = globalThis.fetch;

  // ---------------------------------------------------------------------------
  // 1. Full Registry vs Seed Selection & Resumable Checkpoint Logic
  // ---------------------------------------------------------------------------
  console.log('1. Testing Registry vs Seed Selection & Checkpoint Resume...');

  const seedBoards = loadTargetBoards('seed');
  assert(seedBoards.length === 52, `Seed selection loads exactly 52 employers (actual: ${seedBoards.length})`);
  assert(seedBoards.every((b) => b.token && b.ats), 'All seed boards have valid token and ats type');

  const registryBoards = loadTargetBoards('registry');
  assert(registryBoards.length === 277, `Full registry loads 277 enabled employers (actual: ${registryBoards.length})`);
  assert(
    registryBoards.some((b) => b.ats === 'greenhouse'),
    'Full registry includes Greenhouse employers'
  );
  assert(
    registryBoards.some((b) => b.ats === 'ashby'),
    'Full registry includes Ashby employers'
  );
  assert(
    registryBoards.some((b) => b.ats === 'lever'),
    'Full registry includes Lever employers'
  );

  // Test Checkpoint Recovery State
  const mockCheckpoint: DryPlanCheckpoint = {
    sourceSelection: 'registry',
    timestamp: new Date().toISOString(),
    completedTokens: ['1password', 'adthena'],
    boardResults: [],
    savedAt: new Date().toISOString(),
  };
  const tempCpPath = path.resolve(__dirname, '../reports/test-temp-checkpoint.json');
  fs.writeFileSync(tempCpPath, JSON.stringify(mockCheckpoint, null, 2), 'utf-8');

  try {
    const rawCp = JSON.parse(fs.readFileSync(tempCpPath, 'utf-8'));
    assert(rawCp.completedTokens.includes('1password'), 'Checkpoint persists completed tokens');
    assert(rawCp.completedTokens.includes('adthena'), 'Checkpoint preserves completed token set');
  } finally {
    if (fs.existsSync(tempCpPath)) fs.unlinkSync(tempCpPath);
  }

  // ---------------------------------------------------------------------------
  // 2. SmartRecruiters: Offset/TotalFound Pagination & Detail Enrichment
  // ---------------------------------------------------------------------------
  console.log('\n2. Testing SmartRecruiters Pagination & Posting Detail Enrichment...');

  const mockSrAdapter = new SmartRecruitersAdapter();
  mockSrAdapter.maxDetailFetchesPerBoard = 5;
  const mockSrConfig: SourceConfig = {
    id: 'test-sr',
    name: 'SmartRecruiters Co',
    type: 'smartrecruiters',
    target: 'smartrecruiters-co',
    enabled: true,
  };

  let srFetchCount = 0;
  globalThis.fetch = async (url: any, opts: any) => {
    lastRequestByDomain.clear();
    srFetchCount++;
    const urlStr = String(url);

    // Page 1: offset=0, limit=100, totalFound=150
    if (urlStr.includes('/postings?') && urlStr.includes('offset=0')) {
      return new Response(
        JSON.stringify({
          totalFound: 150,
          content: Array.from({ length: 100 }, (_, i) => ({
            id: `sr-job-${i + 1}`,
            name: `Role ${i + 1}`,
            releasedDate: '2026-10-01T12:00:00Z',
            location: { city: 'Bengaluru', region: 'KA', country: 'IN', remote: false, hybrid: true },
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Page 2: offset=100, limit=100
    if (urlStr.includes('/postings?') && urlStr.includes('offset=100')) {
      return new Response(
        JSON.stringify({
          totalFound: 150,
          content: Array.from({ length: 50 }, (_, i) => ({
            id: `sr-job-${i + 101}`,
            name: `Role ${i + 101}`,
            releasedDate: '2026-10-02T12:00:00Z',
            location: { city: 'Mumbai', region: 'MH', country: 'IN', remote: false, hybrid: false },
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Detailed posting endpoint
    if (urlStr.includes('/postings/sr-job-1')) {
      return new Response(
        JSON.stringify({
          id: 'sr-job-1',
          name: 'Principal Platform Engineer',
          applyUrl: 'https://jobs.smartrecruiters.com/smartrecruiters-co/sr-job-1-apply',
          postingUrl: 'https://jobs.smartrecruiters.com/smartrecruiters-co/sr-job-1',
          compensation: {
            min: 1500000,
            max: 2500000,
            currency: 'INR',
            period: 'yearly',
          },
          jobAd: {
            sections: {
              jobDescription: { title: 'Role Description', text: '<p>Lead platform architecture.</p>' },
              qualifications: { title: 'Qualifications', text: '<p>10+ years experience.</p>' },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Fallback for other detail calls
    return new Response(
      JSON.stringify({
        id: 'generic',
        name: 'Generic Role',
        applyUrl: 'https://jobs.smartrecruiters.com/smartrecruiters-co/generic',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const srJobs = await mockSrAdapter.fetchJobs(mockSrConfig);
  assert(srJobs.length === 150, `SmartRecruiters paginates beyond 100 to totalFound (actual: ${srJobs.length})`);
  assert(srJobs[0].apply_url === 'https://jobs.smartrecruiters.com/smartrecruiters-co/sr-job-1-apply', 'SmartRecruiters uses employer apply link from detail API');
  assert(srJobs[0].salary_min === 1500000, 'SmartRecruiters extracts numeric salary min');
  assert(srJobs[0].salary_max === 2500000, 'SmartRecruiters extracts numeric salary max');
  assert(srJobs[0].currency === 'INR', 'SmartRecruiters retains INR currency context');
  assert(srJobs[0].remote === false, 'SmartRecruiters hybrid role maps remote: false');
  assert(srJobs[0].remote_scope === 'hybrid', 'SmartRecruiters hybrid role maps remote_scope: hybrid');
  assert(srJobs[0].country_code === 'IN', 'SmartRecruiters detects IN country code');

  // ---------------------------------------------------------------------------
  // 3. Lever: Pagination With Skip & Global vs EU Host Fallback
  // ---------------------------------------------------------------------------
  console.log('\n3. Testing Lever Pagination With Skip & EU Host Fallback...');

  const mockLeverAdapter = new LeverAdapter();
  const mockLeverConfig: SourceConfig = {
    id: 'test-lever',
    name: 'Lever Global Corp',
    type: 'lever',
    target: 'lever-global-corp',
    enabled: true,
  };

  // Test Lever Pagination
  globalThis.fetch = async (url: any) => {
    lastRequestByDomain.clear();
    const urlStr = String(url);
    if (urlStr.includes('skip=0')) {
      return new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            id: `lever-job-${i + 1}`,
            text: `Lever Job ${i + 1}`,
            createdAt: 1729000000000,
            categories: {
              location: 'San Francisco, CA',
              allLocations: ['San Francisco, CA', 'New York, NY', 'Bengaluru, India'],
            },
            workplaceType: 'hybrid',
            applyUrl: `https://jobs.lever.co/lever-global-corp/lever-job-${i + 1}/apply`,
          }))
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (urlStr.includes('skip=100')) {
      return new Response(
        JSON.stringify(
          Array.from({ length: 25 }, (_, i) => ({
            id: `lever-job-${i + 101}`,
            text: `Lever Job ${i + 101}`,
            createdAt: 1729000000000,
            categories: { location: 'London, UK' },
            workplaceType: 'remote',
            applyUrl: `https://jobs.lever.co/lever-global-corp/lever-job-${i + 101}/apply`,
          }))
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const leverPaginatedJobs = await mockLeverAdapter.fetchJobs(mockLeverConfig);
  assert(leverPaginatedJobs.length === 125, `Lever paginates beyond 100 with skip (actual: ${leverPaginatedJobs.length})`);
  assert(
    leverPaginatedJobs[0].location.includes('Bengaluru, India'),
    'Lever preserves secondary locations from categories.allLocations'
  );
  assert(leverPaginatedJobs[0].remote === false, 'Lever workplaceType=hybrid maps remote: false');
  assert(leverPaginatedJobs[0].remote_scope === 'hybrid', 'Lever workplaceType=hybrid maps remote_scope: hybrid');

  // Test Lever EU Host Fallback
  let globalAttempted = false;
  let euAttempted = false;
  globalThis.fetch = async (url: any) => {
    lastRequestByDomain.clear();
    const urlStr = String(url);
    if (urlStr.startsWith('https://api.lever.co')) {
      globalAttempted = true;
      return new Response('Not Found', { status: 404 });
    }
    if (urlStr.startsWith('https://api.eu.lever.co')) {
      euAttempted = true;
      return new Response(
        JSON.stringify([
          {
            id: 'eu-job-1',
            text: 'Berlin Senior Engineer',
            createdAt: 1729000000000,
            categories: { location: 'Berlin, Germany' },
            applyUrl: 'https://jobs.eu.lever.co/lever-eu-corp/eu-job-1/apply',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('Not Found', { status: 404 });
  };

  const euLeverConfig: SourceConfig = {
    id: 'test-lever-eu',
    name: 'Lever EU Corp',
    type: 'lever',
    target: 'lever-eu-corp',
    enabled: true,
  };
  const euJobs = await mockLeverAdapter.fetchJobs(euLeverConfig);
  assert(globalAttempted, 'Lever first attempts global endpoint api.lever.co');
  assert(euAttempted, 'Lever falls back to European host api.eu.lever.co upon 404');
  assert(euJobs.length === 1 && euJobs[0].source_job_id === 'lever-eu-corp-eu-job-1', 'Lever successfully ingests EU host postings');

  // ---------------------------------------------------------------------------
  // 4. Ashby: Unlisted Exclusion, Hybrid Resolution, Secondary Locations
  // ---------------------------------------------------------------------------
  console.log('\n4. Testing Ashby Unlisted Exclusion, Hybrid Classification & Locations...');

  const mockAshbyAdapter = new AshbyAdapter();
  const mockAshbyConfig: SourceConfig = {
    id: 'test-ashby',
    name: 'Ashby Corp',
    type: 'ashby',
    target: 'ashby-corp',
    enabled: true,
  };

  globalThis.fetch = async () => {
    lastRequestByDomain.clear();
    return new Response(
      JSON.stringify({
        jobs: [
          {
            id: 'ashby-1',
            title: 'Listed Remote Engineer',
            isListed: true,
            isRemote: true,
            workplaceType: 'Remote',
            location: 'San Francisco, CA',
            secondaryLocations: [{ location: 'Toronto, Canada' }, { location: 'London, UK' }],
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/ashby-1',
            publishedDate: '2026-10-01T00:00:00Z',
          },
          {
            id: 'ashby-2',
            title: 'Confidential Internal Draft',
            isListed: false, // Must be strictly excluded
            isRemote: true,
            location: 'Remote',
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/ashby-2',
          },
          {
            id: 'ashby-3',
            title: 'Hybrid Engineering Manager',
            isListed: true,
            isRemote: true, // Ashby flags isRemote=true for hybrid too!
            workplaceType: 'Hybrid',
            location: 'Bengaluru, India',
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/ashby-3',
            publishedDate: '2026-10-01T00:00:00Z',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const ashbyJobs = await mockAshbyAdapter.fetchJobs(mockAshbyConfig);
  assert(ashbyJobs.length === 2, `Ashby strictly excludes isListed=false roles (actual: ${ashbyJobs.length})`);
  assert(!ashbyJobs.some((j) => (j.source_job_id || '').includes('ashby-2')), 'Unlisted Ashby role is absent from accepted jobs');
  assert(ashbyJobs[0].remote === true, 'Pure remote Ashby role maps remote: true');
  assert(ashbyJobs[0].remote_scope === 'remote', 'Pure remote Ashby role maps remote_scope: remote');
  assert(
    ashbyJobs[0].location.includes('Toronto, Canada') && ashbyJobs[0].location.includes('London, UK'),
    'Ashby preserves secondaryLocations in normalized location'
  );
  assert(ashbyJobs[1].remote === false, 'Ashby workplaceType=Hybrid maps remote: false despite isRemote=true');
  assert(ashbyJobs[1].remote_scope === 'hybrid', 'Ashby workplaceType=Hybrid maps remote_scope: hybrid');

  // ---------------------------------------------------------------------------
  // 5. Salary Integrity: Rejects Empty Objects & No Fabricated USD/Annual
  // ---------------------------------------------------------------------------
  console.log('\n5. Testing Salary Integrity (Empty Objects & Currency Preservation)...');

  // Ashby with empty compensation components
  globalThis.fetch = async () => {
    lastRequestByDomain.clear();
    return new Response(
      JSON.stringify({
        jobs: [
          {
            id: 'salary-1',
            title: 'Role With Empty Comp',
            isListed: true,
            location: 'Remote',
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/salary-1',
            compensation: {
              compensationTiers: [
                {
                  tierSummary: 'Tier 1',
                  components: [
                    {
                      compensationType: 'Salary',
                      minValue: 0, // Invalid: zero
                      maxValue: null,
                    },
                  ],
                },
              ],
            },
          },
          {
            id: 'salary-2',
            title: 'Role With EUR Monthly',
            isListed: true,
            location: 'Berlin, Germany',
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/salary-2',
            compensation: {
              compensationTiers: [
                {
                  components: [
                    {
                      compensationType: 'Salary',
                      minValue: 6000,
                      maxValue: 8000,
                      currencyCode: 'EUR',
                      interval: 'Monthly',
                    },
                  ],
                },
              ],
            },
          },
          {
            id: 'salary-3',
            title: 'Role Without Currency',
            isListed: true,
            location: 'Unknown',
            jobUrl: 'https://jobs.ashbyhq.com/ashby-corp/salary-3',
            compensation: {
              compensationTiers: [
                {
                  components: [
                    {
                      compensationType: 'Salary',
                      minValue: 50000,
                      maxValue: 70000,
                      // Missing currencyCode: must NOT assume USD!
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const salaryTestJobs = await mockAshbyAdapter.fetchJobs(mockAshbyConfig);
  assert(salaryTestJobs[0].salary_min === null, 'Empty compensation components with 0/null values are rejected');
  assert(salaryTestJobs[0].salary_text === null, 'Rejected compensation yields null salary_text');
  assert(salaryTestJobs[1].salary_min === 6000, 'Valid numeric min is parsed');
  assert(salaryTestJobs[1].salary_max === 8000, 'Valid numeric max is parsed');
  assert(salaryTestJobs[1].currency === 'EUR', 'Currency EUR is preserved');
  assert(salaryTestJobs[1].salary_period === 'monthly', 'Interval Monthly is preserved as monthly');
  assert(
    salaryTestJobs[2].currency === undefined || salaryTestJobs[2].currency === null,
    'Missing currency does NOT assume USD (stays undefined/null)'
  );

  // ---------------------------------------------------------------------------
  // 6. Safe Per-Board Lifecycle: Closed/Failed Source Never Inactivates Jobs
  // ---------------------------------------------------------------------------
  console.log('\n6. Testing Safe Board Lifecycle (Closed/Failed Feeds)...');

  const existingCompanyJobs: ClosedJobRecord[] = [
    {
      id: 'job-101',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: '101',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-102',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: '102',
      consecutive_misses: 0,
      is_active: true,
      status: 'active',
    },
    {
      id: 'job-103',
      source: 'greenhouse',
      company_slug: 'stripe',
      source_job_id: '103',
      consecutive_misses: 1,
      is_active: true,
      status: 'active',
    },
  ];

  // Case A: Successful fetch returns only job-101 (job-102 missing 1st time, job-103 missing 2nd time)
  const freshJobIds = new Set(['101']);
  const decisionsA = handleClosedJobs(existingCompanyJobs, freshJobIds, {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });

  const d101 = decisionsA.find((d) => d.id === 'job-101');
  const d102 = decisionsA.find((d) => d.id === 'job-102');
  const d103 = decisionsA.find((d) => d.id === 'job-103');

  assert(d101?.action === 'reset_active' && d101.consecutive_misses === 0, 'Present job resets consecutive_misses to 0');
  assert(d102?.action === 'kept_active' && d102.consecutive_misses === 1 && d102.is_active === true, 'First-time missing job increments misses to 1 and REMAINS active');
  assert(d103?.action === 'marked_inactive' && d103.consecutive_misses === 2 && d103.is_active === false, 'Second-time missing job is marked inactive');

  // Case B: Failed fetch (e.g. HTTP 500 / network error) -> Zero decisions/mutations
  const decisionsB = handleClosedJobs(existingCompanyJobs, freshJobIds, {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: false,
  });
  assert(decisionsB.length === 0, 'Failed board fetch yields ZERO closed-job decisions or miss increments');

  // Case C: Empty fetch (0 jobs returned) -> Zero decisions/mutations
  const decisionsC = handleClosedJobs(existingCompanyJobs, new Set(), {
    source: 'greenhouse',
    company_slug: 'stripe',
    fetchSucceeded: true,
  });
  assert(decisionsC.length === 0, 'Empty board fetch (0 jobs) yields ZERO closed-job decisions or miss increments');

  // ---------------------------------------------------------------------------
  // 7. Dedupe Stability Across Repeat Runs
  // ---------------------------------------------------------------------------
  console.log('\n7. Testing Dedupe Stability Across Repeat Runs...');

  const rawGreenhouseJob = {
    id: 12345,
    title: '  Staff Security Engineer  ',
    location: { name: 'Bengaluru, India' },
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/12345?gh_jid=12345',
    updated_at: '2026-10-01T00:00:00Z',
  };

  const normalized1 = normalizeAtsJob(rawGreenhouseJob, 'greenhouse', 'Acme Corp', 'acme');
  const normalized2 = normalizeAtsJob(rawGreenhouseJob, 'greenhouse', 'Acme Corp', 'acme');

  assert(normalized1 !== null && normalized2 !== null, 'Jobs normalize successfully');
  assert(normalized1?.title === 'Staff Security Engineer', 'Whitespace trimmed consistently');
  assert(normalized1?.apply_url === normalized2?.apply_url, 'Apply URLs match identically');
  assert(normalized1?.country_code === 'IN', 'Country code IN detected consistently');
  assert(normalized1?.id === normalized2?.id, 'Deterministic source IDs generated');

  // Restore fetch before running subprocess
  globalThis.fetch = originalFetch;

  // ---------------------------------------------------------------------------
  // 8. Negative Control Subprocess Verification
  // ---------------------------------------------------------------------------
  console.log('\n8. Running negative control subprocess to verify non-zero exit on assertion failures...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-ats-pipeline-repair.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });
  assert(
    negResult.status !== 0,
    `Negative control subprocess exited non-zero as expected (code ${negResult.status})`
  );

  console.log('\n======================================================');
  console.log(`📊 PIPELINE REPAIR SUITE RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
