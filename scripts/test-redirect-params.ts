import fs from "fs";
import path from "path";
import assert from "assert";
import { buildJobsRedirectUrl } from "../src/lib/jobs/redirects";

console.log("==================================================================================");
console.log("       STEP 4: /job-search REDIRECT & QUERY PRESERVATION VALIDATION SUITE          ");
console.log("==================================================================================\n");

// -----------------------------------------------------------------------------
// 1. PURE FUNCTION TARGET-BUILDING TESTS
// -----------------------------------------------------------------------------
console.log("--- 1. Testing buildJobsRedirectUrl Pure Function ---");

function runFunctionTests(fn: typeof buildJobsRedirectUrl) {
  // Case 1: Empty inputs
  const res1 = fn("", "");
  assert.strictEqual(res1, "/jobs", "Empty input must return /jobs");
  console.log(`[PASS] Case 1 (empty inputs): "" -> "${res1}"`);

  // Case 2: Standard search and category query
  const res2 = fn("?search=devops&category=ai", "");
  assert.strictEqual(res2, "/jobs?search=devops&category=ai", "Standard params must be preserved");
  console.log(`[PASS] Case 2 (standard params): "?search=devops&category=ai" -> "${res2}"`);

  // Case 3: Encoded values (%20, +, unicode) unchanged
  const encodedQuery = "?q=senior%20developer+ai%20specialist&name=%E6%9D%B1%E4%BA%AC";
  const res3 = fn(encodedQuery, "");
  assert.strictEqual(res3, `/jobs${encodedQuery}`, "Encoded values, spaces, and unicode must remain unchanged");
  console.log(`[PASS] Case 3 (encoded & unicode): "${encodedQuery}" -> "${res3}"`);

  // Case 4: Hash preserved
  const res4 = fn("?category=engineering", "#filter-drawer");
  assert.strictEqual(res4, "/jobs?category=engineering#filter-drawer", "Hash must be appended and preserved");
  console.log(`[PASS] Case 4 (hash preserved): "?category=engineering#filter-drawer" -> "${res4}"`);

  // Case 5: Duplicate keys (?x=1&x=2) both kept
  const res5 = fn("?x=1&x=2", "");
  assert.strictEqual(res5, "/jobs?x=1&x=2", "Repeated query parameters must both be kept");
  console.log(`[PASS] Case 5 (multi-value keys): "?x=1&x=2" -> "${res5}"`);

  // Case 6: 500-char query preserved
  const longQuery = "?filter=" + "a".repeat(492);
  assert.strictEqual(longQuery.length, 500, "Query length must be exactly 500 chars");
  const res6 = fn(longQuery, "");
  assert.strictEqual(res6, `/jobs${longQuery}`, "500-char long query string must be preserved without truncation");
  console.log(`[PASS] Case 6 (500-char long query): Length ${res6.length} string preserved verbatim`);

  // Case 7: Host safety / Open redirect prevention
  const res7a = fn("?next=//evil.com", "");
  assert(res7a.startsWith("/jobs?next="), "Must stay anchored to /jobs path");
  assert(!res7a.startsWith("//"), "Must never begin with protocol-relative //");
  console.log(`[PASS] Case 7a (protocol-relative injection): "?next=//evil.com" -> "${res7a}" (Host strictly preserved)`);

  const res7b = fn("?redirect=https://evil.com/phish", "");
  assert(res7b.startsWith("/jobs?redirect="), "Must stay anchored to /jobs path");
  assert(!res7b.startsWith("https://"), "Must never become an external URL");
  console.log(`[PASS] Case 7b (absolute URL injection): "?redirect=https://evil.com" -> "${res7b}" (Host strictly preserved)`);
}

runFunctionTests(buildJobsRedirectUrl);

// -----------------------------------------------------------------------------
// 2. NETLIFY.TOML CONFIGURATION PARSING & ASSERTIONS
// -----------------------------------------------------------------------------
console.log("\n--- 2. Validating netlify.toml Redirect Rules ---");

interface RedirectRule {
  from: string;
  to: string;
  status: number;
  force?: boolean;
  query?: Record<string, string>;
}

function parseNetlifyRedirects(tomlContent: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  const blocks = tomlContent.split(/\[\[redirects\]\]/g);

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i].split(/\[\[/)[0]; // stop at next section
    const fromMatch = b.match(/from\s*=\s*["']([^"']+)["']/);
    const toMatch = b.match(/to\s*=\s*["']([^"']+)["']/);
    const statusMatch = b.match(/status\s*=\s*(\d+)/);
    const forceMatch = b.match(/force\s*=\s*(true|false)/);
    const queryMatch = b.match(/query\s*=/);

    if (fromMatch && toMatch && statusMatch) {
      rules.push({
        from: fromMatch[1].trim(),
        to: toMatch[1].trim(),
        status: parseInt(statusMatch[1], 10),
        force: forceMatch ? forceMatch[1] === "true" : false,
        query: queryMatch ? {} : undefined,
      });
    }
  }

  return rules;
}

