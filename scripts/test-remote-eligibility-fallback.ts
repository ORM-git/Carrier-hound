/**
 * Row 19: TS detectRemoteEligibility no longer calls a remote job with no stated geography "worldwide"; it matches
 * the Python writer (scripts/scraper/fetchers.py _greenhouse_remote_eligibility). One case per row of the table in
 * docs/proposed/row19_remote_eligibility_research.md, plus what the stored value does in isJobEligible.
 * Run: npx tsx scripts/test-remote-eligibility-fallback.ts
 */
import { detectRemoteEligibility } from './utils/sanitizer';
import { isJobEligible } from '../src/lib/jobs/eligibility';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

// Table rows (detector)
check('not remote -> unknown', detectRemoteEligibility('Berlin, Germany', false), 'unknown');
for (const loc of ['Remote - Anywhere', 'Worldwide', 'Remote (Global)', 'All regions', 'Work from anywhere']) {
  check(`remote + "${loc}" -> worldwide`, detectRemoteEligibility(loc, true), 'worldwide');
}
check('remote + country -> country_restricted', detectRemoteEligibility('Remote, Germany', true), 'country_restricted');
check('remote + no location signal ("Remote") -> unknown', detectRemoteEligibility('Remote', true), 'unknown');
check('remote + empty location -> unknown', detectRemoteEligibility('', true), 'unknown');

// What the stored value means for eligibility (src/lib/jobs/eligibility.ts rules 3 and 5)
const india = ['IN'];
const bare = { remote: true, remote_scope: 'remote', location: 'Remote', country_code: null };
check('bare "Remote" stored as unknown: still eligible via rule 5',
  isJobEligible({ ...bare, remote_eligibility: detectRemoteEligibility('Remote', true) }, india), true);
const usCoded = { remote: true, remote_scope: 'remote', location: 'Remote', country_code: 'US' };
check('US-coded remote job, old stored "worldwide": shown to an India-only user (rule 3)',
  isJobEligible({ ...usCoded, remote_eligibility: 'worldwide' }, india), true);
check('US-coded remote job, new stored value: not shown to an India-only user (rule 5 sees the US code)',
  isJobEligible({ ...usCoded, remote_eligibility: detectRemoteEligibility('Remote', true) }, india), false);
check('US-coded remote job, new stored value: still shown to a US user',
  isJobEligible({ ...usCoded, remote_eligibility: detectRemoteEligibility('Remote', true) }, ['US']), true);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
