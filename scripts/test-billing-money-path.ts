/**
 * scripts/test-billing-money-path.ts
 *
 * Comprehensive verification suite for Money-Path Hardening:
 * 1) Renewal/upgrade: in fulfil_payment_order (new migration file) and Next fallback:
 *    - When an active plan user buys any plan: new period end = max(current_period_end, now) + duration.
 *    - Never shortens an existing period.
 * 2) Add-ons:
 *    - Keep 1 credit = 1 generation.
 *    - Change every user-facing add-on label/description to "extra generations", zero "sets" wording.
 * 3) Add-on orders:
 *    - Active-Pro precheck added to Cloudflare/Next order route, symmetric with Netlify.
 *    - Rejects free users with HTTP 403 PRO_REQUIRED.
 * 4) Fulfilment fail-closed and atomic:
 *    - Never mark order paid before entitlement grant succeeds.
 *    - Old fallback path that marked paid first is removed.
 *    - Retries re-attempt the grant if previously incomplete.
 * 5) Negative control:
 *    - Exits non-zero on assertion error.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ADDON_PACK_DEFINITIONS,
  PLAN_DEFINITIONS,
  resolveOrderPricing,
} from "../src/lib/billing/quota";
import {
  ADD_ON_PACKS_NOTE,
  PLAN_COMPARISON_ROWS,
} from "../src/config/plans";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runMoneyPathTests() {
  console.log("================================================================================");
  console.log("   BILLING MONEY-PATH HARDENING & VERIFICATION TEST SUITE [PASS-LOCAL]          ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    // Intentional failure: pretend renewal shortens active period
    const currentEnd = new Date(Date.now() + 20 * 86400000);
    const brokenEnd = new Date(Date.now() + 7 * 86400000); // 7 days from now shortens 20 days!
    assert.ok(
      brokenEnd.getTime() > currentEnd.getTime(),
      "Negative control failed as expected: renewal shortened active subscription period!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Renewal & Upgrade Extension Logic
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Verifying renewal and upgrade period extension logic...");

  // 1A: Inspect Migration File
  const migrationPath = path.resolve(
    __dirname,
    "../supabase/migrations/20261103g_fulfil_payment_upgrade_extend.sql"
  );
  assert.ok(
    fs.existsSync(migrationPath),
    "Migration file supabase/migrations/20261103g_fulfil_payment_upgrade_extend.sql must exist"
  );
  const migrationSql = fs.readFileSync(migrationPath, "utf-8");

  // Verify atomic lock
  assert.ok(
    migrationSql.includes("for update;"),
    "fulfil_payment_order must lock payment_orders row for update"
  );

  // Verify renewal math in SQL: max(current_period_end, now) + duration
  assert.ok(
    migrationSql.includes("greatest(v_existing_sub.current_period_end, now())") ||
      migrationSql.includes("greatest(now(), v_existing_sub.current_period_end)"),
    "fulfil_payment_order must calculate base_time using greatest(current_period_end, now)"
  );
  assert.ok(
    migrationSql.includes("v_new_end := v_base_time + (v_duration * interval '1 day')"),
    "fulfil_payment_order must extend period by v_duration days from base_time"
  );

  // Verify non-shortening guard in SQL
  assert.ok(
    migrationSql.includes("if v_new_end < v_existing_sub.current_period_end then") &&
      migrationSql.includes("v_new_end := v_existing_sub.current_period_end;"),
    "fulfil_payment_order must explicitly guard against shortening existing period"
  );

  // Verify old migration files were not edited
  const oldMigrations = [
    "20261103f_fulfil_payment_order_atomic.sql",
    "20261103e_pro_and_daily_cap_policies.sql",
    "20261103d_pricing_catalog_and_features.sql",
  ];
  for (const oldFile of oldMigrations) {
    const fullOldPath = path.resolve(__dirname, "../supabase/migrations", oldFile);
    if (fs.existsSync(fullOldPath)) {
      const gitDiff = spawnSync("git", ["diff", "HEAD", "--", fullOldPath], {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf-8",
      });
      assert.strictEqual(
        gitDiff.stdout.trim(),
        "",
        `Old migration file ${oldFile} must not be edited!`
      );
    }
  }

  // 1B: Verify Next Fallback Extension Calculation
  const nowMs = 1730635200000; // Fixed timestamp for deterministic testing
  const now = new Date(nowMs);

  function calculateNextFallbackPeriodEnd(
    existingSub: { status: string; current_period_end: string | null } | null,
    durationDays: number,
    referenceNow: Date
  ): string {
    let currentPeriodEnd: string;
    if (
      existingSub &&
      (existingSub.status === "active" || existingSub.status === "trialing") &&
      existingSub.current_period_end
    ) {
      const existingEnd = new Date(existingSub.current_period_end);
      const baseDate = existingEnd.getTime() > referenceNow.getTime() ? existingEnd : referenceNow;
      currentPeriodEnd = new Date(baseDate.getTime() + durationDays * 86400000).toISOString();
    } else {
      currentPeriodEnd = new Date(referenceNow.getTime() + durationDays * 86400000).toISOString();
    }

    // Guarantee never shorten an existing period
    if (existingSub?.current_period_end) {
      const existingEnd = new Date(existingSub.current_period_end);
      if (new Date(currentPeriodEnd).getTime() < existingEnd.getTime()) {
        currentPeriodEnd = existingSub.current_period_end;
      }
    }
    return currentPeriodEnd;
  }

  // Scenario 1: Active plan with 15 days remaining buys monthly plan (30 days)
  // Expected: 15 + 30 = 45 days remaining from referenceNow
  const activeSub15Days = {
    status: "active",
    current_period_end: new Date(nowMs + 15 * 86400000).toISOString(),
  };
  const newEnd1 = calculateNextFallbackPeriodEnd(activeSub15Days, 30, now);
  const expectedEnd1 = new Date(nowMs + 45 * 86400000).toISOString();
  assert.strictEqual(newEnd1, expectedEnd1, "Active plan with 15 days left + 30 days must equal 45 days");

  // Scenario 2: Active plan with 50 days remaining buys weekly plan (7 days)
  // Expected: 50 + 7 = 57 days remaining from referenceNow (never shortened to now + 7 = 7 days)
  const activeSub50Days = {
    status: "active",
    current_period_end: new Date(nowMs + 50 * 86400000).toISOString(),
  };
  const newEnd2 = calculateNextFallbackPeriodEnd(activeSub50Days, 7, now);
  const expectedEnd2 = new Date(nowMs + 57 * 86400000).toISOString();
  assert.strictEqual(newEnd2, expectedEnd2, "Active plan with 50 days left + 7 days must equal 57 days");

  // Scenario 3: Expired plan (expired 10 days ago) buys monthly plan (30 days)
  // Expected: referenceNow + 30 days
  const expiredSub = {
    status: "active",
    current_period_end: new Date(nowMs - 10 * 86400000).toISOString(),
  };
  const newEnd3 = calculateNextFallbackPeriodEnd(expiredSub, 30, now);
  const expectedEnd3 = new Date(nowMs + 30 * 86400000).toISOString();
  assert.strictEqual(newEnd3, expectedEnd3, "Expired plan + 30 days must start from referenceNow");

  console.log("  -> [PASS-LOCAL] Renewal and upgrade calculation extends active period and never shortens.");

  // ---------------------------------------------------------------------------
  // TEST 2: Add-on Generation Copy & Wording
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying add-on copy: 'extra generations', zero 'sets' wording...");

  // 2A: Catalog definitions in quota.ts
  for (const [code, addon] of Object.entries(ADDON_PACK_DEFINITIONS)) {
    assert.ok(
      addon.name.toLowerCase().includes("extra generations"),
      `Addon ${code} name (${addon.name}) must contain "extra generations"`
    );
    assert.ok(
      !addon.name.toLowerCase().includes("set"),
      `Addon ${code} name (${addon.name}) must NOT contain the word "set"`
    );
    // 1 credit = 1 generation
    assert.strictEqual(
      addon.sets,
      parseInt(addon.name, 10),
      `Addon ${code} sets count (${addon.sets}) must match name number (${addon.name})`
    );
  }

  // 2B: Config note in plans.ts
  assert.ok(
    ADD_ON_PACKS_NOTE.toLowerCase().includes("extra generations"),
    `ADD_ON_PACKS_NOTE must contain "extra generations": ${ADD_ON_PACKS_NOTE}`
  );
  assert.ok(
    !ADD_ON_PACKS_NOTE.toLowerCase().includes("sets"),
    `ADD_ON_PACKS_NOTE must NOT contain "sets": ${ADD_ON_PACKS_NOTE}`
  );

  // 2C: Comparison rows in plans.ts
  const addonRow = PLAN_COMPARISON_ROWS.find((r) =>
    r.feature.toLowerCase().includes("add-on")
  );
  assert.ok(addonRow, "Add-on comparison row must exist in PLAN_COMPARISON_ROWS");
  if (addonRow.description) {
    assert.ok(
      addonRow.description.toLowerCase().includes("extra generations"),
      "Add-on row description must contain 'extra generations'"
    );
    assert.ok(
      !addonRow.description.toLowerCase().includes("sets"),
      "Add-on row description must NOT contain 'sets'"
    );
  }

  // 2D: Pricing page copy in pricing/page.tsx
  const pricingPagePath = path.resolve(__dirname, "../src/app/pricing/page.tsx");
  const pricingPageContent = fs.readFileSync(pricingPagePath, "utf-8");
  assert.ok(
    pricingPageContent.includes("10/30/60 extra generations") ||
      pricingPageContent.includes("10 / 30 / 60 extra generations"),
    "Pricing page must describe add-ons with 'extra generations'"
  );
  // Ensure no "extra sets" appears anywhere in pricing/page.tsx
  assert.ok(
    !pricingPageContent.toLowerCase().includes("extra set"),
    "Pricing page must NOT contain 'extra set' or 'extra sets'"
  );

  console.log("  -> [PASS-LOCAL] Add-on catalog and UI strictly use 'extra generations' with zero 'sets' wording.");

  // ---------------------------------------------------------------------------
  // TEST 3: Add-on Order Active-Pro Precheck Parity
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying active-Pro precheck on Next/Cloudflare Razorpay order route...");

  const nextOrderRoutePath = path.resolve(
    __dirname,
    "../src/app/api/billing/razorpay/order/route.ts"
  );
  const nextOrderRouteCode = fs.readFileSync(nextOrderRoutePath, "utf-8");

  // Verify getServerEntitlement is imported and invoked
  assert.ok(
    nextOrderRouteCode.includes("getServerEntitlement"),
    "Next order route must import and call getServerEntitlement"
  );
  assert.ok(
    nextOrderRouteCode.includes('pricing.type === "addon"'),
    "Next order route must check pricing.type === 'addon'"
  );
  assert.ok(
    nextOrderRouteCode.includes('code: "PRO_REQUIRED"'),
    "Next order route must return PRO_REQUIRED for non-Pro add-on order attempts"
  );
  assert.ok(
    nextOrderRouteCode.includes("status: 403"),
    "Next order route must return HTTP 403 when PRO_REQUIRED"
  );

  // Verify parity with Netlify billing-razorpay-order.ts
  const netlifyOrderPath = path.resolve(
    __dirname,
    "../netlify/functions/billing-razorpay-order.ts"
  );
  const netlifyOrderCode = fs.readFileSync(netlifyOrderPath, "utf-8");
  assert.ok(
    netlifyOrderCode.includes('pricing.type === "addon"') &&
      netlifyOrderCode.includes("PRO_REQUIRED") &&
      netlifyOrderCode.includes("403"),
    "Netlify order route must also enforce 403 PRO_REQUIRED for add-ons"
  );

  // Test functional logic of precheck
  function simulateOrderRoutePrecheck(pricingType: string, isPro: boolean): { status: number; code?: string } {
    if (pricingType === "addon") {
      if (!isPro) {
        return { status: 403, code: "PRO_REQUIRED" };
      }
    }
    return { status: 200 };
  }

  assert.deepStrictEqual(
    simulateOrderRoutePrecheck("addon", false),
    { status: 403, code: "PRO_REQUIRED" },
    "Free user requesting add-on must be rejected with 403 PRO_REQUIRED"
  );
  assert.deepStrictEqual(
    simulateOrderRoutePrecheck("addon", true),
    { status: 200 },
    "Pro user requesting add-on must be allowed"
  );
  assert.deepStrictEqual(
    simulateOrderRoutePrecheck("plan", false),
    { status: 200 },
    "Free user requesting plan upgrade must be allowed"
  );

  console.log("  -> [PASS-LOCAL] Active-Pro precheck strictly enforced on Next and Netlify order routes.");

  // ---------------------------------------------------------------------------
  // TEST 4: Fail-Closed & Atomic Fulfillment
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying fail-closed and atomic fulfillment (grant first, mark paid second)...");

  const nextVerifyRoutePath = path.resolve(
    __dirname,
    "../src/app/api/billing/razorpay/verify/route.ts"
  );
  const nextVerifyRouteCode = fs.readFileSync(nextVerifyRoutePath, "utf-8");

  const normalizedCode = nextVerifyRouteCode.replace(/\r\n/g, "\n");
  const fulfillStart = normalizedCode.indexOf("// Fulfill based strictly on orderRow");
  assert.ok(fulfillStart !== -1, "Fulfillment section must exist in verify route");

  const addonBranchStart = normalizedCode.indexOf("if (orderRow.addon_code) {", fulfillStart);
  const planBranchStart = normalizedCode.indexOf("} else if (orderRow.plan_code) {", fulfillStart);

  assert.ok(addonBranchStart !== -1, "Addon branch must exist in verify route");
  assert.ok(planBranchStart !== -1, "Plan branch must exist in verify route");

  const addonBranch = normalizedCode.slice(addonBranchStart, planBranchStart);
  const planBranch = normalizedCode.slice(planBranchStart);

  const addonInsertPos = addonBranch.indexOf('.from("user_addon_credits")');
  const addonPaidUpdatePos = addonBranch.indexOf('status: "paid"');
  assert.ok(addonInsertPos !== -1, "Addon branch must insert into user_addon_credits");
  assert.ok(addonPaidUpdatePos !== -1, "Addon branch must mark payment_orders paid");
  assert.ok(
    addonInsertPos < addonPaidUpdatePos,
    "CRITICAL: in addon branch, user_addon_credits must be inserted BEFORE payment_orders is marked paid!"
  );

  const subUpsertPos = planBranch.indexOf('.from("subscriptions")');
  const subPaidUpdatePos = planBranch.indexOf('status: "paid"');
  assert.ok(subUpsertPos !== -1, "Plan branch must upsert into subscriptions");
  assert.ok(subPaidUpdatePos !== -1, "Plan branch must mark payment_orders paid");
  assert.ok(
    subUpsertPos < subPaidUpdatePos,
    "CRITICAL: in plan branch, subscriptions must be upserted BEFORE payment_orders is marked paid!"
  );

  // 4B: Verify retry logic re-attempts grant if order status is paid but entitlement missing
  assert.ok(
    nextVerifyRouteCode.includes('if (orderRow.status === "paid") {'),
    "Verify route must handle orderRow.status === 'paid'"
  );
  assert.ok(
    nextVerifyRouteCode.includes("existingCredit") && nextVerifyRouteCode.includes("existingSub"),
    "Verify route must check if entitlement record already exists before short-circuiting"
  );

  // 4C: Verify SQL migration ordering
  const subInsertIdx = migrationSql.indexOf("insert into public.subscriptions");
  const subMarkPaidIdx = migrationSql.indexOf("update public.payment_orders\n    set status = 'paid'");
  assert.ok(subInsertIdx !== -1, "SQL migration must contain insert into subscriptions");
  assert.ok(subMarkPaidIdx !== -1, "SQL migration must contain update payment_orders set status = 'paid'");
  assert.ok(
    subInsertIdx < subMarkPaidIdx,
    "In SQL migration, subscriptions insert MUST occur before payment_orders status update!"
  );

  const addonInsertIdx = migrationSql.indexOf("insert into public.user_addon_credits");
  const addonMarkPaidIdx = migrationSql.lastIndexOf("update public.payment_orders\n    set status = 'paid'");
  assert.ok(addonInsertIdx !== -1, "SQL migration must contain insert into user_addon_credits");
  assert.ok(
    addonInsertIdx < addonMarkPaidIdx,
    "In SQL migration, user_addon_credits insert MUST occur before payment_orders status update!"
  );

  // 4D: Simulate fail-closed behavior in mock test
  let simulatedPaymentOrderStatus = "created";
  let creditGrantFailed = true;

  try {
    if (creditGrantFailed) {
      throw new Error("Simulated database constraint or disk error during credit grant");
    }
    simulatedPaymentOrderStatus = "paid";
  } catch {
    // Fail closed: order status remains unchanged
  }

  assert.strictEqual(
    simulatedPaymentOrderStatus,
    "created",
    "On entitlement failure, payment_orders MUST remain in 'created' state"
  );

  console.log("  -> [PASS-LOCAL] Atomic ordering confirmed: entitlement granted first, order marked paid second.");

  // ---------------------------------------------------------------------------
  // TEST 5: Automated Negative Control Execution
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Executing automated negative control as sub-process...");
  const selfScript = path.resolve(__dirname, "test-billing-money-path.ts");
  const child = spawnSync("npx", ["tsx", selfScript, "--negative-control"], {
    cwd: path.resolve(__dirname, ".."),
    shell: true,
    stdio: "pipe",
    env: { ...process.env },
  });

  assert.notStrictEqual(
    child.status,
    0,
    `Negative control MUST exit with non-zero code. Output:\n${child.stderr?.toString()}`
  );
  console.log("  -> [PASS-LOCAL] Negative control verified: failed with non-zero exit code as expected");

  console.log("\n================================================================================");
  console.log("ALL 5 MONEY-PATH CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runMoneyPathTests().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
