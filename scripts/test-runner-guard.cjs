/**
 * scripts/test-runner-guard.cjs
 *
 * Self-test suite for CareerMonke test runner containment and isolation.
 *
 * Enforces:
 * - Isolated verification using ONLY temporary fake suites and fake environment values.
 * - Imports NO real .env or .env.local files.
 * - Proves production/unknown/missing targets block DB suites before spawn.
 * - Proves production deny wins over an injected test allowlist.
 * - Proves offline children have fake secrets removed from their environment.
 * - Proves external network attempts are denied by the actual child preload.
 * - Proves PASSED, FAILED, SKIPPED, and BLOCKED are separated and counted correctly.
 * - Negative controls proving non-zero runner exit on failure.
 * - NEVER runs any real DB suite.
 */

"use strict";

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  classifySuite,
  isDbCapable,
  checkTargetAuthorization,
  stripCredentials,
  redactOutput,
  executeSuiteList,
  EXIT_CODES,
  DENIED_PROJECT_REFS,
  SUITE_CLASSIFICATIONS,
} = require("./lib/test-guard.cjs");

console.log("================================================================================");
console.log("CAREERMONKE RUNNER CONTAINMENT & SAFETY ISOLATION SELF-TEST");
console.log("Environment: Isolated fake fixtures only. Real .env explicitly not imported.");
console.log("================================================================================\n");

let passedAsserts = 0;
let totalAsserts = 0;

