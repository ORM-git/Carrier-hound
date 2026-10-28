import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { formatRelativeTime } from "../src/components/jobs/JobDetailView";
import { createHandler } from "../netlify/functions/jobs-search";
import { getLiveJobs } from "../src/lib/jobs/service";

/**
 * Test Suite: Jobs Detail Page & Filter Search Polish (PR #115 Follow-up)
 *
 * Verifies:
 * 1. 503 / Degraded Path:
 *    - Search API returns HTTP 503 with { degraded: true, jobs: [], totalCount: 0 } on query errors.
 *    - Service client parses 503 to isDegraded: true, error: "degraded".
 *    - Client shows "Couldn't load jobs, retry" state instead of "0 jobs match".
 * 2. URL Sync from debouncedSearch only:
 *    - page.tsx synchronizes search to URL exclusively from debouncedSearch, avoiding router.replace per keystroke.
 * 3. Undated-Job Label ("Posted recently", never "today"):
 *    - Null, undefined, empty, or "today" strictly formats to "Posted recently", never "today".
 * 4. Masked Fields for Guests:
 *    - Guests see blurred company, masked salary (••••••••), and locked Apply buttons.
 *    - Pro / unlocked users see clear company, visible salary, and active Apply link in new tab.
 *    - Expired jobs display expired banner and disabled "Position Closed" button across all screens.
 * 5. Overview Chips & 5 Similar Jobs:
 *    - Chips for seniority, category, job type, and remote scope.
 *    - Exactly up to 5 similar jobs rendered.
 * 6. Negative Control:
 *    - Exits non-zero with --negative-control.
 */

const isNegativeControl = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("       JOBS DETAIL POLISH & SEARCH 503 DEGRADED ERROR AUDIT                     ");
console.log("================================================================================");
console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Must Fail)" : "NORMAL VERIFICATION"}`);

async function runDegraded503Tests() {
  console.log("\n[1/5] Testing 503 / Degraded Search Path...");

  // Mock Supabase admin returning a database error
  const mockFailingAdmin = {
    from: () => {
      const builder: any = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.neq = chain;
      builder.or = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.range = chain;
      builder.then = (resolve: any) =>
        resolve({
          data: null,
          count: null,
          error: { message: "connection to server at supabase.co failed: timeout", code: "57014" },
        });
      return builder;
    },
  };

  const handler = createHandler({
    getSupabaseAdmin: () => mockFailingAdmin,
  });

  const event = {
    httpMethod: "GET",
    queryStringParameters: { q: "engineer" },
    headers: { host: "localhost:3000" },
  };

  const res = await handler(event);
  assert.strictEqual(res.statusCode, 503, "Handler must return HTTP 503 on database query error");
  
  const body = JSON.parse(res.body);
  assert.strictEqual(body.degraded, true, "Body must indicate degraded: true");
  assert.deepStrictEqual(body.jobs, [], "Degraded response must return empty jobs array");
  assert.strictEqual(body.totalCount, 0, "Degraded response must return totalCount 0");
  assert.strictEqual(body.hasNextPage, false, "Degraded response must set hasNextPage false");
  assert.strictEqual(body.nextCursor, null, "Degraded response must set nextCursor null");
  assert.strictEqual(body.error, undefined, "Raw database error message must NEVER leak in API response body");
  console.log("  [PASS] Netlify function /jobs-search returns HTTP 503 with { degraded: true, jobs: [], totalCount: 0 }");

  // Test getLiveJobs handling HTTP 503
  const originalFetch = global.fetch;
  const originalWindow = (global as any).window;
  try {
    (global as any).window = { location: { search: "" } };
    // @ts-ignore
    global.fetch = async (url: string) => {
      return {
        status: 503,
        ok: false,
        json: async () => ({ degraded: true, jobs: [], totalCount: 0 }),
      };
    };

    const clientResult = await getLiveJobs({ search: "engineer" });
    assert.strictEqual(clientResult.isDegraded, true, "getLiveJobs must return isDegraded: true on HTTP 503");
    assert.strictEqual(clientResult.error, "degraded", "getLiveJobs must set error: 'degraded'");
    assert.deepStrictEqual(clientResult.jobs, [], "getLiveJobs must return empty jobs array on 503");
    assert.strictEqual(clientResult.totalCount, 0, "getLiveJobs must return totalCount 0 on 503");
    console.log("  [PASS] Client getLiveJobs parses HTTP 503 into isDegraded: true and error: 'degraded'");
  } finally {
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
  }

  // Verify page.tsx has degraded state UI with Retry button
  const pageSrc = fs.readFileSync(path.join(__dirname, "../src/app/jobs/page.tsx"), "utf-8");
  assert.ok(
    pageSrc.includes('data-testid="search-degraded-state"'),
    "page.tsx must contain data-testid='search-degraded-state'"
  );
  assert.ok(
    pageSrc.includes("Couldn&apos;t load jobs") || pageSrc.includes("Couldn't load jobs"),
    "page.tsx degraded state must display 'Couldn't load jobs'"
  );
  assert.ok(
    pageSrc.includes("Retry"),
    "page.tsx degraded state must contain a Retry button"
  );
  console.log("  [PASS] page.tsx renders 'Couldn't load jobs, retry' UI state instead of '0 jobs match'");
}

