/**
 * scripts/test-pricing-plan-checkout.ts
 *
 * Verification suite for Plan Purchase Buttons on /pricing:
 * 1. PLANS Catalog Integrity in src/config/plans.ts:
 *    - All 3 subscription plans (weekly, monthly, quarterly) define approved prices and quotas.
 * 2. Static & Markup Conformance in src/app/pricing/page.tsx:
 *    - Uses NEXT_PUBLIC_BILLING_ENABLED gate.
 *    - When enabled, renders active Buy button with data-plan-code={plan.id} and Buy ${plan.name}.
 *    - When disabled, keeps today's disabled button with UPGRADE_BUTTON_LABEL ("Payments opening soon").
 *    - Single unified in-flight guard across plan buttons (disabled={loadingPlan !== null}).
 *    - Synchronous re-entrancy lock with planCheckoutLockRef.current.
 *    - Redirects unauthenticated visitors to /login?returnTo=%2Fpricing.
 *    - Dismiss, error, and success lifecycle handlers clear planCheckoutLockRef and loadingPlan.
 * 3. Server-Authoritative Pricing:
 *    - resolveOrderPricing resolves approved paise amounts for weekly, monthly, and quarterly plans.
 * 4. Negative Control Mode:
 *    - Exits non-zero (1) when run with --negative-control.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PLANS, UPGRADE_BUTTON_LABEL } from "../src/config/plans";
import { resolveOrderPricing } from "../src/lib/billing/quota";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally asserting invalid condition...\n");
  assert.strictEqual(
    PLANS.length,
    999,
    "Negative control expected mismatch: PLANS length must be 3, not 999!"
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res && typeof (res as any).then === "function") {
      await res;
    }
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log("================================================================================");
  console.log("   PRICING PLAN PURCHASE FLOW VERIFICATION SUITE                               ");
  console.log("================================================================================");

  // 1. PLANS Catalog Integrity
  console.log("\n1. Verifying PLANS catalog definitions in src/config/plans.ts...");
  await check("PLANS defines weekly, monthly, quarterly with approved prices", () => {
    assert.strictEqual(PLANS.length, 3, "Must have exactly 3 plans");
    const ids = PLANS.map((p) => p.id);
    assert.deepStrictEqual(ids, ["weekly", "monthly", "quarterly"]);

    const weekly = PLANS.find((p) => p.id === "weekly")!;
    assert.strictEqual(weekly.price, 692, "Weekly price must be ₹692");

    const monthly = PLANS.find((p) => p.id === "monthly")!;
    assert.strictEqual(monthly.price, 1499, "Monthly price must be ₹1,499");

    const quarterly = PLANS.find((p) => p.id === "quarterly")!;
    assert.strictEqual(quarterly.price, 3999, "Quarterly price must be ₹3,999");
  });

  // 2. Static & Markup Conformance
  console.log("\n2. Verifying /pricing page source, button styling, and in-flight guards...");
  await check("Pricing page gates buy button with NEXT_PUBLIC_BILLING_ENABLED", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("NEXT_PUBLIC_BILLING_ENABLED"),
      "Pricing page must check NEXT_PUBLIC_BILLING_ENABLED"
    );
    assert.ok(
      pricingSrc.includes("data-plan-code={plan.id}"),
      "Pricing page must render data-plan-code={plan.id} on Buy buttons"
    );
    assert.ok(
      pricingSrc.includes("Buy {plan.name}"),
      "Pricing page must render 'Buy {plan.name}' button text when enabled"
    );
    assert.ok(
      pricingSrc.includes("UPGRADE_BUTTON_LABEL"),
      "Pricing page must retain UPGRADE_BUTTON_LABEL when disabled"
    );
  });

  await check("Pricing page enforces synchronous ref lock and in-flight disabled state", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("disabled={loadingPlan !== null}"),
      "Plan buttons must be disabled when loadingPlan !== null"
    );
    assert.ok(
      pricingSrc.includes("planCheckoutLockRef.current") &&
      pricingSrc.includes("loadingPlan !== null"),
      "handleBuyPlan must guard synchronously with planCheckoutLockRef and loadingPlan"
    );
    assert.ok(
      pricingSrc.includes("planCheckoutLockRef.current = false") &&
      pricingSrc.includes("setLoadingPlan(null)"),
      "handleBuyPlan must reset lock and loading state on complete/error/dismiss"
    );
  });

  await check("Pricing page redirects unauthenticated visitors to login returning to pricing", () => {
    const pricingSrc = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");

    assert.ok(
      pricingSrc.includes("/login?returnTo=") && pricingSrc.includes('encodeURIComponent("/pricing")'),
      "handleBuyPlan must redirect unauthenticated visitors to /login?returnTo=/pricing"
    );
  });

  // 3. Server-Authoritative Pricing Resolution
  console.log("\n3. Verifying server-authoritative plan pricing resolution...");
  await check("resolveOrderPricing returns correct paise amounts for all subscription plans", () => {
    const weeklyOrder = resolveOrderPricing({ planCode: "weekly" });
    assert.ok(weeklyOrder, "Weekly plan must resolve");
    assert.strictEqual(weeklyOrder.amount_paise, 69200, "Weekly order amount must be 69200 paise");
    assert.strictEqual(weeklyOrder.currency, "INR");
    assert.strictEqual(weeklyOrder.code, "weekly");

    const monthlyOrder = resolveOrderPricing({ planCode: "monthly" });
    assert.ok(monthlyOrder, "Monthly plan must resolve");
    assert.strictEqual(monthlyOrder.amount_paise, 149900, "Monthly order amount must be 149900 paise");
    assert.strictEqual(monthlyOrder.currency, "INR");
    assert.strictEqual(monthlyOrder.code, "monthly");

    const quarterlyOrder = resolveOrderPricing({ planCode: "quarterly" });
    assert.ok(quarterlyOrder, "Quarterly plan must resolve");
    assert.strictEqual(quarterlyOrder.amount_paise, 399900, "Quarterly order amount must be 399900 paise");
    assert.strictEqual(quarterlyOrder.currency, "INR");
    assert.strictEqual(quarterlyOrder.code, "quarterly");
  });

  // 4. Negative Control Self-Test
  console.log("\n4. Confirming negative control fails with non-zero exit code...");
  await check("Negative control exits non-zero", () => {
    const { spawnSync } = require("child_process");
    const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
      encoding: "utf-8",
      env: process.env,
    });
    assert.notStrictEqual(
      negResult.status,
      0,
      "Negative control MUST exit with non-zero exit code"
    );
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`TEST SUITE RESULTS: ${passed} passed, ${failed} failed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
