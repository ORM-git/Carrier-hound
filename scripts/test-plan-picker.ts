import assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
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
  ADD_ON_PACKS_NOTE,
  REFUND_POLICY_NOTE,
  FAIR_USE_LIMIT_NOTE,
  PER_WEEK_NOTE,
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

  // Weekly plan assertions
  const weekly = PLANS[0];
  assert.strictEqual(weekly.id, "weekly");
  assert.strictEqual(weekly.price, 692);
  assert.strictEqual(getPlanBillingLabel(weekly), "Billed weekly");
  assert.strictEqual(weekly.subLine, "15 resumes, 15 cover letters per week");
  assert.strictEqual(calculatePerWeek(weekly.price, "week"), 692);
  assert.strictEqual(getPlanPerWeekText(weekly), "Rs 692 /week");
  assert.strictEqual(weekly.badge, undefined, "Weekly plan must not have a badge");

  // Monthly plan assertions (selected by default)
  const monthly = PLANS[1];
  assert.strictEqual(monthly.id, "monthly");
  assert.strictEqual(monthly.price, 1499);
  assert.strictEqual(monthly.isDefault, true, "Monthly plan must be default");
  assert.strictEqual(getPlanBillingLabel(monthly), "Rs 1,499, billed monthly");
  assert.strictEqual(monthly.subLine, "60 resumes, 60 cover letters per month");
  assert.strictEqual(calculatePerWeek(monthly.price, "month"), 346); // Math.round(1499 * 12 / 52) = 346
  assert.strictEqual(getPlanPerWeekText(monthly), "Rs 346 /week*");
  assert.strictEqual(monthly.badge, "Most popular");

  // Quarterly plan assertions
  const quarterly = PLANS[2];
  assert.strictEqual(quarterly.id, "quarterly");
  assert.strictEqual(quarterly.price, 3999);
  assert.strictEqual(getPlanBillingLabel(quarterly), "Rs 3,999, billed every 3 months");
  assert.strictEqual(quarterly.subLine, "Same monthly quota for 3 months, one payment");
  assert.strictEqual(calculatePerWeek(quarterly.price, "quarter"), 308); // Math.round(3999 * 4 / 52) = 308
  assert.strictEqual(getPlanPerWeekText(quarterly), "Rs 308 /week*");
  assert.strictEqual(quarterly.badge, "Best value");

  // Verify per-week calculations are dynamic, not hardcoded
  assert.strictEqual(calculatePerWeek(1200, "month"), Math.round((1200 * 12) / 52));
  assert.strictEqual(calculatePerWeek(2600, "quarter"), Math.round((2600 * 4) / 52));

  // Add-on packs row note
  assert.strictEqual(
    ADD_ON_PACKS_NOTE,
    "Need more? Add-on packs Rs 149 / 399 / 699 = 10 / 30 / 60 extra sets, used after your plan quota, valid 60 days"
  );

  // Footer policy & limits notes
  assert.strictEqual(REFUND_POLICY_NOTE, "All sales final, no refunds");
  assert.strictEqual(FAIR_USE_LIMIT_NOTE, "Fair-use limit: 30 generations per day on every plan.");
  assert.ok(PER_WEEK_NOTE.includes("*Per-week"));

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
  // TEST 3: Rendered Markup, Radio Accessibility & Brand Styling
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying rendered card layout, radio accessibility, brand colors, and copy...");

  // Card header
  assert.ok(serverHtml.includes("Pick your plan"), "Must render card title 'Pick your plan'");
  assert.ok(
    serverHtml.includes("Accelerate your job search with AI resume tailoring and cover letters."),
    "Must render plan card subtitle"
  );

  // Radiogroup semantics
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

  // Plan rows copy
  assert.ok(serverHtml.includes("Billed weekly"), "Weekly row title must be present");
  assert.ok(serverHtml.includes("Rs 692 /week"), "Weekly price must be Rs 692 /week");
  assert.ok(serverHtml.includes("15 resumes, 15 cover letters per week"), "Weekly subline must be present");

  assert.ok(serverHtml.includes("Rs 1,499, billed monthly"), "Monthly row title must be present");
  assert.ok(serverHtml.includes("Rs 346 /week*"), "Monthly per-week price must be Rs 346 /week*");
  assert.ok(serverHtml.includes("60 resumes, 60 cover letters per month"), "Monthly subline must be present");
  assert.ok(serverHtml.includes("Most popular"), "Monthly badge 'Most popular' must be present");

  assert.ok(serverHtml.includes("Rs 3,999, billed every 3 months"), "Quarterly row title must be present");
  assert.ok(serverHtml.includes("Rs 308 /week*"), "Quarterly per-week price must be Rs 308 /week*");
  assert.ok(serverHtml.includes("Same monthly quota for 3 months, one payment"), "Quarterly subline must be present");
  assert.ok(serverHtml.includes("Best value"), "Quarterly badge 'Best value' must be present");

  // Upgrade button
  assert.ok(serverHtml.includes(UPGRADE_BUTTON_LABEL), "Upgrade button must have label 'Payments opening soon'");
  assert.ok(serverHtml.includes("disabled"), "Upgrade button must be disabled");
  assert.ok(serverHtml.includes("min-h-[48px]"), "Upgrade button touch target must be at least 48px");

  // Add-on row below card
  assert.ok(serverHtml.includes(ADD_ON_PACKS_NOTE), "Add-on packs note must be present below card");

  // Footer notes
  assert.ok(serverHtml.includes(REFUND_POLICY_NOTE), "Refund policy note must be present");
  assert.ok(serverHtml.includes(FAIR_USE_LIMIT_NOTE), "Fair-use limit note must be present");
  assert.ok(serverHtml.includes(PER_WEEK_NOTE), "Per-week asterisk note must be present");

  // CareerMonke Brand Blue styling (#2563EB)
  assert.ok(
    serverHtml.includes("#2563EB"),
    "CareerMonke brand blue #2563EB must be applied to radio, border, and Upgrade button"
  );

  // Safety checks: Payments OFF, no Razorpay, no fake stats/testimonials
  assert.strictEqual(
    serverHtml.includes("loadRazorpayScript"),
    false,
    "Payments must be OFF: No Razorpay script reference"
  );
  assert.strictEqual(
    serverHtml.includes("Testimonials") || serverHtml.includes("What users say"),
    false,
    "No fake testimonials allowed"
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