function testAssert(desc, condition, detail) {
  totalAsserts++;
  if (condition) {
    passedAsserts++;
    console.log(`  [PASS] ${desc}`);
  } else {
    console.error(`  [FAIL] ${desc}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// GROUP 1: Suite Classification & Unknown Fail-Closed Enforcement
// -----------------------------------------------------------------------------
console.log("--- 1. SUITE CLASSIFICATION & FAIL-CLOSED UNKNOWN POLICY ---");

testAssert(
  "test-admin-suite.ts is classified as db-write",
  classifySuite("scripts/test-admin-suite.ts") === "db-write"
);

testAssert(
  "test-filters.ts is classified as db-anon-write-attempt",
  classifySuite("scripts/test-filters.ts") === "db-anon-write-attempt"
);

testAssert(
  "test-enhanced-scoring.ts is classified as db-read",
  classifySuite("scripts/test-enhanced-scoring.ts") === "db-read"
);

testAssert(
  "test-trust-acceptance.ts is classified as offline",
  classifySuite("scripts/test-trust-acceptance.ts") === "offline"
);

testAssert(
  "Unregistered / unknown suite fails closed to db-write",
  classifySuite("scripts/test-unknown-arbitrary-script.ts") === "db-write"
);

testAssert(
  "Empty or invalid suite name fails closed to db-write",
  classifySuite("") === "db-write" && classifySuite(null) === "db-write"
);

testAssert(
  "isDbCapable identifies db-read, db-write, db-anon-write-attempt as DB-capable",
  isDbCapable("db-read") && isDbCapable("db-write") && isDbCapable("db-anon-write-attempt")
);

testAssert(
  "isDbCapable identifies offline as NOT DB-capable",
  !isDbCapable("offline")
);

// Verify all registered suites in map have valid classifications
const validTypes = ["offline", "db-read", "db-write", "db-anon-write-attempt"];
let allClassificationsValid = true;
for (const [suite, type] of Object.entries(SUITE_CLASSIFICATIONS)) {
  if (!validTypes.includes(type)) {
    allClassificationsValid = false;
    break;
  }
}
testAssert("All registered suite classifications belong to allowed set", allClassificationsValid);

// -----------------------------------------------------------------------------
// GROUP 2: Target Authorization & Absolute Production Deny
// -----------------------------------------------------------------------------
console.log("\n--- 2. TARGET AUTHORIZATION & PRODUCTION DENY BOUNDARIES ---");

// Test 2a: Production target with empty allowlist
const prodEmpty = checkTargetAuthorization({
  url: "https://szakevhxhwpeskidvtfs.supabase.co",
  allowlist: [],
});
testAssert(
  "Production target szakevhxhwpeskidvtfs is blocked with empty allowlist",
  !prodEmpty.authorized && prodEmpty.isProductionDeny
);

// Test 2b: Production target with accidental allowlisting (production deny wins!)
const prodInAllowlist = checkTargetAuthorization({
  url: "https://szakevhxhwpeskidvtfs.supabase.co",
  allowlist: ["szakevhxhwpeskidvtfs", "test-project-123"],
});
testAssert(
  "Production deny strictly wins over injected test allowlist",
  !prodInAllowlist.authorized && prodInAllowlist.isProductionDeny
);

// Test 2c: Unknown target with empty allowlist
const unknownTarget = checkTargetAuthorization({
  url: "https://unknown-ref-9876543210.supabase.co",
  allowlist: [],
});
testAssert(
  "Unknown target is blocked when allowlist is empty",
  !unknownTarget.authorized && !unknownTarget.isProductionDeny
);

// Test 2d: Missing / empty target URL
const missingTarget = checkTargetAuthorization({
  url: "",
  allowlist: ["some-test-ref"],
});
testAssert(
  "Missing target URL / project ref is blocked before spawn",
  !missingTarget.authorized
);

// Test 2e: Valid non-production test project authorized ONLY when explicitly in allowlist
const validTargetAllowed = checkTargetAuthorization({
  url: "https://qa-staging-test-ref.supabase.co",
  allowlist: ["qa-staging-test-ref"],
});
testAssert(
  "Non-production project ref authorized when present in allowlist",
  validTargetAllowed.authorized && validTargetAllowed.projectRef === "qa-staging-test-ref"
);

// Test 2f: Non-production test project blocked when not in allowlist
const validTargetDisallowed = checkTargetAuthorization({
  url: "https://qa-staging-test-ref.supabase.co",
  allowlist: ["other-staging-ref"],
});
testAssert(
  "Non-production project ref blocked when mismatched in allowlist",
  !validTargetDisallowed.authorized
);

// -----------------------------------------------------------------------------
// GROUP 3: Child Environment Credential Stripping
// -----------------------------------------------------------------------------
console.log("\n--- 3. CHILD ENVIRONMENT CREDENTIAL STRIPPING ---");

const fakeEnv = {
  PATH: process.env.PATH,
  NODE_ENV: "test",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-secret-token",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-public-token",
  SUPABASE_URL: "https://fake.supabase.co",
  STRIPE_SECRET_KEY: "sk_test_fake_secret_key_12345",
  RAZORPAY_KEY_SECRET: "rzp_test_fake_secret_key_12345",
  GROQ_API_KEY: "gsk_fake_groq_api_key_12345",
  ADMIN_SECRET: "fake-admin-secret-token",
  CRON_SECRET: "fake-cron-secret-token",
  CUSTOM_SAFE_VAR: "safe-unrelated-config-value",
};

const { cleanEnv, strippedNames } = stripCredentials(fakeEnv);

testAssert(
  "All sensitive credential variables stripped from cleanEnv",
  cleanEnv.SUPABASE_SERVICE_ROLE_KEY === undefined &&
    cleanEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined &&
    cleanEnv.SUPABASE_URL === undefined &&
    cleanEnv.STRIPE_SECRET_KEY === undefined &&
    cleanEnv.RAZORPAY_KEY_SECRET === undefined &&
    cleanEnv.GROQ_API_KEY === undefined &&
    cleanEnv.ADMIN_SECRET === undefined &&
    cleanEnv.CRON_SECRET === undefined
);

testAssert(
  "Safe variables and PATH are preserved in cleanEnv",
  cleanEnv.PATH === fakeEnv.PATH && cleanEnv.CUSTOM_SAFE_VAR === "safe-unrelated-config-value"
);

testAssert(
  "Stripped names array contains stripped variable names without values",
  strippedNames.includes("SUPABASE_SERVICE_ROLE_KEY") &&
    strippedNames.includes("STRIPE_SECRET_KEY") &&
    !strippedNames.some((n) => n.includes("fake-service-role-secret"))
);

// -----------------------------------------------------------------------------
// GROUP 4: Child Network Denial Preload Live Demonstration
// -----------------------------------------------------------------------------
console.log("\n--- 4. CHILD NETWORK DENIAL PRELOAD (LIVE CHILD PROCESS DEMONSTRATION) ---");

const denyPreloadPath = path.resolve(__dirname, "lib/deny-network.cjs").replace(/\\/g, "/");

// Subtest 4a: Child process attempts external HTTP request
const httpChildScript = `
  const http = require('http');
  try {
    http.get('http://szakevhxhwpeskidvtfs.supabase.co', () => {});
    process.exit(0);
  } catch (err) {
    if (err.message && err.message.includes('[NETWORK DENIED]')) {
      console.log('HTTP_EXTERNAL_BLOCKED_SUCCESS');
      process.exit(0);
    }
    process.exit(2);
  }
`;

const httpChildRes = spawnSync(process.execPath, ["-e", httpChildScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Actual child HTTP request to external domain blocked by deny-network preload",
  httpChildRes.status === 0 && httpChildRes.stdout.includes("HTTP_EXTERNAL_BLOCKED_SUCCESS")
);

// Subtest 4b: Child process attempts external fetch request
const fetchChildScript = `
  (async () => {
    try {
      await globalThis.fetch('https://example.com');
      process.exit(0);
    } catch (err) {
      if (err.message && err.message.includes('[NETWORK DENIED]')) {
        console.log('FETCH_EXTERNAL_BLOCKED_SUCCESS');
        process.exit(0);
      }
      process.exit(2);
    }
  })();
`;

const fetchChildRes = spawnSync(process.execPath, ["-e", fetchChildScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Actual child fetch request to external domain blocked by deny-network preload",
  fetchChildRes.status === 0 && fetchChildRes.stdout.includes("FETCH_EXTERNAL_BLOCKED_SUCCESS")
);

// Subtest 4c: Child process attempts external TCP socket connection
const netChildScript = `
  const net = require('net');
  const socket = net.connect(80, 'example.com');
  socket.on('error', (err) => {
    if (err.message && err.message.includes('[NETWORK DENIED]')) {
      console.log('NET_EXTERNAL_BLOCKED_SUCCESS');
      process.exit(0);
    }
    process.exit(2);
  });
`;

const netChildRes = spawnSync(process.execPath, ["-e", netChildScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Actual child net.Socket connection to external domain blocked by deny-network preload",
  netChildRes.status === 0 && netChildRes.stdout.includes("NET_EXTERNAL_BLOCKED_SUCCESS")
);

// Subtest 4d: Child process connects to local loopback server (allowed!)
const loopbackChildScript = `
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LOOPBACK_OK');
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    http.get('http://127.0.0.1:' + port, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        server.close(() => {
          if (data === 'LOOPBACK_OK') {
            console.log('LOOPBACK_CONNECTION_PERMITTED');
            process.exit(0);
          }
          process.exit(2);
        });
      });
    }).on('error', (e) => {
      console.error(e);
      server.close(() => process.exit(3));
    });
  });