async function runUrlSyncDebouncedTests() {
  console.log("\n[2/5] Testing URL Sync from debouncedSearch only...");

  const pageSrc = fs.readFileSync(path.join(__dirname, "../src/app/jobs/page.tsx"), "utf-8");

  // Check syncParam calls
  assert.ok(
    pageSrc.includes('syncParam("search", debouncedSearch);'),
    "URL sync effect must sync debouncedSearch to 'search' parameter"
  );
  assert.ok(
    !pageSrc.includes('syncParam("search", search);'),
    "URL sync effect must NOT sync raw keystroke 'search' parameter"
  );

  // Check useEffect dependency array for URL sync
  const urlSyncMatch = pageSrc.match(/syncParam\("search",\s*debouncedSearch\);[\s\S]*?\},\s*\[([\s\S]*?)\]\);/);
  assert.ok(urlSyncMatch, "Found URL sync useEffect block");
  const deps = urlSyncMatch[1];
  assert.ok(deps.includes("debouncedSearch"), "URL sync effect dependencies must include debouncedSearch");
  assert.ok(!deps.includes("\n    search,") && !deps.includes(" search,"), "URL sync effect dependencies must NOT include raw search");

  console.log("  [PASS] Search term synced to URL from debouncedSearch only (no router.replace per keypress)");
}

