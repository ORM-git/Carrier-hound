/**
 * Call-site test for PostgREST Search Injection in src/lib/api/jobs.ts
 * Calls the real searchJobs function with mocked Supabase client.
 * 
 * Run with: npx tsx scripts/test-search-injection-callsite.ts
 * Negative control: npx tsx scripts/test-search-injection-callsite.ts --negative-control
 */

import { searchJobs } from "../src/lib/api/jobs";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

interface CapturedCall {
  payload: string;
  capturedOrClause: string | null;
  clausesCount: number;
  hasInjectedClause: boolean;
  isSafe: boolean;
  verdict: string;
}

function createMockSupabase(captured: { orClause: string | null }) {
  const chain: any = {
    from: (_table: string) => chain,
    select: (_cols?: any, _opts?: any) => chain,
    eq: (_col: string, _val: any) => chain,
    or: (filterStr: string) => {
      // Record the FIRST or() call which corresponds to the search query 'q'
      if (!captured.orClause) {
        captured.orClause = filterStr;
      }
      return chain;
    },
    ilike: (_col: string, _val: any) => chain,
    in: (_col: string, _vals: any[]) => chain,
    order: (_col: string, _opts?: any) => chain,
    range: (_from: number, _to: number) => Promise.resolve({ data: [], count: 0, error: null }),
    limit: (_n: number) => Promise.resolve({ data: [], error: null }),
    then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
  };
  return chain;
}

async function runAudit() {
  console.log("====================================================================================================");
  console.log("             SEARCH INJECTION CALL-SITE AUDIT (src/lib/api/jobs.ts)                                 ");
  console.log("====================================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Simulating unescaped input to verify detection...");
  }

  const payloads: { name: string; value: string }[] = [
    { name: "x),is_pro.eq.true", value: "x),is_pro.eq.true" },
    { name: "a,or(b.eq.1)", value: "a,or(b.eq.1)" },
    { name: "quote '", value: "'" },
    { name: "comma ,", value: "," },
    { name: "parens ()", value: "()" },
    { name: "%", value: "%" },
    { name: "backslash \\", value: "\\" },
    { name: "*", value: "*" },
    { name: "empty string", value: "" },
    { name: "500-char string", value: "A".repeat(500) },
  ];

  let total = 0;
  let passed = 0;
  let failed = 0;

  for (const item of payloads) {
    total++;
    const captured: { orClause: string | null } = { orClause: null };
    const mockClient = createMockSupabase(captured);

    let testValue = item.value;
    if (IS_NEGATIVE_CONTROL && item.name === "x),is_pro.eq.true") {
      // In negative control, simulate unescaped injection bypassing sanitizer
      captured.orClause = `title.ilike.%${testValue}%,company.ilike.%${testValue}%`;
    } else {
      await searchJobs({ q: testValue }, mockClient);
    }

    const filter = captured.orClause;
    let isSafe = true;
    let clausesCount = 0;
    let hasInjectedClause = false;

    if (filter) {
      const parts = filter.split(",");
      clausesCount = parts.length;

      // In PostgREST, a safe title/company search filter has EXACTLY 2 clauses:
      // title.ilike.%...% and company.ilike.%...%
      // Any comma or paren injected in 'q' splits it into 3+ clauses or introduces extra filter operators.
      const hasUnsafeParen = filter.includes("(") || filter.includes(")");
      const hasUnsafeQuote = filter.includes("'") || filter.includes('"') || filter.includes("`");
      const hasSemicolon = filter.includes(";");
      const hasExtraClauses = clausesCount > 2;

      // Check if any clause does NOT start with title.ilike or company.ilike
      const invalidClause = parts.some(
        (p) => !p.startsWith("title.ilike.") && !p.startsWith("company.ilike.")
      );

      if (hasUnsafeParen || hasUnsafeQuote || hasSemicolon || hasExtraClauses || invalidClause) {
        isSafe = false;
        hasInjectedClause = true;
      }
    } else {
      // If query was empty or sanitized to empty, or() is not called: clausesCount = 0 (Safe)
      clausesCount = 0;
      isSafe = true;
    }

    const verdict = isSafe ? "PASS-LOCAL" : "FAIL";
    if (isSafe) passed++;
    else failed++;

    const dispInput = item.value.length > 25 ? item.value.slice(0, 22) + "..." : item.value;
    const dispFilter = filter
      ? (filter.length > 55 ? filter.slice(0, 52) + "..." : filter)
      : "[or() not invoked]";

    console.log(
      `[PAYLOAD: ${item.name.padEnd(18)}] In: ${dispInput.padEnd(26)} | Captured: ${dispFilter.padEnd(58)} | ${verdict}`
    );
  }

  console.log("\n====================================================================================================");
  console.log(`TEST SUMMARY: ${passed}/${total} test cases passed. Failures: ${failed}`);
  console.log("====================================================================================================");

  if (IS_NEGATIVE_CONTROL) {
    if (failed > 0) {
      console.error("❌ NEGATIVE CONTROL VERIFIED: Test caught unescaped injection and exited non-zero as expected.");
      process.exit(1);
    } else {
      console.error("⚠️ NEGATIVE CONTROL FAILED: Unescaped injection was NOT caught!");
      process.exit(0);
    }
  }

  if (failed > 0) {
    console.error(`❌ TEST SUITE FAILED with ${failed} failures.`);
    process.exit(1);
  }

  console.log("🎉 ALL 10 SEARCH INJECTION PAYLOADS VERIFIED SAFE AGAINST REAL CALL-SITE!");
  process.exit(0);
}

runAudit().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
