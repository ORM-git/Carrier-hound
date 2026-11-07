/**
 * Offline static test for the Jitter row (Reliability): every exponential
 * backoff wait on a retry path must pass through the shared
 * src/lib/reliability/jitter.ts helper so retries from many isolates do
 * not fire in lockstep (thundering herd). Locks the four backoff call
 * sites to withJitter and keeps the helper's contract intact.
 * Run: npx tsx scripts/test-jitter-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const helperPath = "src/lib/reliability/jitter.ts";
check("jitter helper exists", fs.existsSync(helperPath));
const helper = fs.readFileSync(helperPath, "utf8");
check("helper defaults to ±20% jitter", /fraction \?\? 0\.2/.test(helper));
check("helper bounds the sample to [base*(1-f), base*(1+f)]", /1 - fraction \+ 2 \* fraction/.test(helper));
check("helper has an injectable RNG for deterministic tests", /rand\?: \(\) => number/.test(helper));
check("helper rejects invalid baseMs", /throw new RangeError/.test(helper));

const polite = fs.readFileSync("scripts/utils/polite-fetch.ts", "utf8");
check("polite-fetch imports withJitter", /import \{ withJitter \} from "\.\.\/\.\.\/src\/lib\/reliability\/jitter"/.test(polite));
check("polite-fetch 429 backoff is jittered", /withJitter\(2000 \* Math\.pow\(2, attempt\)\)/.test(polite));
check("polite-fetch failure backoff is jittered", /withJitter\(1500 \* Math\.pow\(2, attempt - 1\)\)/.test(polite));

const subscription = fs.readFileSync("src/lib/billing/subscription.ts", "utf8");
check("subscription check imports withJitter", /import \{ withJitter \} from "\.\.\/reliability\/jitter"/.test(subscription));
check(
  "both subscription retry waits are jittered",
  (subscription.match(/withJitter\(500 \* Math\.pow\(2, attempt\)\)/g) || []).length === 2
);

const failedEvents = fs.readFileSync("src/lib/events/failedEvents.ts", "utf8");
check("failedEvents imports withJitter", /import \{ withJitter \} from "\.\.\/reliability\/jitter"/.test(failedEvents));
check(
  "failed-events replay backoff is jittered",
  /withJitter\(Math\.pow\(2, nextAttempt\) \* 60 \* 1000\)/.test(failedEvents)
);

check("behavioral vitest suite exists", fs.existsSync("src/lib/__tests__/jitter.test.ts"));
check("jitter rationale doc exists", fs.existsSync("docs/retry-jitter.md"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
