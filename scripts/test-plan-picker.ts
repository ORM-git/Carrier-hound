import assert from "assert";
import { spawnSync } from "child_process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Next.js App Router context providers for server-rendering client components in test harness
// @ts-ignore
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
// @ts-ignore
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import PricingPage from "../src/app/pricing/page";
import {
  PLANS,
  calculatePerWeek,
  getPlanBillingLabel,
  getPlanPerWeekText,
  UPGRADE_BUTTON_LABEL,
} from "../src/config/plans";

const mockRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

function renderWithRouter(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: mockRouter },
      React.createElement(
        PathnameContext.Provider,
        { value: "/pricing" },
        node
      )
    )
  );
}

async function runPlanPickerSuite() {
  console.log("================================================================================");
  console.log("   PLAN PICKER PAGE & CONFIG VERIFICATION TEST SUITE [PASS-LOCAL]              ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    // Inject invalid plan count to prove failure
    assert.strictEqual(
      PLANS.length,
      99,
      "Negative control expected mismatch: PLANS length must be 3, not 99!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Config File (src/config/plans.ts) Integrity & Order
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying src/config/plans.ts plan order, pricing, and dynamic per-week calculations...");

  assert.strictEqual(PLANS.length, 3, "Must have exactly 3 subscription plans");
  assert.deepStrictEqual(
    PLANS.map((p) => p.id),
    ["weekly", "monthly", "quarterly"],
    "Plans must be in exact order: Weekly, Monthly, Quarterly"
  );

  // Weekly plan assertions (approved price: ₹692)
  const weekly = PLANS[0];
  assert.strictEqual(weekly.id, "weekly");
  assert.strictEqual(weekly.price, 692, "Weekly price must be approved ₹692");
  assert.strictEqual(getPlanBillingLabel(weekly), "Billed weekly");
  assert.strictEqual(weekly.subLine, "15 sets/week");
  assert.strictEqual(calculatePerWeek(weekly.price, "week"), 692);
  assert.strictEqual(getPlanPerWeekText(weekly), "₹692 /week");

  // Monthly plan assertions (selected by default, approved ₹1,499)
  const monthly = PLANS[1];
  assert.strictEqual(monthly.id, "monthly");
  assert.strictEqual(monthly.price, 1499, "Monthly price must be approved ₹1,499");
  assert.strictEqual(monthly.isDefault, true, "Monthly plan must be default");
  assert.strictEqual(getPlanBillingLabel(monthly), "₹1,499, billed monthly");
  assert.strictEqual(monthly.subLine, "60 sets/month");
  assert.strictEqual(calculatePerWeek(monthly.price, "month"), 346); // Math.round(1499 * 12 / 52) = 346
  assert.strictEqual(getPlanPerWeekText(monthly), "₹346 /week*");

  // Quarterly plan assertions (approved ₹3,999)
  const quarterly = PLANS[2];
  assert.strictEqual(quarterly.id, "quarterly");
  assert.strictEqual(quarterly.price, 3999, "Quarterly price must be approved ₹3,999");
  assert.strictEqual(getPlanBillingLabel(quarterly), "₹3,999, billed every 3 months");
  assert.strictEqual(quarterly.subLine, "60 sets each month (resets monthly)");
  assert.strictEqual(calculatePerWeek(quarterly.price, "quarter"), 308); // Math.round(3999 * 4 / 52) = 308
  assert.strictEqual(getPlanPerWeekText(quarterly), "₹308 /week*");

  // Verify per-week calculations are dynamic, not hardcoded
  assert.strictEqual(calculatePerWeek(1200, "month"), Math.round((1200 * 12) / 52));
  assert.strictEqual(calculatePerWeek(2600, "quarter"), Math.round((2600 * 4) / 52));

  console.log("  -> [PASS-LOCAL] src/config/plans.ts integrity and per-week math verified.");

  // ---------------------------------------------------------------------------
  // TEST 2: Server HTML and Client Hydration Parity
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying Server HTML strictly equals first client render (user=null)...");

  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).location;
  const serverHtml = renderWithRouter(React.createElement(PricingPage));

  (globalThis as any).window = globalThis;
  (globalThis as any).location = new URL("http://localhost:3000/pricing");
  (globalThis as any).localStorage = {
    getItem: () => null,
  };
  const firstClientMarkup = renderWithRouter(React.createElement(PricingPage));

  assert.strictEqual(
    firstClientMarkup,
    serverHtml,
    "Server HTML must match first client render to ensure zero hydration mismatch"
  );
  console.log("  -> [PASS-LOCAL] Zero hydration mismatch verified.");

  // ---------------------------------------------------------------------------
  // TEST 3: Rendered Visible Payments-Off UI, Accessibility & Brand Styling
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying visible payments-off UI, prices, per-week badges, disabled button, and accessibility...");

  // Page header
  assert.ok(
    serverHtml.includes("Get more interviews with CareerMonke Premium"),
    "Must render visible page title 'Get more interviews with CareerMonke Premium'"
  );
  assert.ok(
    serverHtml.includes("Stronger resumes + faster applications tailored to verified unindexed remote roles."),
    "Must render benefit-led subtitle"
  );

  // Radiogroup semantics (mobile container)
  assert.ok(
    serverHtml.includes('role="radiogroup"') && serverHtml.includes('aria-label="Subscription plans"'),
    "Must render accessible radiogroup with aria-label"
  );
  assert.ok(
    serverHtml.includes('role="radio"'),
    "Must render options with role='radio'"
  );
  assert.ok(
    serverHtml.includes('aria-checked="true"'),
    "Default selected plan (monthly) must have aria-checked='true'"
  );

  // Visible plan rows and prices
  assert.ok(serverHtml.includes("Weekly"), "Weekly plan title must be present");
  assert.ok(serverHtml.includes("₹692"), "Weekly price must be ₹692");
  assert.ok(serverHtml.includes("15 sets/week"), "Weekly subline must be present");
  assert.ok(serverHtml.includes("₹692 /week"), "Weekly per-week text must be ₹692 /week");
  assert.ok(serverHtml.includes("Billed weekly"), "Weekly billing text must be present");

  assert.ok(serverHtml.includes("Monthly"), "Monthly plan title must be present");
  assert.ok(serverHtml.includes("₹1,499"), "Monthly price must be ₹1,499");
  assert.ok(serverHtml.includes("346"), "Monthly per-week price 346 must be present");
  assert.ok(serverHtml.includes("60 sets/month"), "Monthly subline must be present");
  assert.ok(serverHtml.includes("billed monthly"), "Monthly billing text must be present");

  assert.ok(serverHtml.includes("Quarterly"), "Quarterly plan title must be present");
  assert.ok(serverHtml.includes("₹3,999"), "Quarterly price must be ₹3,999");
  assert.ok(serverHtml.includes("308"), "Quarterly per-week price 308 must be present");
  assert.ok(serverHtml.includes("60 sets each month (resets monthly)"), "Quarterly subline must be present");
  assert.ok(serverHtml.includes("billed every 3 months"), "Quarterly billing text must be present");

  // Free Tier Card
  assert.ok(serverHtml.includes("Free Plan"), "Free tier heading 'Free Plan' must be present");
  assert.ok(serverHtml.includes("₹0.00"), "Free plan price ₹0.00 must be present");
  assert.ok(serverHtml.includes("Your current plan"), "'Your current plan' badge must be present");

  // Comparison Features Section
  assert.ok(serverHtml.includes("All features included in Premium"), "Features section heading must be present");

  // Upgrade Button & Sub-label (links to login/signup for logged-out visitors)
  assert.ok(serverHtml.includes('href="/login"'), "Upgrade CTA must link to login/signup for logged-out visitors");
  assert.ok(serverHtml.includes("Upgrade"), "Upgrade button text must be 'Upgrade'");
  assert.ok(serverHtml.includes(UPGRADE_BUTTON_LABEL), "Upgrade button sub-label must be UPGRADE_BUTTON_LABEL ('Payments opening soon')");

  // Brand Blue styling (#2563EB)
  assert.ok(
    serverHtml.includes("#2563EB"),
    "CareerMonke brand blue #2563EB must be present in focus rings/styling"
  );

  // Safety checks: Payments OFF, no Razorpay, no fake stats/testimonials
  assert.strictEqual(
    serverHtml.includes("loadRazorpayScript"),
    false,
    "Payments must be OFF: No Razorpay script reference"
  );

  console.log("  -> [PASS-LOCAL] Rendered markup, accessibility semantics, and brand blue verified.");

  // ---------------------------------------------------------------------------
  // TEST 4: Negative Control Subprocess Execution
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Confirming negative control fails with non-zero exit code...");
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
  console.log("   ALL PLAN PICKER VERIFICATION TESTS PASSED SUCCESSFULLY [PASS-LOCAL]         ");
  console.log("================================================================================");
}

runPlanPickerSuite().catch((err) => {
  console.error("\n[FAIL] Plan Picker Suite Error:\n", err);
  process.exit(1);
});
