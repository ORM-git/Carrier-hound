/**
 * CareerMonke AI Quota Fail-Closed Test Suite
 * Validates fail-closed behavior on store throws, timeouts, and garbage data.
 * 
 * Run with: npx tsx scripts/test-quota-failclosed.ts
 * Run negative control: npx tsx scripts/test-quota-failclosed.ts --negative-control
 */

import { checkAndIncrementAiQuota, OPERATION_CONFIGS } from "../src/lib/ai/security";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

function createMockSupabase(scenario: "under-cap" | "at-cap" | "throws" | "timeout" | "garbage") {
  if (scenario === "throws") {
    return {
      from: (_table: string) => {
        throw new Error("PGRST500: Database connection failure / pool exhausted");
      },
    } as any;
  }

  if (scenario === "timeout") {
    return {
      from: (_table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.reject(new Error("Timeout: Query exceeded 5000ms")),
              }),
            }),
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.reject(new Error("Timeout: Query exceeded 5000ms")),
              }),
            }),
          }),
        }),
      }),
    } as any;
  }

  if (scenario === "garbage") {
    return {
      from: (table: string) => {
        if (table === "ai_usage_quotas") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: { count: "not-a-number", corrupt: true }, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: { metadata: null }, error: new Error("Corrupt JSONB") }),
                }),
              }),
            }),
          }),
        };
      },
    } as any;
  }

  if (scenario === "at-cap") {
    return {
      from: (table: string) => {
        if (table === "ai_usage_quotas") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({ data: { count: 30, total_tokens: 15000 }, error: null }),
                  }),
                }),
              }),
            }),
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {
          select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
        };
      },
    } as any;
  }

  // under-cap (count = 12)
  return {
    from: (table: string) => {
      if (table === "ai_usage_quotas") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { count: 12, total_tokens: 6000 }, error: null }),
                }),
              }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
      };
    },
  } as any;
}

async function runTestSuite() {
  console.log("====================================================================================================");
  console.log("             AI QUOTA FAIL-CLOSED VERIFICATION SUITE (src/lib/ai/security.ts)                       ");
  console.log("====================================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Simulating old fail-open behavior on database errors...");
  }

  const tests = [
    {
      name: "Normal usage under daily limit (12/30)",
      scenario: "under-cap" as const,
      expectAllowed: true,
      expectStatus: 200,
    },
    {
      name: "Normal usage at daily cap (30/30)",
      scenario: "at-cap" as const,
      expectAllowed: false,
      expectStatus: 429,
    },
    {
      name: "Database error (store throws exception)",
      scenario: "throws" as const,
      expectAllowed: false,
      expectStatus: 503,
    },
    {
      name: "Database query timeout (promise rejected)",
      scenario: "timeout" as const,
      expectAllowed: false,
      expectStatus: 503,
    },
    {
      name: "Database returns corrupt / garbage metadata",
      scenario: "garbage" as const,
      expectAllowed: false,
      expectStatus: 503,
    },
  ];

  let total = 0;
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    total++;
    const client = createMockSupabase(t.scenario);

    let res = await checkAndIncrementAiQuota(client, "test-user-id", "cover_letter", 500);

    // If negative control active and it's an error scenario, simulate old fail-open
    if (IS_NEGATIVE_CONTROL && (t.scenario === "throws" || t.scenario === "timeout" || t.scenario === "garbage")) {
      res = {
        allowed: true, // Old dangerous fail-open behavior
        currentCount: 1,
        limit: 30,
        storage: "subscriptions_metadata",
      };
    }

    const matchesAllowed = res.allowed === t.expectAllowed;
    let verdict = matchesAllowed ? "PASS-LOCAL" : "FAIL";

    // Extra check: If blocked due to service failure, verify isServiceUnavailable flag
    if (t.expectStatus === 503 && res.allowed === false && !res.isServiceUnavailable) {
      verdict = "FAIL";
    }

    if (verdict === "PASS-LOCAL") passed++;
    else failed++;

    console.log(
      `[SCENARIO: ${t.scenario.padEnd(10)}] ${t.name.padEnd(46)} | Allowed: ${String(res.allowed).padEnd(5)} | Expected: ${String(t.expectAllowed).padEnd(5)} | ${verdict}`
    );
  }

  console.log("\n====================================================================================================");
  console.log(`TEST SUMMARY: ${passed}/${total} test cases passed. Failures: ${failed}`);
  console.log("====================================================================================================");

  if (IS_NEGATIVE_CONTROL) {
    if (failed > 0) {
      console.error("❌ NEGATIVE CONTROL VERIFIED: Script caught fail-open condition and exited non-zero as expected.");
      process.exit(1);
    } else {
      console.error("⚠️ NEGATIVE CONTROL FAILED: Fail-open condition was NOT caught!");
      process.exit(0);
    }
  }

  if (failed > 0) {
    console.error(`❌ TEST SUITE FAILED with ${failed} failures.`);
    process.exit(1);
  }

  console.log("🎉 ALL AI QUOTA FAIL-CLOSED CHECKS PASSED WITH 100% CONFORMANCE!");
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