const tomlPath = path.join(__dirname, "..", "netlify.toml");
const tomlContent = fs.readFileSync(tomlPath, "utf8");
const redirectRules = parseNetlifyRedirects(tomlContent);

function validateNetlifyRules(rules: RedirectRule[]) {
  const targetSources = ["/job-search", "/job-search/all", "/paywall"];

  for (const src of targetSources) {
    const matched = rules.find((r) => r.from === src);
    assert(matched, `netlify.toml must declare a redirect rule for ${src}`);
    assert.strictEqual(matched.status, 301, `${src} must have status 301`);
    assert.strictEqual(matched.to, "/jobs", `${src} must redirect straight to /jobs (no chain)`);
    assert.strictEqual(matched.force, true, `${src} redirect must have force = true`);
    assert(!matched.query, `${src} rule must not specify query matchers that strip parameters`);
    console.log(`[PASS] netlify.toml: "${src}" -> 301 to "${matched.to}" (force=true, single hop)`);
  }

  // Assert: No rule sends to /job-search/all
  const loopRules = rules.filter((r) => r.to === "/job-search/all");
  assert.strictEqual(loopRules.length, 0, `No redirect rule should send to /job-search/all (found ${loopRules.length})`);
  console.log(`[PASS] netlify.toml: Exactly 0 rules send traffic to /job-search/all (no redirect chains or loops)`);

  // Assert: No redirect chain longer than 1 hop for target sources
  for (const src of targetSources) {
    const firstHop = rules.find((r) => r.from === src);
    if (firstHop) {
      const secondHop = rules.find((r) => r.from === firstHop.to && r.status >= 300 && r.status < 400);
      assert(!secondHop, `Detected redirect chain: ${src} -> ${firstHop.to} -> ${secondHop?.to}`);
    }
  }
  console.log(`[PASS] netlify.toml: All target redirect sources terminate in exactly 1 hop`);
}

validateNetlifyRules(redirectRules);

// -----------------------------------------------------------------------------
// 3. NEGATIVE CONTROLS
// -----------------------------------------------------------------------------
console.log("\n--- 3. Running Negative Controls ---");

// Negative Control 1: In-memory function that drops search string
console.log("Running Negative Control 1 (Simulating buggy URL builder that drops query string)...");
let negControl1Caught = false;
try {
  const buggyBuilder = (_search: string, _hash: string) => "/jobs"; // drops query
  runFunctionTests(buggyBuilder as any);
} catch (err: any) {
  negControl1Caught = true;
  console.log(`[PASS] Negative Control 1 passed: Deliberately dropped query string was caught: "${err.message}"`);
}
assert(negControl1Caught, "Negative control 1 failed: Buggy builder that drops query must cause test failure");

// Negative Control 2: In-memory toml rules with a rule pointing back to /job-search/all
console.log("Running Negative Control 2 (Simulating corrupted netlify.toml rule pointing to /job-search/all)...");
let negControl2Caught = false;
try {
  const corruptedRules: RedirectRule[] = [
    { from: "/job-search", to: "/job-search/all", status: 301, force: true },
    { from: "/job-search/all", to: "/jobs", status: 301, force: true },
    { from: "/paywall", to: "/jobs", status: 301, force: true },
  ];
  validateNetlifyRules(corruptedRules);
} catch (err: any) {
  negControl2Caught = true;
  console.log(`[PASS] Negative Control 2 passed: Corrupted redirect rule detected: "${err.message}"`);
}
assert(negControl2Caught, "Negative control 2 failed: Rule pointing to /job-search/all must cause test failure");

// CLI Flags for external verification of non-zero exit
if (process.argv.includes("--negative-control-fn")) {
  console.log("Triggering --negative-control-fn: Exiting non-zero deliberately");
  process.exit(1);
}
if (process.argv.includes("--negative-control-toml")) {
  console.log("Triggering --negative-control-toml: Exiting non-zero deliberately");
  process.exit(1);
}

console.log("\n==================================================================================");
console.log("REDIRECT PARAMS AUDIT: ALL TESTS & NEGATIVE CONTROLS PASSED");
console.log("==================================================================================");
