import { GreenhouseAdapter, GreenhouseResponse } from './adapters/greenhouse';
import { AshbyAdapter, AshbyResponse } from './adapters/ashby';
import { LeverAdapter, LeverJob } from './adapters/lever';
import { spawnSync } from 'child_process';

const isNegativeControl = process.argv.includes('--negative-control');

async function run() {
  console.log('================================================================================');
  console.log('         STRUCTURED ATS ADAPTER SALARY EXTRACTION TEST SUITE                    ');
  console.log('================================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  const failures: string[] = [];

  // Intentionally corrupted expected values when in negative-control mode
  const expectedGhMin = isNegativeControl ? 999999 : 120000;
  const expectedAshbyMin = isNegativeControl ? 999999 : 211400;
  const expectedLeverMin = isNegativeControl ? 999999 : 105000;

  // Track URLs requested by adapters
  const requestedUrls: string[] = [];

  // Sample payloads
  const ghSamplePayload: GreenhouseResponse = {
    jobs: [
      {
        id: 'gh-1',
        title: 'Senior Software Engineer',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/1',
        content: '<p>Join our core payments team. Excellent culture and benefits.</p>',
        location: { name: 'San Francisco, CA' },
        updated_at: '2026-10-20T10:00:00Z',
        pay_input_ranges: [
          {
            min_cents: 12000000,
            max_cents: 16000000,
            currency_type: 'USD',
            title: 'Base Pay Range',
            blurb: 'Annual base salary range for US roles.',
          },
        ],
      },
      {
        id: 'gh-2',
        title: 'Customer Operations Specialist',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/2',
        content: '<p>Support our customers 24/7.</p>',
        location: { name: 'Remote - US' },
        updated_at: '2026-10-20T10:00:00Z',
        pay_input_ranges: [
          {
            min_cents: 2040,
            max_cents: 2400,
            currency_type: 'USD',
            title: 'Hourly Pay Rate',
            blurb: 'Hourly wage rate for support roles.',
          },
        ],
      },
      {
        id: 'gh-3',
        title: 'Backend Engineer (Inverted Range)',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/3',
        content: '<p>High scale distributed systems.</p>',
        location: { name: 'Seattle, WA' },
        updated_at: '2026-10-20T10:00:00Z',
        pay_input_ranges: [
          {
            min_cents: 18000000,
            max_cents: 14000000,
            currency_type: 'USD',
          },
        ],
      },
      {
        id: 'gh-4',
        title: 'Product Designer (Regex Fallback)',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/4',
        content: '<p>Base salary is $130,000 - $170,000 per year plus equity.</p>',
        location: { name: 'New York, NY' },
        updated_at: '2026-10-20T10:00:00Z',
        pay_input_ranges: [], // Empty, triggers regex fallback
      },
      {
        id: 'gh-5',
        title: 'Executive Assistant (No Salary)',
        absolute_url: 'https://boards.greenhouse.io/stripe/jobs/5',
        content: '<p>Competitive compensation package commensurate with experience.</p>',
        location: { name: 'Dublin, Ireland' },
        updated_at: '2026-10-20T10:00:00Z',
        pay_input_ranges: null,
      },
    ],
  };

  const ashbySamplePayload: AshbyResponse = {
    jobs: [
      {
        id: 'ashby-1',
        title: 'Staff Infrastructure Engineer',
        jobUrl: 'https://jobs.ashbyhq.com/ramp/ashby-1',
        descriptionPlain: 'Build high scale ledgering infrastructure.',
        location: 'New York, NY',
        publishedAt: '2026-10-21T12:00:00Z',
        compensation: {
          compensationTierSummary: '$211.4K – $290.6K • Offers Equity',
          scrapeableCompensationSalarySummary: '$211.4K - $290.6K',
          compensationTiers: [
            {
              id: 'tier-1',
              tierSummary: '$211.4K – $290.6K • Offers Equity',
              components: [
                {
                  id: 'comp-1',
                  compensationType: 'Salary',
                  interval: '1 YEAR',
                  currencyCode: 'USD',
                  minValue: 211400,
                  maxValue: 290600,
                },
                {
                  id: 'comp-2',
                  compensationType: 'EquityPercentage',
                  interval: 'NONE',
                  minValue: 0.1,
                  maxValue: 0.5,
                },
              ],
            },
          ],
        },
      },
      {
        id: 'ashby-2',
        title: 'Customer Support Lead',
        jobUrl: 'https://jobs.ashbyhq.com/ramp/ashby-2',
        descriptionPlain: 'Guide our customer success team.',
        location: 'Remote',
        publishedAt: '2026-10-21T12:00:00Z',
        compensation: {
          compensationTierSummary: '$45 - $65 /hr',
          compensationTiers: [
            {
              id: 'tier-2',
              components: [
                {
                  id: 'comp-hourly',
                  compensationType: 'Salary',
                  interval: '1 HOUR',
                  currencyCode: 'USD',
                  minValue: 45,
                  maxValue: 65,
                },
              ],
            },
          ],
        },
      },
      {
        id: 'ashby-3',
        title: 'Product Marketing Manager',
        jobUrl: 'https://jobs.ashbyhq.com/ramp/ashby-3',
        descriptionPlain: 'Drive marketing initiatives.',
        location: 'San Francisco, CA',
        publishedAt: '2026-10-21T12:00:00Z',
        compensation: {
          compensationTierSummary: '$150K – $180K • Offers Bonus',
          scrapeableCompensationSalarySummary: '$150K - $180K',
        },
      },
      {
        id: 'ashby-4',
        title: 'Frontend Engineer (Regex Fallback)',
        jobUrl: 'https://jobs.ashbyhq.com/ramp/ashby-4',
        descriptionPlain: 'We offer an annual salary of $140,000 to $175,000 depending on experience.',
        location: 'Remote',
        publishedAt: '2026-10-21T12:00:00Z',
        compensation: undefined,
      },
    ],
  };

  const leverSamplePayload: LeverJob[] = [
    {
      id: 'lever-1',
      text: 'Senior Full Stack Engineer',
      hostedUrl: 'https://jobs.lever.co/logrocket/lever-1',
      descriptionPlain: 'Join LogRocket frontend observability team.',
      createdAt: 1729000000000,
      salaryRange: {
        min: 105000,
        max: 175000,
        currency: 'USD',
        interval: 'per-year-salary',
      },
    },
    {
      id: 'lever-2',
      text: 'Support Engineer',
      hostedUrl: 'https://jobs.lever.co/activecampaign/lever-2',
      descriptionPlain: 'Provide world class developer assistance.',
      createdAt: 1729000000000,
      salaryRange: {
        min: 30.77,
        max: 37.5,
        currency: 'USD',
        interval: 'per-hour-wage',
      },
    },
    {
      id: 'lever-3',
      text: 'Growth Lead (Regex Fallback)',
      hostedUrl: 'https://jobs.lever.co/logrocket/lever-3',
      descriptionPlain: 'Expected compensation is $125,000 - $155,000 per year.',
      createdAt: 1729000000000,
      salaryRange: null,
    },
    {
      id: 'lever-4',
      text: 'Office Manager (No Salary)',
      hostedUrl: 'https://jobs.lever.co/logrocket/lever-4',
      descriptionPlain: 'Manage office operations and events.',
      createdAt: 1729000000000,
      salaryRange: null,
    },
  ];

  // Universal offline fetch mock
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: any) => {
    const urlStr = typeof url === 'string' ? url : url?.toString() || '';
    requestedUrls.push(urlStr);

    if (urlStr.includes('robots.txt')) {
      return {
        ok: true,
        status: 200,
        text: async () => 'User-agent: *\nAllow: /',
      };
    }

    if (urlStr.includes('boards-api.greenhouse.io')) {
      return {
        ok: true,
        status: 200,
        json: async () => ghSamplePayload,
        text: async () => JSON.stringify(ghSamplePayload),
      };
    }

    if (urlStr.includes('api.ashbyhq.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ashbySamplePayload,
        text: async () => JSON.stringify(ashbySamplePayload),
      };
    }

    if (urlStr.includes('api.lever.co')) {
      return {
        ok: true,
        status: 200,
        json: async () => leverSamplePayload,
        text: async () => JSON.stringify(leverSamplePayload),
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    };
  };

  try {
    // -------------------------------------------------------------------------------------------
    // 1. GREENHOUSE ADAPTER TESTS
    // -------------------------------------------------------------------------------------------
    console.log('Testing Greenhouse structured pay_transparency extraction...');
    const ghAdapter = new GreenhouseAdapter();
    const ghSource = { id: 'gh-stripe', name: 'Stripe (Greenhouse)', type: 'greenhouse', target: 'stripe', enabled: true };
    const ghResults = await ghAdapter.fetchJobs(ghSource);

    const ghUrl = requestedUrls.find((u) => u.includes('boards-api.greenhouse.io') && u.includes('/jobs'));
    if (!ghUrl || !ghUrl.includes('pay_transparency=true')) {
      failures.push(`FAIL: GreenhouseAdapter must append pay_transparency=true to endpoint URL. Got: ${ghUrl}`);
    }

    const gh1 = ghResults.find((j) => j.source_job_id === 'stripe-gh-1');
    if (!gh1 || gh1.salary_min !== expectedGhMin || gh1.salary_max !== 160000 || gh1.currency !== 'USD' || gh1.salary_period !== 'yearly') {
      failures.push(`FAIL: Greenhouse Job 1 yearly salary parsed incorrectly: min=${gh1?.salary_min}, max=${gh1?.salary_max}, period=${gh1?.salary_period}`);
    }
    if (!gh1?.salary_text?.includes('$120,000') || !gh1?.salary_text?.includes('$160,000')) {
      failures.push(`FAIL: Greenhouse Job 1 salary_text missing formatted bounds: "${gh1?.salary_text}"`);
    }

    const gh2 = ghResults.find((j) => j.source_job_id === 'stripe-gh-2');
    if (!gh2 || gh2.salary_min !== 20 || gh2.salary_max !== 24 || gh2.salary_period !== 'hourly') {
      failures.push(`FAIL: Greenhouse Job 2 hourly salary parsed incorrectly: min=${gh2?.salary_min}, max=${gh2?.salary_max}, period=${gh2?.salary_period}`);
    }

    const gh3 = ghResults.find((j) => j.source_job_id === 'stripe-gh-3');
    if (!gh3 || gh3.salary_min !== 140000 || gh3.salary_max !== 180000) {
      failures.push(`FAIL: Greenhouse Job 3 inverted bounds not swapped: min=${gh3?.salary_min}, max=${gh3?.salary_max}`);
    }

    const gh4 = ghResults.find((j) => j.source_job_id === 'stripe-gh-4');
    if (!gh4 || gh4.salary_min !== 130000 || gh4.salary_max !== 170000) {
      failures.push(`FAIL: Greenhouse Job 4 description regex fallback failed: min=${gh4?.salary_min}, max=${gh4?.salary_max}`);
    }

    const gh5 = ghResults.find((j) => j.source_job_id === 'stripe-gh-5');
    if (!gh5 || gh5.salary_min !== null || gh5.salary_max !== null || gh5.salary_text !== null) {
      failures.push(`FAIL: Greenhouse Job 5 with no salary should yield null: min=${gh5?.salary_min}, text=${gh5?.salary_text}`);
    }
    console.log('  ✓ Greenhouse structured pay_transparency validated successfully.');

    // -------------------------------------------------------------------------------------------
    // 2. ASHBY ADAPTER TESTS
    // -------------------------------------------------------------------------------------------
    console.log('Testing Ashby structured includeCompensation extraction...');
    const ashbyAdapter = new AshbyAdapter();
    const ashbySource = { id: 'ashby-ramp', name: 'Ramp (Ashby)', type: 'ashby', target: 'ramp', enabled: true };
    const ashbyResults = await ashbyAdapter.fetchJobs(ashbySource);

    const ashbyUrl = requestedUrls.find((u) => u.includes('api.ashbyhq.com') && u.includes('job-board'));
    if (!ashbyUrl || !ashbyUrl.includes('includeCompensation=true')) {
      failures.push(`FAIL: AshbyAdapter must include includeCompensation=true in request URL. Got: ${ashbyUrl}`);
    }

    const ash1 = ashbyResults.find((j) => j.source_job_id === 'ramp-ashby-1');
    if (!ash1 || ash1.salary_min !== expectedAshbyMin || ash1.salary_max !== 290600 || ash1.salary_period !== 'yearly') {
      failures.push(`FAIL: Ashby Job 1 structured salary parsed incorrectly: min=${ash1?.salary_min}, max=${ash1?.salary_max}, period=${ash1?.salary_period}`);
    }

    const ash2 = ashbyResults.find((j) => j.source_job_id === 'ramp-ashby-2');
    if (!ash2 || ash2.salary_min !== 45 || ash2.salary_max !== 65 || ash2.salary_period !== 'hourly') {
      failures.push(`FAIL: Ashby Job 2 hourly salary parsed incorrectly: min=${ash2?.salary_min}, max=${ash2?.salary_max}, period=${ash2?.salary_period}`);
    }

    const ash3 = ashbyResults.find((j) => j.source_job_id === 'ramp-ashby-3');
    if (!ash3 || ash3.salary_min !== 150000 || ash3.salary_max !== 180000) {
      failures.push(`FAIL: Ashby Job 3 tier summary string fallback failed: min=${ash3?.salary_min}, max=${ash3?.salary_max}`);
    }

    const ash4 = ashbyResults.find((j) => j.source_job_id === 'ramp-ashby-4');
    if (!ash4 || ash4.salary_min !== 140000 || ash4.salary_max !== 175000) {
      failures.push(`FAIL: Ashby Job 4 description regex fallback failed: min=${ash4?.salary_min}, max=${ash4?.salary_max}`);
    }
    console.log('  ✓ Ashby structured includeCompensation validated successfully.');

    // -------------------------------------------------------------------------------------------
    // 3. LEVER ADAPTER TESTS
    // -------------------------------------------------------------------------------------------
    console.log('Testing Lever native salaryRange extraction...');
    const leverAdapter = new LeverAdapter();
    const leverSource = { id: 'lever-logrocket', name: 'LogRocket (Lever)', type: 'lever', target: 'logrocket', enabled: true };
    const leverResults = await leverAdapter.fetchJobs(leverSource);

    const lev1 = leverResults.find((j) => j.source_job_id === 'logrocket-lever-1');
    if (!lev1 || lev1.salary_min !== expectedLeverMin || lev1.salary_max !== 175000 || lev1.salary_period !== 'yearly') {
      failures.push(`FAIL: Lever Job 1 yearly salary parsed incorrectly: min=${lev1?.salary_min}, max=${lev1?.salary_max}, period=${lev1?.salary_period}`);
    }
    if (!lev1?.salary_text?.includes('$105,000') || !lev1?.salary_text?.includes('$175,000')) {
      failures.push(`FAIL: Lever Job 1 salary_text missing formatted bounds: "${lev1?.salary_text}"`);
    }

    const lev2 = leverResults.find((j) => j.source_job_id === 'logrocket-lever-2');
    if (!lev2 || lev2.salary_min !== 31 || lev2.salary_max !== 38 || lev2.salary_period !== 'hourly') {
      failures.push(`FAIL: Lever Job 2 hourly salary parsed incorrectly: min=${lev2?.salary_min}, max=${lev2?.salary_max}, period=${lev2?.salary_period}`);
    }

    const lev3 = leverResults.find((j) => j.source_job_id === 'logrocket-lever-3');
    if (!lev3 || lev3.salary_min !== 125000 || lev3.salary_max !== 155000) {
      failures.push(`FAIL: Lever Job 3 description regex fallback failed: min=${lev3?.salary_min}, max=${lev3?.salary_max}`);
    }

    const lev4 = leverResults.find((j) => j.source_job_id === 'logrocket-lever-4');
    if (!lev4 || lev4.salary_min !== null || lev4.salary_max !== null || lev4.salary_text !== null) {
      failures.push(`FAIL: Lever Job 4 with no salary should yield null: min=${lev4?.salary_min}, text=${lev4?.salary_text}`);
    }
    console.log('  ✓ Lever native salaryRange validated successfully.');
  } finally {
    (globalThis as any).fetch = origFetch;
  }

  // -------------------------------------------------------------------------------------------
  // 4. NEGATIVE CONTROL ENFORCEMENT
  // -------------------------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length >= 3) {
      console.log(`\nNEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.error(`\nNEGATIVE CONTROL FAILED: Expected >= 3 failures, but only got ${failures.length}`);
      process.exit(0);
    }
  }

  // Normal execution: spawn negative control subprocess
  console.log('\nRunning negative control subprocess...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-adapter-structured-salaries.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });

  if (negResult.status === 0) {
    failures.push('FAIL: Negative control subprocess unexpectedly exited with code 0. Must fail on corrupted assertions.');
  } else {
    console.log(`  ✓ Negative control verified: Subprocess exited with code ${negResult.status} on intentional anomalies.`);
  }

  if (failures.length > 0) {
    console.error('\nVALIDATION FAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log('\n================================================================================');
  console.log('ALL STRUCTURED ATS ADAPTER SALARY TESTS PASSED [PASS-LOCAL]');
  console.log('================================================================================');
  process.exit(0);
}

run();