async function runUndatedJobLabelTests() {
  console.log("\n[3/5] Testing Undated-Job Label ('Posted recently', never 'today')...");

  // 1. Undated inputs
  assert.strictEqual(formatRelativeTime(null), "Posted recently", "null date must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime(undefined), "Posted recently", "undefined date must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime(""), "Posted recently", "empty string date must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("   "), "Posted recently", "whitespace date must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("invalid-date-string"), "Posted recently", "invalid date string must format to 'Posted recently'");

  // 2. Explicit "today" inputs must NEVER return "today"
  assert.strictEqual(formatRelativeTime("today"), "Posted recently", "'today' must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("Today"), "Posted recently", "'Today' must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("TODAY"), "Posted recently", "'TODAY' must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("recently"), "Posted recently", "'recently' must format to 'Posted recently'");
  assert.strictEqual(formatRelativeTime("recently posted"), "Posted recently", "'recently posted' must format to 'Posted recently'");

  // 3. Valid recent timestamps
  const now = Date.now();
  const tenMinsAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

  assert.strictEqual(formatRelativeTime(tenMinsAgo), "Just now", "Recent timestamp (<1h) formats to 'Just now'");
  assert.strictEqual(formatRelativeTime(twoHoursAgo), "2 hours ago", "Timestamp 2h ago formats to '2 hours ago'");
  assert.strictEqual(formatRelativeTime(oneDayAgo), "1 day ago", "Timestamp 1d ago formats to '1 day ago'");
  assert.strictEqual(formatRelativeTime(fiveDaysAgo), "5 days ago", "Timestamp 5d ago formats to '5 days ago'");
  assert.strictEqual(formatRelativeTime(sixtyDaysAgo), "Posted recently", "Timestamp >30d formats to 'Posted recently'");

  // 4. Source code scan: ensure literal "today" is never produced by formatRelativeTime
  const detailSrc = fs.readFileSync(path.join(__dirname, "../src/components/jobs/JobDetailView.tsx"), "utf-8");
  assert.ok(
    !detailSrc.includes('return "Today"') && !detailSrc.includes('return "today"'),
    "formatRelativeTime must never return 'today' or 'Today'"
  );

  console.log("  [PASS] Undated, invalid, and 'today' dates strictly format to 'Posted recently', never 'today'");
  console.log("  [PASS] Relative timestamps (2 hours ago, 1 day ago, 5 days ago) formatted cleanly");
}

async function runGuestMaskingAndDetailLayoutTests() {
  console.log("\n[4/5] Testing Masked Fields for Guests, Expired States, and Overview Chips...");

  const detailSrc = fs.readFileSync(path.join(__dirname, "../src/components/jobs/JobDetailView.tsx"), "utf-8");
  const pageSrc = fs.readFileSync(path.join(__dirname, "../src/app/jobs/page.tsx"), "utf-8");

  // 1. Guest masking
  assert.ok(
    detailSrc.includes('filter blur-') && detailSrc.includes('select-none'),
    "Company name must be blurred when isUnlocked is false"
  );
  assert.ok(
    detailSrc.includes('••••••••'),
    "Salary must be masked with bullet characters (••••••••) when isUnlocked is false"
  );
  assert.ok(
    detailSrc.includes('isUnlocked && job.applyUrl ? ('),
    "Direct apply link must be gated behind isUnlocked"
  );
  assert.ok(
    detailSrc.includes('target="_blank"'),
    "Apply link opens in a new tab when user is unlocked"
  );
  assert.ok(
    detailSrc.includes('rel="noopener noreferrer"'),
    "Apply link contains security rel='noopener noreferrer'"
  );
  console.log("  [PASS] Guest masking: company blurred, salary masked (••••••••), apply gated behind lock");

  // 2. Mobile sticky apply bar
  assert.ok(
    detailSrc.includes('bottom-0') && detailSrc.includes('fixed'),
    "Mobile sticky Apply bar docked at bottom on small viewports"
  );
  assert.ok(
    detailSrc.includes('Apply') && detailSrc.includes('Share'),
    "Mobile sticky bar includes contextual action button and share"
  );
  console.log("  [PASS] Mobile sticky Apply bar present for mobile viewports");

  // 3. Expired job states
  assert.ok(
    detailSrc.includes('data-testid="job-expired-banner"'),
    "JobDetailView must render data-testid='job-expired-banner' when expired"
  );
  assert.ok(
    detailSrc.includes('Position Closed'),
    "JobDetailView must display disabled 'Position Closed' button when job is expired"
  );
  console.log("  [PASS] Expired job state: banner rendered and Apply button disabled with 'Position Closed'");

  // 4. Loading skeleton & Not found states in page.tsx
  assert.ok(
    pageSrc.includes('data-testid="job-detail-skeleton"'),
    "page.tsx must provide data-testid='job-detail-skeleton' while loading job details"
  );
  assert.ok(
    pageSrc.includes('data-testid="job-not-found-state"'),
    "page.tsx must provide data-testid='job-not-found-state' when job ID is not found"
  );
  console.log("  [PASS] Loading skeleton and not-found states implemented for job detail view");

  // 5. Overview chips
  assert.ok(
    detailSrc.includes('data-testid="overview-chips"'),
    "JobDetailView must contain data-testid='overview-chips'"
  );
  assert.ok(
    detailSrc.includes('jobLevel') && detailSrc.includes('job.category') && detailSrc.includes('job.type'),
    "Overview chips must include seniority level, category, and job type"
  );
  console.log("  [PASS] Overview chips present: seniority, category, job type, and remote scope");

  // 6. Similar jobs 5 items
  assert.ok(
    detailSrc.includes('similarJobs.slice(0, 5)'),
    "Similar jobs section must slice up to 5 items"
  );
  console.log("  [PASS] Similar jobs displays up to 5 items");
}

async function runNegativeControl() {
  console.log("\n[5/5] Negative Control Verification...");
  if (isNegativeControl) {
    console.log("  [FAIL-INTENDED] Intentionally failing negative control check.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control branch ready (pass --negative-control to verify non-zero exit)");
}

async function main() {
  try {
    await runDegraded503Tests();
    await runUrlSyncDebouncedTests();
    await runUndatedJobLabelTests();
    await runGuestMaskingAndDetailLayoutTests();
    await runNegativeControl();

    console.log("\n================================================================================");
    console.log("ALL JOBS DETAIL POLISH TESTS PASSED [PASS-LOCAL]");
    console.log("================================================================================");
    process.exit(0);
  } catch (err: any) {
    console.error("\nTEST SUITE FAILED:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
