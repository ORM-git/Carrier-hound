/**
 * Offline test for Slow Query Visibility, Aggregation & Redaction (Database sheet: Slow-query log).
 *
 * Verifies:
 * - redactAndTruncateQuery strips single-quoted strings, numeric literals, UUIDs, hex, parameters, comments.
 * - redactAndTruncateQuery strips PostgreSQL dollar-quoted literals ($$...$$ and $tag$...$tag$).
 * - redactAndTruncateQuery strictly truncates query strings within max length (output length <= maxLen).
 * - aggregateSlowQueries sorts descending by total_ms and selects top 10.
 * - Internal pg_stat_statements queries are excluded.
 * - probeSlowQueries fails loudly when the get_slow_queries RPC is missing (e.g. HTTP 404).
 * - Negative control option exits with non-zero code.
 *
 * Run: npx tsx scripts/test-db-slow-queries.ts
 * Negative control: npx tsx scripts/test-db-slow-queries.ts --negative-control
 */

import {
  redactAndTruncateQuery,
  aggregateSlowQueries,
  probeSlowQueries,
  RawSlowQueryEntry,
} from "../src/lib/health/slowQueries";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("Running negative control check...");
    check("negative control: forced assertion failure", false);
    process.exit(1);
  }

  // --- 1. Redaction Tests ---
  console.log("1. Query Parameter Redaction & Sanitization Tests");

  // 1a. String literal redaction
  const qString = "SELECT * FROM public.users WHERE email = 'candidate@secret.com' AND name = 'Alice';";
  const redactedString = redactAndTruncateQuery(qString);
  check("redacts email string literal", !redactedString.includes("candidate@secret.com"));
  check("redacts name string literal", !redactedString.includes("Alice"));
  check("replaces strings with '?'", redactedString.includes("email = '?'") && redactedString.includes("name = '?'"));

  // 1b. Escaped single quotes
  const qEscaped = "UPDATE notes SET content = 'It''s dangerous to go alone' WHERE id = 'xyz';";
  const redactedEscaped = redactAndTruncateQuery(qEscaped);
  check("redacts strings with escaped quotes", !redactedEscaped.includes("dangerous"));
  check("replaces escaped quote string with '?'", redactedEscaped.includes("content = '?'"));

  // 1c. PostgreSQL Dollar-Quoted String Literals ($$...$$ and $tag$...$tag$)
  const qDollarQuotes =
    "SELECT * FROM users WHERE email = $$private.person@example.com$$ AND notes = $tag$confidential$tag$ AND payload = $body$some secret data $1$body$;";
  const redactedDollarQuotes = redactAndTruncateQuery(qDollarQuotes);
  check("dollar-quoted: strips $$private.person@example.com$$", !redactedDollarQuotes.includes("private.person@example.com"));
  check("dollar-quoted: strips $tag$confidential$tag$", !redactedDollarQuotes.includes("confidential"));
  check("dollar-quoted: strips custom tag $body$some secret data $1$body$", !redactedDollarQuotes.includes("some secret data"));
  check(
    "dollar-quoted: replaces dollar-quoted string literals with '?'",
    redactedDollarQuotes === "SELECT * FROM users WHERE email = '?' AND notes = '?' AND payload = '?';"
  );

  // 1d. Integer & float numeric literal redaction
  const qNumbers = "SELECT * FROM jobs WHERE salary_min >= 120000 AND score > 4.75 LIMIT 25 OFFSET 100;";
  const redactedNumbers = redactAndTruncateQuery(qNumbers);
  check("strips integer salary", !redactedNumbers.includes("120000"));
  check("strips float score", !redactedNumbers.includes("4.75"));
  check("strips limit & offset", !redactedNumbers.includes("25") && !redactedNumbers.includes("100"));
  check("replaces numbers with '?'", redactedNumbers === "SELECT * FROM jobs WHERE salary_min >= ? AND score > ? LIMIT ? OFFSET ?;");

  // 1e. UUID and Hex redaction
  const qUuid = "SELECT * FROM profiles WHERE user_id = 'c73bcdcc-2669-4bf6-81d3-e4ae73fb11ec' OR hash = 0xDEADBEEF;";
  const redactedUuid = redactAndTruncateQuery(qUuid);
  check("strips full UUID literal", !redactedUuid.includes("c73bcdcc"));
  check("strips hex literal", !redactedUuid.includes("0xDEADBEEF") && !redactedUuid.includes("DEADBEEF"));

  // 1f. Parameter placeholders ($1, $2, etc.)
  const qParams = "SELECT title, company FROM jobs WHERE location ILIKE $1 AND remote = $2;";
  const redactedParams = redactAndTruncateQuery(qParams);
  check("normalizes $1 and $2 to ?", redactedParams === "SELECT title, company FROM jobs WHERE location ILIKE ? AND remote = ?;");

  // 1g. SQL Comments removal
  const qComments = "/* Sensitive audit trace */ SELECT * FROM payments WHERE amount > 50; -- internal note";
  const redactedComments = redactAndTruncateQuery(qComments);
  check("strips block comments", !redactedComments.includes("Sensitive audit trace"));
  check("strips line comments", !redactedComments.includes("internal note"));
  check("cleans query structure", redactedComments === "SELECT * FROM payments WHERE amount > ?;");

  // 1h. Truncation Tests: Output MUST NEVER exceed the limit (e.g. 120 must never produce 123)
  const qLong150 =
    "SELECT id, title, company, description, apply_url, salary_min, salary_max, skills, posted_at, first_seen_at FROM jobs WHERE company = 'Very Long Company Name In Silicon Valley That Goes On And On';";

  const redacted120 = redactAndTruncateQuery(qLong150, 120);
  check("truncates long query with trailing ellipsis", redacted120.endsWith("..."));
  check(
    `truncation strictly obeys maxLen 120 (measured: ${redacted120.length})`,
    redacted120.length <= 120
  );
  check("truncation with maxLen 120 does not return 123", redacted120.length !== 123);

  const redacted80 = redactAndTruncateQuery(qLong150, 80);
  check(`truncation strictly obeys maxLen 80 (measured: ${redacted80.length})`, redacted80.length <= 80);

  const redacted50 = redactAndTruncateQuery(qLong150, 50);
  check(`truncation strictly obeys maxLen 50 (measured: ${redacted50.length})`, redacted50.length <= 50);

  // Short query within limit is not truncated
  const qShort = "SELECT id FROM jobs WHERE id = 1;";
  const redactedShort = redactAndTruncateQuery(qShort, 120);
  check("short query within limit is not modified with ellipsis", !redactedShort.endsWith("..."));
  check("short query length <= 120", redactedShort.length <= 120);

  // --- 2. Aggregation Tests ---
  console.log("\n2. Slow Query Aggregation Tests (Top 10 by Total Time)");

  const fixtureQueries: RawSlowQueryEntry[] = [
    { query: "SELECT * FROM jobs WHERE id = 1", calls: 100, total_exec_time: 1500.5, mean_exec_time: 15.0, max_exec_time: 45.2 },
    { query: "SELECT * FROM pg_stat_statements", calls: 50, total_exec_time: 99999.0, mean_exec_time: 1999.0, max_exec_time: 5000.0 }, // internal, must be dropped
    { query: "SELECT * FROM candidate_profiles WHERE user_id = 2", calls: 10, total_exec_time: 3200.0, mean_exec_time: 320.0, max_exec_time: 800.0 },
    { query: "SELECT * FROM applications WHERE status = 'submitted'", calls: 80, total_exec_time: 500.2, mean_exec_time: 6.2, max_exec_time: 20.0 },
    { query: "SELECT * FROM page_views WHERE path = '/jobs'", calls: 500, total_exec_time: 2100.8, mean_exec_time: 4.2, max_exec_time: 15.0 },
    { query: "SELECT * FROM subscriptions WHERE status = 'active'", calls: 20, total_exec_time: 120.4, mean_exec_time: 6.0, max_exec_time: 12.0 },
    { query: "SELECT count(*) FROM companies", calls: 5, total_exec_time: 80.0, mean_exec_time: 16.0, max_exec_time: 25.0 },
    { query: "SELECT * FROM funnel_events WHERE event = 'apply'", calls: 30, total_exec_time: 450.0, mean_exec_time: 15.0, max_exec_time: 35.0 },
    { query: "SELECT * FROM early_access_emails", calls: 2, total_exec_time: 15.0, mean_exec_time: 7.5, max_exec_time: 10.0 },
    { query: "SELECT * FROM cron_run_logs WHERE status = 'failed'", calls: 4, total_exec_time: 40.0, mean_exec_time: 10.0, max_exec_time: 15.0 },
    { query: "SELECT * FROM blocked_users WHERE ip = '127.0.0.1'", calls: 1, total_exec_time: 5.0, mean_exec_time: 5.0, max_exec_time: 5.0 },
    { query: "SELECT * FROM addon_packs", calls: 1, total_exec_time: 2.0, mean_exec_time: 2.0, max_exec_time: 2.0 },
    { query: "SELECT * FROM job_descriptions WHERE id = 3", calls: 200, total_exec_time: 4200.5, mean_exec_time: 21.0, max_exec_time: 90.0 },
  ];

  const top10 = aggregateSlowQueries(fixtureQueries, 10);
  check("returns exactly 10 queries", top10.length === 10);
  check("internal pg_stat_statements query is excluded", !top10.some((q) => q.query.includes("pg_stat_statements")));
  check("top query has highest total_ms", top10[0].total_ms === 4200.5);
  check("second query has second highest total_ms", top10[1].total_ms === 3200.0);
  check("third query has third highest total_ms", top10[2].total_ms === 2100.8);
  check("queries are sorted descending by total_ms", top10.every((q, i) => i === 0 || top10[i - 1].total_ms >= q.total_ms));
  check("top query text is redacted and parameter-stripped", top10[0].query === "SELECT * FROM job_descriptions WHERE id = ?");
  check("query with string literal is redacted", top10.find((q) => q.calls === 80)?.query === "SELECT * FROM applications WHERE status = '?'");

  // 2b. Resilient handling of malformed and empty inputs
  check("handles empty array", aggregateSlowQueries([]).length === 0);
  check("handles non-array input", aggregateSlowQueries(null).length === 0);
  check("handles entries with string numbers", aggregateSlowQueries([{ query: "SELECT 1", calls: "10", total_ms: "55.5" }])[0].total_ms === 55.5);

  // --- 3. Missing RPC Failure Visibility Tests ---
  console.log("\n3. Missing / Failing RPC Behavior Tests");

  // 3a. Missing RPC returns HTTP 404 -> probeSlowQueries MUST throw visibly
  let threw404 = false;
  let errorMsg404 = "";
  const mockFetcher404: typeof fetch = async () =>
    new Response("PGRST202: Could not find the function get_slow_queries in the schema cache", {
      status: 404,
      statusText: "Not Found",
    });

  try {
    await probeSlowQueries("https://mock-project.supabase.co", "mock-service-key", mockFetcher404);
  } catch (err: any) {
    threw404 = true;
    errorMsg404 = err?.message || "";
  }
  check("missing RPC (404) throws error instead of silently returning []", threw404);
  check("error message names HTTP 404 status", errorMsg404.includes("404"));

  // 3b. Failing RPC returns HTTP 500 -> probeSlowQueries MUST throw visibly
  let threw500 = false;
  const mockFetcher500: typeof fetch = async () =>
    new Response("Internal Database Error", { status: 500, statusText: "Internal Server Error" });

  try {
    await probeSlowQueries("https://mock-project.supabase.co", "mock-service-key", mockFetcher500);
  } catch {
    threw500 = true;
  }
  check("failing RPC (500) throws error instead of silently returning []", threw500);

  // 3c. Successful RPC with mock data returns top summaries
  const mockFetcher200: typeof fetch = async () =>
    new Response(JSON.stringify([{ query: "SELECT * FROM users WHERE id = 123", calls: 5, total_ms: 100 }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const successResult = await probeSlowQueries("https://mock-project.supabase.co", "mock-service-key", mockFetcher200);
  check("successful RPC returns aggregated results", successResult.length === 1 && successResult[0].calls === 5);
  check("successful RPC result is redacted", successResult[0].query === "SELECT * FROM users WHERE id = ?");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