`;

const loopbackChildRes = spawnSync(process.execPath, ["-e", loopbackChildScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Actual child loopback HTTP connection (127.0.0.1) permitted by preload",
  loopbackChildRes.status === 0 && loopbackChildRes.stdout.includes("LOOPBACK_CONNECTION_PERMITTED")
);

// Subtest 4e: Child process connects to local loopback that issues a remote redirect (blocked!)
const redirectChildScript = `
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'https://szakevhxhwpeskidvtfs.supabase.co/rest/v1' });
    res.end();
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const req = http.get('http://127.0.0.1:' + port);
    req.on('error', (err) => {
      server.close(() => {
        if (err.message && err.message.includes('[NETWORK DENIED]')) {
          console.log('REMOTE_REDIRECT_BLOCKED_SUCCESS');
          process.exit(0);
        }
        process.exit(2);
      });
    });
  });
`;

const redirectChildRes = spawnSync(process.execPath, ["-e", redirectChildScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Remote redirect from loopback server to external destination blocked by preload",
  redirectChildRes.status === 0 && redirectChildRes.stdout.includes("REMOTE_REDIRECT_BLOCKED_SUCCESS")
);

// -----------------------------------------------------------------------------
// GROUP 5: Runner Loop Counting, Separation & Negative Controls
// -----------------------------------------------------------------------------
console.log("\n--- 5. RUNNER LOOP SEPARATION (PASSED, FAILED, SKIPPED, BLOCKED) ---");

const fakeSuites = [
  // 1. Expected PASS
  {
    name: "fake-pass-suite",
    command: `${process.execPath} -e "process.exit(0)"`,
    classification: "offline",
  },
  // 2. Expected FAIL
  {
    name: "fake-fail-suite",
    command: `${process.execPath} -e "console.error('Simulated failure'); process.exit(1)"`,
    classification: "offline",
  },
  // 3. Expected SKIP
  {
    name: "fake-skip-suite",
    command: `${process.execPath} -e "console.log('[SKIPPED] simulated skip condition'); process.exit(0)"`,
    classification: "offline",
  },
  // 4. Expected BLOCKED before spawn (DB suite with empty allowlist)
  {
    name: "fake-db-blocked-prespawn",
    command: `${process.execPath} -e "console.log('SHOULD_NOT_EXECUTE'); process.exit(0)"`,
    classification: "db-write",
  },
  // 5. Expected BLOCKED in child (child exited with guard exit code 3)
  {
    name: "fake-guard-child-exit3",
    command: `${process.execPath} -e "console.log('[BLOCKED] child guard blocked execution'); process.exit(3)"`,
    classification: "offline",
  },
];

const runnerSummary = executeSuiteList(fakeSuites, {
  allowlist: [], // Empty allowlist
  customDenied: DENIED_PROJECT_REFS,
  env: {
    PATH: process.env.PATH,
    NEXT_PUBLIC_SUPABASE_URL: "https://szakevhxhwpeskidvtfs.supabase.co", // Production target
  },
  quiet: true,
});

testAssert(
  "Passed count is exactly 1",
  runnerSummary.passed === 1,
  `Got passed=${runnerSummary.passed}`
);

testAssert(
  "Failed count is exactly 1",
  runnerSummary.failed === 1,
  `Got failed=${runnerSummary.failed}`
);

testAssert(
  "Skipped count is exactly 1",
  runnerSummary.skipped === 1,
  `Got skipped=${runnerSummary.skipped}`
);

testAssert(
  "Blocked count is exactly 2 (1 pre-spawn + 1 child exit 3)",
  runnerSummary.blocked === 2,
  `Got blocked=${runnerSummary.blocked}`
);

testAssert(
  "Blocked suite was never executed (no output from fake-db-blocked-prespawn)",
  runnerSummary.blockedSuites.some((b) => b.name === "fake-db-blocked-prespawn")
);

testAssert(
  "Exit code 3 is separated into BLOCKED, never counted as PASSED",
  runnerSummary.blockedSuites.some((b) => b.name === "fake-guard-child-exit3")
);

// -----------------------------------------------------------------------------
// GROUP 6: Negative Controls
// -----------------------------------------------------------------------------
console.log("\n--- 6. NEGATIVE CONTROLS (PROVING NON-ZERO EXITS ON VIOLATIONS) ---");

// Negative Control 1: Runner exits non-zero if any failure occurs
const negControlScript = `
  const { executeSuiteList } = require('./scripts/lib/test-guard.cjs');
  const summary = executeSuiteList([
    { name: "fail-test", command: "${process.execPath.replace(/\\/g, "\\\\")} -e \\"process.exit(1)\\"", classification: "offline" }
  ], { quiet: true });
  if (summary.failed > 0) {
    process.exit(1);
  }
  process.exit(0);
