/**
 * Offline regression test for src/lib/api/routeBudget.ts (audit BE #64).
 * Run: npx tsx scripts/test-route-budget.ts
 */
import {
  ROUTE_TIME_BUDGETS_MS,
  DEFAULT_ROUTE_BUDGET_MS,
  getRouteBudgetMs,
  measureRouteBudget,
} from "../src/lib/api/routeBudget";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

async function main() {
  check("every budget is a positive number",
    Object.values(ROUTE_TIME_BUDGETS_MS).every((n) => Number.isFinite(n) && n > 0));
  check("default budget is positive", Number.isFinite(DEFAULT_ROUTE_BUDGET_MS) && DEFAULT_ROUTE_BUDGET_MS > 0);
  check("known route resolves its budget", getRouteBudgetMs("/api/ai") === ROUTE_TIME_BUDGETS_MS["/api/ai"]);
  check("unknown route falls back to default", getRouteBudgetMs("/api/nope") === DEFAULT_ROUTE_BUDGET_MS);

  {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m?: any) => warnings.push(String(m));
    try {
      const val = await measureRouteBudget("/api/stats", async () => 42);
      check("returns fn result unchanged", val === 42);
      check("no warning under budget", warnings.length === 0);
    } finally {
      console.warn = orig;
    }
  }
  {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m?: any) => warnings.push(String(m));
    const realNow = Date.now;
    let t = 1000;
    Date.now = () => t;
    try {
      await measureRouteBudget("/api/ticker", async () => {
        t += ROUTE_TIME_BUDGETS_MS["/api/ticker"] + 1;
        return "x";
      });
      check("warning emitted over budget", warnings.length === 1);
      const parsed = JSON.parse(warnings[0] ?? "{}");
      check("warning is structured with route and durations",
        parsed.event === "ROUTE_BUDGET_EXCEEDED" && parsed.route === "/api/ticker" &&
        parsed.durationMs === ROUTE_TIME_BUDGETS_MS["/api/ticker"] + 1 &&
        parsed.budgetMs === ROUTE_TIME_BUDGETS_MS["/api/ticker"]);
    } finally {
      console.warn = orig;
      Date.now = realNow;
    }
  }
  {
    // Errors from fn propagate; the budget check still runs (finally).
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m?: any) => warnings.push(String(m));
    let threw = false;
    try {
      await measureRouteBudget("/api/ai", async () => {
        throw new Error("boom");
      });
    } catch {
      threw = true;
    } finally {
      console.warn = orig;
    }
    check("fn error propagates", threw);
    check("no budget warning when fast-failing", warnings.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
