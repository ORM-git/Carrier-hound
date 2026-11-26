/** Dedicated employment-field adapters, entirely offline. No persistence/runtime-schema claim. */
import assert from 'node:assert/strict';
import { sourceEmploymentType } from './utils/sourceEmploymentType';
import { LeverAdapter } from './adapters/lever';
import { JoinAdapter } from './adapters/join';
import { WorkableAdapter } from './adapters/workable';
import { BreezyAdapter } from './adapters/breezy';
import { SmartRecruitersAdapter } from './adapters/smartrecruiters';
import { RemotiveAdapter } from './adapters/remotive';
import { lastRequestByDomain } from './utils/polite-fetch';

async function main() {
  let passed = 0;
  const check = (label: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, label); passed++; console.log(`PASS ${label}`); };
  for (const [raw, expected] of [['Full Time', 'full-time'], ['Part time', 'part-time'], ['contractor', 'contract'], ['Co-op', 'internship'], ['full-time;contract', 'other'], ['Temporary', 'other'], ['constructor', 'other'], [false, 'other']] as const) {
    check(`structured mapping ${String(raw)}`, sourceEmploymentType('Engineer', raw), expected);
  }
  check('absent source keeps title-only internship', sourceEmploymentType('Engineering Intern', undefined), 'internship');
  check('absent source never invents full-time', sourceEmploymentType('Engineer', ''), 'job');
  check('explicit structured full-time wins over internship title cue', sourceEmploymentType('Internship Program Manager', 'Full-time'), 'full-time');
  check('explicit unsupported field is not title-inferred', sourceEmploymentType('Intern', 'unknown'), 'other');
  const sr = new SmartRecruitersAdapter();
  sr.maxDetailFetchesPerBoard = 0; // Fixture exercises the actual list-field mapping, not detail lookup/cache.
  const cases: Array<[string, any, (v: any, title: string) => any]> = [
    ['lever', new LeverAdapter(), (v, title) => [{ id: '1', text: title, hostedUrl: 'https://jobs.lever.co/fixture/1', categories: { commitment: v } }]],
    ['join', new JoinAdapter(), (v, title) => [{ id: '1', title, employmentType: v }]],
    ['workable', new WorkableAdapter(), (v, title) => ({ jobs: [{ shortcode: '1', title, type: v }] })],
    ['breezy', new BreezyAdapter(), (v, title) => [{ id: '1', name: title, type: v === undefined ? undefined : { name: v } }]],
    ['smartrecruiters', sr, (v, title) => ({ content: [{ id: '1', name: title, typeOfEmployment: { label: v } }], totalFound: 1 })],
    ['remotive', new RemotiveAdapter(), (v, title) => ({ jobs: [{ id: '1', title, company_name: 'Fixture', url: 'https://fixture.test/1', job_type: v }] })],
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const [type, adapter, payload] of cases) {
      for (const [value, title, expected] of [
        ['Full-time', 'Engineer', 'full-time'], ['Part time', 'Engineer', 'part-time'], ['Contractor', 'Engineer', 'contract'],
        ['Intern', 'Engineer', 'internship'], ['full-time or contract', 'Engineer', 'other'], ['unknown', 'Intern', 'other'],
        [undefined, 'Engineer', 'job'], [undefined, 'Engineering Intern', 'internship'],
      ] as const) {
        globalThis.fetch = async (input: any) => {
          const url = new URL(String(input));
          if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
          return new Response(JSON.stringify(payload(value, title)), { headers: { 'Content-Type': 'application/json' } });
        };
        lastRequestByDomain.clear();
        const rows = await adapter.fetchJobs({ id: 'fixture', name: 'Fixture', type, target: type === 'remotive' ? 'https://fixture.test/jobs' : 'fixture', enabled: true });
        check(`${type} ${String(value)} / ${title}`, rows.map((r: any) => r.job_type), [expected]);
      }
    }
  } finally { globalThis.fetch = originalFetch; lastRequestByDomain.clear(); }
  console.log(`${passed} employment-type checks passed. Raw provenance persistence and other pipelines remain separate work.`);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
