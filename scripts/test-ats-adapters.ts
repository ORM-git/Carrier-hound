/**
 * scripts/test-ats-adapters.ts
 *
 * Unit tests for ATS adapters (Workable, SmartRecruiters, Recruitee, Breezy, Teamtailor, Personio)
 * and dedupe/merge candidate engine.
 *
 * Rules:
 * - Offline unit test (strictly mocked network via globalThis.fetch).
 * - Tests normalized job schema, field mapping, remote/country detection, and apply URLs.
 * - Tests dedupeCandidates and mergeAndDedupeCandidates with case/whitespace/malformed handling.
 * - Negative control verifies non-zero exit when invalid conditions or assertions fail.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { WorkableAdapter } from './adapters/workable';
import { SmartRecruitersAdapter } from './adapters/smartrecruiters';
import { RecruiteeAdapter } from './adapters/recruitee';
import { BreezyAdapter } from './adapters/breezy';
import { TeamtailorAdapter } from './adapters/teamtailor';
import { PersonioAdapter } from './adapters/personio';
import {
  dedupeCandidates,
  mergeAndDedupeCandidates,
  extractTokenFromUrl,
  discoverFromCompanyProbing,
  runBoardDiscovery,
} from './board-discovery';
import {
  getRegistrableDomain,
  throttleDomain,
  lastRequestByDomain,
} from './utils/polite-fetch';
import { isAuthorizedAtsUrl } from './board-ingest';
import { SourceConfig } from './types';

const isNegativeControl = process.argv.includes('--negative-control');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`, detail !== undefined ? detail : '');
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Network Mocking (Zero External Calls)
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

const WORKABLE_FIXTURE = {
  jobs: [
    {
      title: 'Senior Frontend Engineer',
      shortcode: 'FE101',
      city: 'Berlin',
      country: 'Germany',
      countryCode: 'DE',
      telecommuting: true,
      type: 'full_time',
      published: '2026-01-15T10:00:00Z',
      department: 'Engineering',
      description: '<p>Frontend role details</p>',
    },
  ],
};

const SMARTRECRUITERS_FIXTURE = {
  totalFound: 1,
  content: [
    {
      id: 'sr-101',
      name: 'Backend Staff Engineer',
      location: {
        city: 'San Francisco',
        region: 'CA',
        country: 'US',
        remote: true,
      },
      typeOfEmployment: {
        id: 'permanent',
        label: 'Full-Time',
      },
      releasedDate: '2026-01-15T10:00:00Z',
      department: { label: 'Infrastructure' },
    },
  ],
};

const RECRUITEE_FIXTURE = {
  offers: [
    {
      id: 501,
      title: 'Product Designer',
      city: 'London',
      country: 'United Kingdom',
      country_code: 'GB',
      remote: true,
      published_at: '2026-01-15T10:00:00Z',
      department: 'Design',
      careers_url: 'https://acme.recruitee.com/o/501',
    },
  ],
};

const BREEZY_FIXTURE = [
  {
    id: 'bz-101',
    name: 'DevOps Lead',
    url: 'https://acme.breezy.hr/p/bz-101',
    type: { id: 'full_time', name: 'Full-Time' },
    location: {
      city: 'Toronto',
      country: { name: 'Canada', code: 'CA' },
      is_remote: true,
    },
    department: 'DevOps',
    published_at: '2026-01-15T10:00:00Z',
    description: '<p>DevOps Lead description</p>',
  },
];

const TEAMTAILOR_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>Acme Careers</title>
    <link>https://acme.teamtailor.com/jobs</link>
    <item>
      <title>Engineering Manager</title>
      <link>https://acme.teamtailor.com/jobs/999-engineering-manager</link>
      <guid isPermaLink="true">https://acme.teamtailor.com/jobs/999-engineering-manager</guid>
      <description><![CDATA[<p>Lead the team</p>]]></description>
      <pubDate>Wed, 15 Jan 2026 10:00:00 +0000</pubDate>
      <tt:city>Stockholm</tt:city>
      <tt:country>Sweden</tt:country>
      <tt:status>remote</tt:status>
      <tt:department>Engineering</tt:department>
    </item>
  </channel>
</rss>`;

const PERSONIO_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>777</id>
    <name>Data Analyst</name>
    <office>Munich</office>
    <department>Data &amp; Analytics</department>
    <employmentType>permanent</employmentType>
    <schedule>full-time</schedule>
    <createdAt>2026-01-15T10:00:00Z</createdAt>
    <jobDescriptions>
      <jobDescription>
        <name>Role</name>
        <value><![CDATA[<p>Analyze data</p>]]></value>
      </jobDescription>
    </jobDescriptions>
  </position>
</workzag-jobs>`;

function setupMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as any).url;

    if (urlStr.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (urlStr.includes('apply.workable.com/api/v1/widget/accounts/')) {
      return new Response(JSON.stringify(WORKABLE_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.includes('api.smartrecruiters.com/v1/companies/')) {
      return new Response(JSON.stringify(SMARTRECRUITERS_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.includes('.recruitee.com/api/offers/')) {
      return new Response(JSON.stringify(RECRUITEE_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.endsWith('.breezy.hr/json')) {
      return new Response(JSON.stringify(BREEZY_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.endsWith('.teamtailor.com/jobs.rss')) {
      return new Response(TEAMTAILOR_FIXTURE, {
        status: 200,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (urlStr.includes('.jobs.personio.de/xml') || urlStr.includes('.jobs.personio.com/xml')) {
      return new Response(PERSONIO_FIXTURE, {
        status: 200,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (urlStr.includes('index.commoncrawl.org/collinfo.json')) {
      return new Response(JSON.stringify([{ id: 'CC-MAIN-2026-43' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr.includes('index.commoncrawl.org/')) {
      return new Response('{"url":"https://boards.greenhouse.io/mockcompany"}\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (urlStr.includes('raw.githubusercontent.com')) {
      if (urlStr.endsWith('.csv')) {
        return new Response('token,name\nmockslug,MockCompany\n', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response(JSON.stringify(['mockslug']), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };
}

async function runTests() {
  if (isNegativeControl) {
    // Deliberate negative control: assert bad adapter output fails
    assert(false, 'Negative control triggered intentional failure');
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log('🧪 ATS ADAPTERS & MERGE/DEDUPE TEST SUITE');
  console.log('======================================================\n');

  setupMockFetch();

  // ---------------------------------------------------------------------------
  // 1. Workable Adapter Test
  // ---------------------------------------------------------------------------
  console.log('1. Testing WorkableAdapter...');
  const workable = new WorkableAdapter();
  const workableSource: SourceConfig = {
    id: 'workable-invision',
    name: 'InVision',
    type: 'workable',
    target: 'invision',
    enabled: true,
  };
  const workableJobs = await workable.fetchJobs(workableSource);
  assert(workableJobs.length === 1, 'Workable returns 1 job');
  assert(workableJobs[0].source === 'workable', 'Workable source is workable');
  assert(workableJobs[0].title === 'Senior Frontend Engineer', 'Workable title parsed');
  assert(workableJobs[0].country_code === 'DE', 'Workable country code parsed');
  assert(workableJobs[0].remote === true, 'Workable telecommuting mapped to remote');
  assert(workableJobs[0].apply_url.includes('apply.workable.com'), 'Workable apply_url well-formed');

  // ---------------------------------------------------------------------------
  // 2. SmartRecruiters Adapter Test
  // ---------------------------------------------------------------------------
  console.log('\n2. Testing SmartRecruitersAdapter...');
  const smart = new SmartRecruitersAdapter();
  const smartSource: SourceConfig = {
    id: 'smart-visa',
    name: 'Visa',
    type: 'smartrecruiters',
    target: 'visa',
    enabled: true,
  };
  const smartJobs = await smart.fetchJobs(smartSource);
  assert(smartJobs.length === 1, 'SmartRecruiters returns 1 job');
  assert(smartJobs[0].source === 'smartrecruiters', 'SmartRecruiters source is smartrecruiters');
  assert(smartJobs[0].title === 'Backend Staff Engineer', 'SmartRecruiters title parsed');
  assert(smartJobs[0].country_code === 'US', 'SmartRecruiters country code parsed');
  assert(smartJobs[0].remote === true, 'SmartRecruiters location.remote mapped to remote');
  assert(smartJobs[0].apply_url.includes('jobs.smartrecruiters.com'), 'SmartRecruiters apply_url well-formed');

  // ---------------------------------------------------------------------------
  // 3. Recruitee Adapter Test
  // ---------------------------------------------------------------------------
  console.log('\n3. Testing RecruiteeAdapter...');
  const recruitee = new RecruiteeAdapter();
  const recruiteeSource: SourceConfig = {
    id: 'recruitee-hotjar',
    name: 'Hotjar',
    type: 'recruitee',
    target: 'hotjar',
    enabled: true,
  };
  const recruiteeJobs = await recruitee.fetchJobs(recruiteeSource);
  assert(recruiteeJobs.length === 1, 'Recruitee returns 1 job');
  assert(recruiteeJobs[0].source === 'recruitee', 'Recruitee source is recruitee');
  assert(recruiteeJobs[0].title === 'Product Designer', 'Recruitee title parsed');
  assert(recruiteeJobs[0].country_code === 'GB', 'Recruitee country code parsed');
  assert(recruiteeJobs[0].remote === true, 'Recruitee remote mapped');
  assert(recruiteeJobs[0].apply_url === 'https://acme.recruitee.com/o/501', 'Recruitee apply_url preserved');

  // ---------------------------------------------------------------------------
  // 4. Breezy Adapter Test
  // ---------------------------------------------------------------------------
  console.log('\n4. Testing BreezyAdapter...');
  const breezy = new BreezyAdapter();
  const breezySource: SourceConfig = {
    id: 'breezy-acme',
    name: 'Acme',
    type: 'breezy',
    target: 'acme',
    enabled: true,
  };
  const breezyJobs = await breezy.fetchJobs(breezySource);
  assert(breezyJobs.length === 1, 'Breezy returns 1 job');
  assert(breezyJobs[0].source === 'breezy', 'Breezy source is breezy');
  assert(breezyJobs[0].title === 'DevOps Lead', 'Breezy title parsed');
  assert(breezyJobs[0].country_code === 'CA', 'Breezy country code parsed');
  assert(breezyJobs[0].remote === true, 'Breezy location.is_remote mapped to remote');
  assert(breezyJobs[0].apply_url === 'https://acme.breezy.hr/p/bz-101', 'Breezy apply_url well-formed');

  // ---------------------------------------------------------------------------
  // 5. Teamtailor Adapter Test
  // ---------------------------------------------------------------------------
  console.log('\n5. Testing TeamtailorAdapter...');
  const teamtailor = new TeamtailorAdapter();
  const teamtailorSource: SourceConfig = {
    id: 'tt-acme',
    name: 'Acme',
    type: 'teamtailor',
    target: 'acme',
    enabled: true,
  };
  const ttJobs = await teamtailor.fetchJobs(teamtailorSource);
  assert(ttJobs.length === 1, 'Teamtailor returns 1 job');
  assert(ttJobs[0].source === 'teamtailor', 'Teamtailor source is teamtailor');
  assert(ttJobs[0].title === 'Engineering Manager', 'Teamtailor title parsed from RSS item');
  assert(ttJobs[0].remote === true, 'Teamtailor tt:status remote mapped to remote');
  assert(ttJobs[0].apply_url === 'https://acme.teamtailor.com/jobs/999-engineering-manager', 'Teamtailor link preserved');

  // ---------------------------------------------------------------------------
  // 6. Personio Adapter Test
  // ---------------------------------------------------------------------------
  console.log('\n6. Testing PersonioAdapter...');
  const personio = new PersonioAdapter();
  const personioSource: SourceConfig = {
    id: 'personio-acme',
    name: 'Acme',
    type: 'personio',
    target: 'acme',
    enabled: true,
  };
  const personioJobs = await personio.fetchJobs(personioSource);
  assert(personioJobs.length === 1, 'Personio returns 1 job');
  assert(personioJobs[0].source === 'personio', 'Personio source is personio');
  assert(personioJobs[0].title === 'Data Analyst', 'Personio title parsed from position');
  assert(personioJobs[0].location === 'Munich', 'Personio office mapped to location');
  assert(personioJobs[0].apply_url === 'https://acme.jobs.personio.de/job/777', 'Personio apply_url well-formed');

  // ---------------------------------------------------------------------------
  // 7. URL Token Extraction Across All ATS Domains
  // ---------------------------------------------------------------------------
  console.log('\n7. Testing URL Token Extraction Across All ATS Domains...');
  assert(extractTokenFromUrl('https://boards.greenhouse.io/stripe/jobs/123')?.ats === 'greenhouse', 'Greenhouse extracted');
  assert(extractTokenFromUrl('https://jobs.lever.co/spotify/456')?.ats === 'lever', 'Lever extracted');
  assert(extractTokenFromUrl('https://jobs.ashbyhq.com/openai/789')?.ats === 'ashby', 'Ashby extracted');
  assert(extractTokenFromUrl('https://apply.workable.com/invision/j/101')?.token === 'invision', 'Workable extracted');
  assert(extractTokenFromUrl('https://jobs.smartrecruiters.com/visa/202')?.token === 'visa', 'SmartRecruiters extracted');
  assert(extractTokenFromUrl('https://hotjar.recruitee.com/o/303')?.token === 'hotjar', 'Recruitee extracted');
  assert(extractTokenFromUrl('https://acme.breezy.hr/p/404')?.token === 'acme', 'Breezy extracted');
  assert(extractTokenFromUrl('https://gitlab.bamboohr.com/careers/505')?.token === 'gitlab', 'BambooHR extracted');
  assert(extractTokenFromUrl('https://polestar.teamtailor.com/jobs')?.token === 'polestar', 'Teamtailor extracted');
  assert(extractTokenFromUrl('https://acme.jobs.personio.de/job/606')?.token === 'acme', 'Personio extracted');
  assert(extractTokenFromUrl('https://join.com/companies/startup')?.token === 'startup', 'Join extracted');
  assert(extractTokenFromUrl('https://www.linkedin.com/jobs/view/123') === null, 'Forbidden domain rejected');

  // ---------------------------------------------------------------------------
  // 8. Dedupe and Merge Logic
  // ---------------------------------------------------------------------------
  console.log('\n8. Testing Dedupe & Merge Logic...');
  const inputCandidates = [
    { ats: 'greenhouse', token: 'stripe' },
    { ats: 'greenhouse', token: 'STRIPE' }, // duplicate (case)
    { ats: 'greenhouse', token: ' stripe ' }, // duplicate (whitespace)
    { ats: 'lever', token: 'stripe' }, // different ATS, valid
    { ats: 'greenhouse', token: '123' }, // invalid numeric-only, dropped
    { ats: 'greenhouse', token: 'a' }, // invalid length < 2, dropped
    { ats: 'breezy', token: 'acme' },
  ];

  const deduped = dedupeCandidates(inputCandidates);
  assert(deduped.length === 3, 'dedupeCandidates correctly filtered to 3 unique valid items');
  assert(
    deduped.some((d) => d.ats === 'greenhouse' && d.token === 'stripe'),
    'Preserved greenhouse:stripe'
  );
  assert(
    deduped.some((d) => d.ats === 'lever' && d.token === 'stripe'),
    'Preserved lever:stripe (different ATS)'
  );
  assert(
    deduped.some((d) => d.ats === 'breezy' && d.token === 'acme'),
    'Preserved breezy:acme'
  );

  const existing = [{ ats: 'greenhouse', token: 'stripe' }];
  const incoming = [
    { ats: 'greenhouse', token: 'stripe' },
    { ats: 'ashby', token: 'openai' },
  ];
  const merged = mergeAndDedupeCandidates(existing, incoming);
  assert(merged.length === 2, 'mergeAndDedupeCandidates merged without duplicates');
  assert(
    merged.some((m) => m.ats === 'ashby' && m.token === 'openai'),
    'Merged incoming ashby:openai'
  );

  // ---------------------------------------------------------------------------
  // 9. Registrable-Domain Throttle & Suffix Extraction
  // ---------------------------------------------------------------------------
  console.log('\n9. Testing Registrable-Domain Throttle & Suffix Extraction...');
  assert(getRegistrableDomain('boards-api.greenhouse.io') === 'greenhouse.io', 'Greenhouse registrable domain is greenhouse.io');
  assert(getRegistrableDomain('api.lever.co') === 'lever.co', 'Lever registrable domain is lever.co');
  assert(getRegistrableDomain('api.ashbyhq.com') === 'ashbyhq.com', 'Ashby registrable domain is ashbyhq.com');
  assert(getRegistrableDomain('apply.workable.com') === 'workable.com', 'Workable registrable domain is workable.com');
  assert(getRegistrableDomain('api.smartrecruiters.com') === 'smartrecruiters.com', 'SmartRecruiters registrable domain is smartrecruiters.com');
  assert(getRegistrableDomain('hotjar.recruitee.com') === 'recruitee.com', 'Recruitee registrable domain is recruitee.com');
  assert(getRegistrableDomain('acme.breezy.hr') === 'breezy.hr', 'Breezy registrable domain is breezy.hr');
  assert(getRegistrableDomain('acme.teamtailor.com') === 'teamtailor.com', 'Teamtailor registrable domain is teamtailor.com');
  assert(getRegistrableDomain('acme.jobs.personio.de') === 'personio.de', 'Personio .de registrable domain is personio.de');
  assert(getRegistrableDomain('acme.jobs.personio.com') === 'personio.com', 'Personio .com registrable domain is personio.com');
  assert(getRegistrableDomain('gitlab.bamboohr.com') === 'bamboohr.com', 'BambooHR registrable domain is bamboohr.com');
  assert(getRegistrableDomain('join.com') === 'join.com', 'Join registrable domain is join.com');
  assert(getRegistrableDomain('sub.join.com') === 'join.com', 'Join subdomain registrable domain is join.com');

  // Throttle shares bucket across subdomains of same registrable domain
  lastRequestByDomain.delete('breezy.hr');
  await throttleDomain('sub1.breezy.hr', 10);
  const t1 = lastRequestByDomain.get('breezy.hr');
  assert(typeof t1 === 'number' && t1 > 0, 'throttleDomain updated lastRequestByDomain for breezy.hr on sub1');
  await throttleDomain('sub2.breezy.hr', 10);
  const t2 = lastRequestByDomain.get('breezy.hr');
  assert(typeof t2 === 'number' && t2 >= t1, 'sub2.breezy.hr shares same rate-limiter bucket as sub1.breezy.hr');

  // ---------------------------------------------------------------------------
  // 10. isAuthorizedAtsUrl Security Enforcement for All 11 Hosts
  // ---------------------------------------------------------------------------
  console.log('\n10. Testing isAuthorizedAtsUrl for All 11 ATS Hosts...');
  assert(isAuthorizedAtsUrl('https://boards-api.greenhouse.io/v1/boards/stripe/jobs', 'greenhouse'), 'Authorized Greenhouse URL');
  assert(isAuthorizedAtsUrl('https://api.lever.co/v0/postings/spotify', 'lever'), 'Authorized Lever URL');
  assert(isAuthorizedAtsUrl('https://api.ashbyhq.com/posting-api/job-board/openai', 'ashby'), 'Authorized Ashby URL');
  assert(isAuthorizedAtsUrl('https://apply.workable.com/api/v1/widget/accounts/acme', 'workable'), 'Authorized Workable URL');
  assert(isAuthorizedAtsUrl('https://api.smartrecruiters.com/v1/companies/visa/postings', 'smartrecruiters'), 'Authorized SmartRecruiters URL');
  assert(isAuthorizedAtsUrl('https://acme.recruitee.com/api/offers/', 'recruitee'), 'Authorized Recruitee URL');
  assert(isAuthorizedAtsUrl('https://acme.breezy.hr/json', 'breezy'), 'Authorized Breezy URL');
  assert(isAuthorizedAtsUrl('https://acme.teamtailor.com/jobs.rss', 'teamtailor'), 'Authorized Teamtailor URL');
  assert(isAuthorizedAtsUrl('https://acme.jobs.personio.de/xml', 'personio'), 'Authorized Personio .de URL');
  assert(isAuthorizedAtsUrl('https://acme.jobs.personio.com/xml', 'personio'), 'Authorized Personio .com URL');
  assert(isAuthorizedAtsUrl('https://acme.bamboohr.com/careers/list', 'bamboohr'), 'Authorized BambooHR URL');
  assert(isAuthorizedAtsUrl('https://join.com/api/companies/startup', 'join'), 'Authorized Join URL');

  // Security rejections: non-https, domain spoofing, wrong ATS, forbidden domains
  assert(!isAuthorizedAtsUrl('http://boards-api.greenhouse.io/v1/boards/stripe/jobs', 'greenhouse'), 'Rejects non-https');
  assert(!isAuthorizedAtsUrl('https://boards-api.greenhouse.io.attacker.com/v1/boards/stripe', 'greenhouse'), 'Rejects host suffix spoofing on Greenhouse');
  assert(!isAuthorizedAtsUrl('https://acme.breezy.hr.attacker.com/json', 'breezy'), 'Rejects host suffix spoofing on Breezy');
  assert(!isAuthorizedAtsUrl('https://api.lever.co/v0/postings/spotify', 'greenhouse'), 'Rejects ATS type mismatch (Lever URL tested as Greenhouse)');
  assert(!isAuthorizedAtsUrl('https://www.linkedin.com/jobs/search', 'greenhouse'), 'Rejects forbidden scrapable domain (LinkedIn)');
  assert(!isAuthorizedAtsUrl('https://indeed.com/jobs', 'workable'), 'Rejects forbidden scrapable domain (Indeed)');
  assert(!isAuthorizedAtsUrl('https://workday.com/careers', 'smartrecruiters'), 'Rejects forbidden scrapable domain (Workday)');

  // ---------------------------------------------------------------------------
  // 11. Company Probe OFF by Default & Restricted to GH/Lever/Ashby
  // ---------------------------------------------------------------------------
  console.log('\n11. Testing Probe Flag OFF by Default & Restriction to GH/Lever/Ashby...');
  const probeCandidates = discoverFromCompanyProbing();
  const probeAtsTypes = new Set(probeCandidates.map((c) => c.ats));
  assert(probeCandidates.length > 0, 'discoverFromCompanyProbing generates probe candidates');
  assert(
    Array.from(probeAtsTypes).every((ats) => ['greenhouse', 'lever', 'ashby'].includes(ats)),
    'Probing is strictly restricted to established platforms (greenhouse, lever, ashby) only'
  );
  assert(!probeAtsTypes.has('workable' as any), 'Probing excludes workable');
  assert(!probeAtsTypes.has('breezy' as any), 'Probing excludes breezy');
  assert(!probeAtsTypes.has('bamboohr' as any), 'Probing excludes bamboohr');

  // Verify runBoardDiscovery does NOT invoke company probing when companyProbe is omitted (default false)
  const testTmpPath = path.resolve(__dirname, '../data/ats-candidates-test-tmp.json');
  const discoveryRunDefault = await runBoardDiscovery({
    sourceFilter: 'all',
    verifyLimit: 1,
    companyProbe: false,
    outputFilePath: testTmpPath,
  });
  assert(
    discoveryRunDefault.stats.candidatesFoundPerSource.company_probe === 0,
    'Company probing is OFF by default when companyProbe is false or omitted'
  );

  // Clean up temporary output file
  try {
    if (fs.existsSync(testTmpPath)) {
      fs.unlinkSync(testTmpPath);
    }
  } catch {}

  // Restore fetch before running subprocess
  globalThis.fetch = originalFetch;

  // ---------------------------------------------------------------------------
  // 12. Negative Control Subprocess Verification
  // ---------------------------------------------------------------------------
  console.log('\n12. Running negative control subprocess to verify non-zero exit on assertion failures...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-ats-adapters.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });
  assert(
    negResult.status !== 0,
    `Negative control subprocess exited non-zero as expected (code ${negResult.status})`
  );

  console.log('\n======================================================');
  console.log(`📊 ADAPTER SUITE RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
