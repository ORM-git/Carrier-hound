/**
 * Offline test for the Error Budgets row (Backend sheet): burn-rate
 * primitives in src/lib/observability/errorBudget.ts carry exactly the
 * docs/slo.md thresholds (0.5% budget, 14.4x/1h fast, 6x/6h slow), the
 * digest-delivery evaluator scripts/check-error-budget.ts is wired, and
 * docs/slo.md points at the automation. Run: npx tsx scripts/test-error-budget.ts
 */
import * as fs from "fs";
import {
  ERROR_BUDGET_FRACTION,
  FAST_BURN_MULTIPLE,
  FAST_BURN_WINDOW_MINUTES,
  SLOW_BURN_MULTIPLE,
  SLOW_BURN_WINDOW_MINUTES,
  minutesInMonth,
  monthlyBudgetMinutes,
  burnMultiple,
  evaluateErrorBudget,
  cronFailureBadMinutes,
} from "../src/lib/observability/errorBudget";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// Thresholds match docs/slo.md exactly (no invented numbers).
check("budget fraction is 0.5% per docs/slo.md", ERROR_BUDGET_FRACTION === 0.005);
check("fast burn is 14.4x over 1h per docs/slo.md",
  FAST_BURN_MULTIPLE === 14.4 && FAST_BURN_WINDOW_MINUTES === 60);
check("slow burn is 6x over 6h per docs/slo.md",
  SLOW_BURN_MULTIPLE === 6 && SLOW_BURN_WINDOW_MINUTES === 360);

// Month math (UTC calendar months).
check("minutesInMonth: 30-day month = 43200", minutesInMonth(new Date(Date.UTC(2026, 3, 15))) === 43200);
check("minutesInMonth: 31-day month = 44640", minutesInMonth(new Date(Date.UTC(2026, 0, 15))) === 44640);
check("minutesInMonth: Feb non-leap = 40320", minutesInMonth(new Date(Date.UTC(2026, 1, 15))) === 40320);
check("minutesInMonth: Feb leap = 41760", minutesInMonth(new Date(Date.UTC(2024, 1, 15))) === 41760);
check("monthlyBudgetMinutes is 0.5% of the month",
  monthlyBudgetMinutes(new Date(Date.UTC(2026, 3, 15))) === 216);

// Burn math: 1x = spending exactly the allocated rate.
check("burnMultiple: bad=window*0.005 -> 1x", Math.abs(burnMultiple(0.3, 60) - 1) < 1e-9);
check("burnMultiple: bad=window*0.005*14.4 -> 14.4x", Math.abs(burnMultiple(4.32, 60) - 14.4) < 1e-9);
check("burnMultiple rejects negative bad minutes", (() => { try { burnMultiple(-1, 60); return false; } catch { return true; } })());
check("burnMultiple rejects empty window", (() => { try { burnMultiple(1, 0); return false; } catch { return true; } })());

const now = new Date(Date.UTC(2026, 3, 15, 12, 0, 0));
check("status ok when nothing is burning",
  evaluateErrorBudget({ now, badMinutes1h: 0, badMinutes6h: 0, badMinutesMonth: 0 }).status === "ok");
check("status fast_burn above 14.4x for 1h",
  evaluateErrorBudget({ now, badMinutes1h: 4.4, badMinutes6h: 4.4, badMinutesMonth: 4.4 }).status === "fast_burn");
check("status slow_burn above 6x (but not 14.4x) for 6h",
  evaluateErrorBudget({ now, badMinutes1h: 1, badMinutes6h: 12, badMinutesMonth: 12 }).status === "slow_burn");
check("status exhausted once the month budget is spent",
  evaluateErrorBudget({ now, badMinutes1h: 0, badMinutes6h: 0, badMinutesMonth: 216 }).status === "exhausted");
check("consumptionFraction is bad/budget",
  Math.abs(evaluateErrorBudget({ now, badMinutes1h: 0, badMinutes6h: 0, badMinutesMonth: 108 }).consumptionFraction - 0.5) < 1e-9);

// cron bad-minute conversion: failure lasts until the next success.
const t0 = Date.UTC(2026, 3, 15, 10, 0, 0);
const runs = [
  { status: "success", started_at: new Date(t0).toISOString() },
  { status: "failed", started_at: new Date(t0 + 60 * 60000).toISOString() },
  { status: "success", started_at: new Date(t0 + 90 * 60000).toISOString() },
];
check("failed->next success window counts 30 bad minutes",
  cronFailureBadMinutes(runs, t0, t0 + 120 * 60000) === 30);
check("unrecovered failure counts until now",
  cronFailureBadMinutes([{ status: "failed", started_at: new Date(t0).toISOString() }], t0, t0 + 45 * 60000) === 45);
check("window clips bad minutes to the window start",
  cronFailureBadMinutes(runs, t0 + 75 * 60000, t0 + 120 * 60000) === 15);
check("running rows are not failures",
  cronFailureBadMinutes([{ status: "running", started_at: new Date(t0).toISOString() }], t0, t0 + 60000) === 0);

// Script + docs wiring.
const scriptPath = "scripts/check-error-budget.ts";
check("check-error-budget.ts exists", fs.existsSync(scriptPath));
const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
check("script reads cron_run_logs", script.includes('.from("cron_run_logs")'));
check("script refuses truncated windows", script.includes("10000"));
check("script exits non-zero on fast_burn/exhausted",
  script.includes('status.status === "fast_burn" || status.status === "exhausted"'));
check("script uses the shared primitives (no redeclared threshold constants)",
  script.includes('from "../src/lib/observability/errorBudget"') && !/const (ERROR_BUDGET|FAST_BURN|SLOW_BURN)/.test(script));

const sloPath = "docs/slo.md";
const slo = fs.readFileSync(sloPath, "utf8");
check("docs/slo.md documents the 0.5% budget", slo.includes("0.5% of monthly uptime"));
check("docs/slo.md documents 14.4x/1h and 6x/6h", slo.includes("14.4x") && slo.includes("6x"));
check("docs/slo.md points at check-error-budget.ts", slo.includes("check-error-budget.ts"));

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check("suite-runner runs this test", runner.includes("scripts/test-error-budget.ts"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
