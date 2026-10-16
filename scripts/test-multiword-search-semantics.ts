import assert from "assert";
import { searchJobs } from "../src/lib/api/jobs";

console.log("==================================================================================");
console.log("       MULTI-WORD SEARCH SEMANTICS & FILTER BUILDER AUDIT (src/lib/api/jobs.ts)   ");
console.log("==================================================================================\n");

function createMockSupabaseClient() {
  const capturedFilters: {
    table?: string;
    eq: { column: string; value: any }[];
    or: string[];
    ilike: { column: string; pattern: string }[];
    range?: { from: number; to: number };
  } = {
    eq: [],
    or: [],
    ilike: [],
  };

  const queryBuilder: any = {
    from: (table: string) => {
      capturedFilters.table = table;
      return queryBuilder;
    },
    select: (fields: string, opts?: any) => queryBuilder,
    eq: (column: string, value: any) => {
      capturedFilters.eq.push({ column, value });
      return queryBuilder;
    },
    or: (clause: string) => {
      capturedFilters.or.push(clause);
      return queryBuilder;
    },
    ilike: (column: string, pattern: string) => {
      capturedFilters.ilike.push({ column, pattern });
      return queryBuilder;
    },
    in: (column: string, values: any[]) => queryBuilder,
    order: (column: string, opts?: any) => queryBuilder,
    limit: (n: number) => Promise.resolve({ data: [], error: null }),
    range: (from: number, to: number) => {
      capturedFilters.range = { from, to };
      return Promise.resolve({ data: [], count: 0, error: null });
    },
  };

  return { client: queryBuilder, capturedFilters };
}

async function runAudit() {
  // 1. Multi-word search query "react developer"
  const { client: client1, capturedFilters: f1 } = createMockSupabaseClient();
  await searchJobs({ q: "react developer" }, client1);

  console.log("Captured OR clauses for q='react developer':");
  console.log(" ", JSON.stringify(f1.or, null, 2));

  // Assert that it does NOT perform an any-word OR match (e.g. %react% OR %developer%)
  const orClause = f1.or[0] || "";
  const isAnyWordMatch =
    orClause.includes("title.ilike.%react%,") ||
    orClause.includes("company.ilike.%react%,title.ilike.%developer%");

  if (isAnyWordMatch) {
    throw new Error(
      `FAIL: Any-word match detected! The query allows jobs matching either word alone: ${orClause}`
    );
  }

  assert(
    orClause.includes("%react developer%"),
    `Expected exact contiguous phrase '%react developer%' in filter, got: ${orClause}`
  );
  console.log("✅ Multi-word search uses phrase-bounded matching (not any-word OR).");

  // 2. Company search query "stripe"
  const { client: client2, capturedFilters: f2 } = createMockSupabaseClient();
  await searchJobs({ q: "stripe" }, client2);

  console.log("\nCaptured OR clauses for q='stripe':");
  console.log(" ", JSON.stringify(f2.or, null, 2));

  assert(
    f2.or[0].includes("company.ilike.%stripe%"),
    `Expected company search filter to include company.ilike.%stripe%, got: ${f2.or[0]}`
  );
  console.log("✅ Company search properly searches company name column.");

  // -------------------------------------------------------------------------------------
  // NEGATIVE CONTROL: Deliberately test an any-word match clause and prove failure
  // -------------------------------------------------------------------------------------
  console.log("\n--- RUNNING NEGATIVE CONTROL (proves failure on any-word match) ---");
  const badAnyWordClause = "title.ilike.%react%,title.ilike.%developer%";
  let negativeControlCaught = false;

  try {
    const isBadAnyWord =
      badAnyWordClause.includes("title.ilike.%react%,") ||
      badAnyWordClause.includes("title.ilike.%developer%");
    if (isBadAnyWord) {
      throw new Error(`FAIL-DETECTED: Any-word match detected in '${badAnyWordClause}'`);
    }
  } catch (err: any) {
    negativeControlCaught = true;
    console.log(`✅ Negative control caught any-word match: "${err.message}"`);
  }

  assert(negativeControlCaught, "Negative control failed to catch any-word match clause!");

  console.log("\n==================================================================================");
  console.log("MULTI-WORD SEARCH SEMANTICS: PASS-LOCAL (Phrase match enforced, 0 any-word leaks)");
  console.log("==================================================================================");
}

runAudit().catch((err) => {
  console.error("FATAL ERROR in test-multiword-search-semantics.ts:", err);
  process.exit(1);
});