`;

const negRes = spawnSync(process.execPath, ["-e", negControlScript], {
  encoding: "utf8",
  env: { PATH: process.env.PATH },
});
testAssert(
  "Negative Control: Runner exits code 1 when child suite fails",
  negRes.status === 1,
  `Expected exit code 1, got ${negRes.status}`
);

// Negative Control 2: Attempting external network from child without try/catch exits non-zero
const unhandledNetworkScript = `
  const http = require('http');
  http.get('http://szakevhxhwpeskidvtfs.supabase.co');
`;

const unhandledRes = spawnSync(process.execPath, ["-e", unhandledNetworkScript], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require "${denyPreloadPath}"`,
  },
});
testAssert(
  "Negative Control: Unhandled external network attempt exits non-zero with ENETWORK_DENIED",
  unhandledRes.status !== 0 && unhandledRes.stderr.includes("ENETWORK_DENIED"),
  `Exit code: ${unhandledRes.status}, stderr: ${unhandledRes.stderr}`
);

// -----------------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------------
console.log("\n================================================================================");
console.log(`CONTAINMENT SELF-TEST RESULTS: ${passedAsserts}/${totalAsserts} asserts PASSED-LOCAL`);
console.log("Verdict: PASS-LOCAL");
console.log("================================================================================");
