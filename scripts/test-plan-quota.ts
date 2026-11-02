import assert from "assert";
import { spawnSync } from "child_process";
import {
  mapPlanIdToCode,
  calculateQuotaPeriod,
  sumValidAddonCredits,
  PLAN_DEFINITIONS,
  FREE_QUOTA_DEFAULT,
  getPlanQuota,
} from "../src/lib/billing/quota";

async function runPlanQuotaSuite() {
  console.log("================================================================================");
  console.log("   PLAN QUOTA & READ-MODEL VERIFICATION TEST SUITE [PASS-LOCAL]                ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    // Assert invalid condition to guarantee non-zero exit code
    assert.strictEqual(
      mapPlanIdToCode("weekly"),
      "quarterly",
      "Negative control expected mismatch: weekly must not map to quarterly!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Free User Return Model
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying free user returns exact zero values and null planCode...");

  assert.deepStrictEqual(
    FREE_QUOTA_DEFAULT,
    {
      planCode: null,
      periodEnd: null,
      resumesRemaining: 0,
      coverLettersRemaining: 0,
      generationsToday: 0,
      dailyCap: 0,
      addonSetsRemaining: 0,
    },
    "Free user default quota model must have null codes and zeros"
  );

  // Calling getPlanQuota with empty string / invalid userId returns free default
  const emptyRes = await getPlanQuota("");
  assert.deepStrictEqual(emptyRes, FREE_QUOTA_DEFAULT, "Empty userId must return free default");

  const invalidRes = await getPlanQuota(null as any);
  assert.deepStrictEqual(invalidRes, FREE_QUOTA_DEFAULT, "Null userId must return free default");

  console.log("  -> [PASS-LOCAL] Free user quota returns zeros and null plan code.");

  // ---------------------------------------------------------------------------
  // TEST 2: Plan ID Mapping & Legacy Compatibility
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying plan_id to canonical planCode mapping (legacy & unknown)...");

  // Exact matches
  assert.strictEqual(mapPlanIdToCode("weekly"), "weekly");
  assert.strictEqual(mapPlanIdToCode("monthly"), "monthly");
  assert.strictEqual(mapPlanIdToCode("quarterly"), "quarterly");

  // Legacy subscription plan IDs
  assert.strictEqual(mapPlanIdToCode("domestic_monthly_199"), "monthly");
  assert.strictEqual(mapPlanIdToCode("intl_monthly_9"), "monthly");

  // Unknown / unmapped strings default to monthly
  assert.strictEqual(mapPlanIdToCode("unknown_legacy_plan_v1"), "monthly");
  assert.strictEqual(mapPlanIdToCode(""), "monthly");
  assert.strictEqual(mapPlanIdToCode(null), "monthly");
  assert.strictEqual(mapPlanIdToCode(undefined), "monthly");

  // Variation substrings
  assert.strictEqual(mapPlanIdToCode("pro_week_pass"), "weekly");
  assert.strictEqual(mapPlanIdToCode("team_quarter_sub"), "quarterly");

  console.log("  -> [PASS-LOCAL] Legacy and unknown plan IDs successfully map to canonical codes.");

  // ---------------------------------------------------------------------------
  // TEST 3: Quota Period Stepping Math
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying quota period stepping math across plans...");

  const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  // Case 3A: Weekly plan (7 days duration, 7 days quota period)
  {
    const subStart = new Date(baseTime);
    const subEnd = new Date(baseTime + 7 * dayMs);
    const nowDay3 = new Date(baseTime + 3 * dayMs);

    const period = calculateQuotaPeriod(subStart, subEnd, 7, nowDay3);
    assert.strictEqual(period.periodStart.toISOString(), subStart.toISOString());
    assert.strictEqual(period.periodEnd.toISOString(), subEnd.toISOString());
  }

  // Case 3B: Monthly plan (30 days duration, 30 days quota period)
  {
    const subStart = new Date(baseTime);
    const subEnd = new Date(baseTime + 30 * dayMs);
    const nowDay15 = new Date(baseTime + 15 * dayMs);

    const period = calculateQuotaPeriod(subStart, subEnd, 30, nowDay15);
    assert.strictEqual(period.periodStart.toISOString(), subStart.toISOString());
    assert.strictEqual(period.periodEnd.toISOString(), subEnd.toISOString());
  }

  // Case 3C: Quarterly plan (90 days duration, 30 days quota period)
  {
    const subStart = new Date(baseTime);
    const subEnd = new Date(baseTime + 90 * dayMs);

    // Period 1: Day 10 (within Days 0-30)
    const p1 = calculateQuotaPeriod(subStart, subEnd, 30, new Date(baseTime + 10 * dayMs));
    assert.strictEqual(p1.periodStart.toISOString(), new Date(baseTime).toISOString());
    assert.strictEqual(p1.periodEnd.toISOString(), new Date(baseTime + 30 * dayMs).toISOString());

    // Period 2: Day 35 (within Days 30-60)
    const p2 = calculateQuotaPeriod(subStart, subEnd, 30, new Date(baseTime + 35 * dayMs));
    assert.strictEqual(p2.periodStart.toISOString(), new Date(baseTime + 30 * dayMs).toISOString());
    assert.strictEqual(p2.periodEnd.toISOString(), new Date(baseTime + 60 * dayMs).toISOString());

    // Period 3: Day 75 (within Days 60-90)
    const p3 = calculateQuotaPeriod(subStart, subEnd, 30, new Date(baseTime + 75 * dayMs));
    assert.strictEqual(p3.periodStart.toISOString(), new Date(baseTime + 60 * dayMs).toISOString());
    assert.strictEqual(p3.periodEnd.toISOString(), new Date(baseTime + 90 * dayMs).toISOString());
  }

  // Case 3D: Edge cases (now before subStart, now after subEnd)
  {
    const subStart = new Date(baseTime);
    const subEnd = new Date(baseTime + 30 * dayMs);

    const beforeStart = calculateQuotaPeriod(subStart, subEnd, 30, new Date(baseTime - 5 * dayMs));
    assert.strictEqual(beforeStart.periodStart.toISOString(), subStart.toISOString());

    const afterEnd = calculateQuotaPeriod(subStart, subEnd, 30, new Date(baseTime + 45 * dayMs));
    assert.strictEqual(afterEnd.periodEnd.toISOString(), subEnd.toISOString());
  }

  console.log("  -> [PASS-LOCAL] Period stepping correctly advances in quota_period_days increments.");

  // ---------------------------------------------------------------------------
  // TEST 4: Add-on Credits Calculation & Expiry Filtering
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying add-on credits summation and expiry filtering...");

  const now = new Date("2026-06-01T12:00:00.000Z");

  const sampleCredits = [
    { sets_remaining: 10, expires_at: "2026-06-15T00:00:00.000Z" }, // Valid: +14 days
    { sets_remaining: 30, expires_at: "2026-05-20T00:00:00.000Z" }, // Expired: -12 days
    { sets_remaining: 0, expires_at: "2026-07-01T00:00:00.000Z" },  // Valid date but 0 remaining
    { sets_remaining: 60, expires_at: "2026-07-15T00:00:00.000Z" }, // Valid: +44 days
    { sets_remaining: -5, expires_at: "2026-08-01T00:00:00.000Z" }, // Invalid negative
  ];

  const totalValidSets = sumValidAddonCredits(sampleCredits, now);
  assert.strictEqual(totalValidSets, 70, "Total valid sets must be 10 + 60 = 70");

  const emptyCredits = sumValidAddonCredits([], now);
  assert.strictEqual(emptyCredits, 0, "Empty credits must return 0");

  console.log("  -> [PASS-LOCAL] Add-on credits properly filter expired or exhausted allocations.");

  // ---------------------------------------------------------------------------
  // TEST 5: Plan Definitions & Default Quotas
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying PLAN_DEFINITIONS catalog constants...");

  const weeklyDef = PLAN_DEFINITIONS.weekly;
  assert.strictEqual(weeklyDef.resume_quota, 15);
  assert.strictEqual(weeklyDef.cover_letter_quota, 15);
  assert.strictEqual(weeklyDef.quota_period_days, 7);
  assert.strictEqual(weeklyDef.daily_generation_cap, 30);

  const monthlyDef = PLAN_DEFINITIONS.monthly;
  assert.strictEqual(monthlyDef.resume_quota, 60);
  assert.strictEqual(monthlyDef.cover_letter_quota, 60);
  assert.strictEqual(monthlyDef.quota_period_days, 30);
  assert.strictEqual(monthlyDef.daily_generation_cap, 30);

  const quarterlyDef = PLAN_DEFINITIONS.quarterly;
  assert.strictEqual(quarterlyDef.resume_quota, 60);
  assert.strictEqual(quarterlyDef.cover_letter_quota, 60);
  assert.strictEqual(quarterlyDef.quota_period_days, 30);
  assert.strictEqual(quarterlyDef.daily_generation_cap, 30);

  console.log("  -> [PASS-LOCAL] PLAN_DEFINITIONS quotas and daily caps verified.");

  // ---------------------------------------------------------------------------
  // TEST 6: Negative Control Subprocess Execution
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("   ALL PLAN QUOTA VERIFICATION TESTS PASSED SUCCESSFULLY [PASS-LOCAL]          ");
  console.log("================================================================================");
}

runPlanQuotaSuite().catch((err) => {
  console.error("\n[FAIL] Plan Quota Suite Error:\n", err);
  process.exit(1);
});
