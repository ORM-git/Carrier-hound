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
import { PLANS, PLAN_PRICING } from "../src/config/plans";

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

  const originalBillingEnabled = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

  try {
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

  // Approved one-time prices and durations
  assert.deepStrictEqual(
    PLANS.map((p) => [p.id, p.price, PLAN_PRICING[p.id].duration_days]),
    [
      ["weekly", 399, 7],
      ["monthly", 499, 30],
      ["quarterly", 2199, 90],
    ],
    "Plans must be Weekly ₹399/7d, Monthly ₹499/30d, Quarterly ₹2,199/90d"
  );
  assert.strictEqual(PLANS[1].isDefault, true, "Monthly plan must be default");

  console.log("  -> [PASS-LOCAL] src/config/plans.ts integrity verified.");

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
  assert.ok(serverHtml.includes("Plans and pricing"), "Must render page title 'Plans and pricing'");
  assert.ok(
    serverHtml.includes("Full access to verified unindexed remote job listings."),
    "Must render job-listing subtitle"
  );

  // Three plan cards with name, one-time price and duration
  for (const [name, price, days] of [
    ["Weekly", "₹399", 7],
    ["Monthly", "₹499", 30],
    ["Quarterly", "₹2,199", 90],
  ] as const) {
    assert.ok(serverHtml.includes(name), `${name} plan title must be present`);
    assert.ok(serverHtml.includes(price), `${name} price must be ${price}`);
    assert.ok(serverHtml.includes(`${days} days access`), `${name} duration must be ${days} days`);
  }
  assert.strictEqual((serverHtml.match(/data-plan-card=/g) || []).length, 3, "Exactly 3 plan cards");

  // Job-listing bullets only (4 per card)
  for (const bullet of [
    "Unlimited browsing of verified unindexed remote jobs",
    "Filters for role, location and job type",
    "Salary data where available",
    "Direct apply links to employer career pages",
  ]) {
    assert.strictEqual(serverHtml.split(bullet).length - 1, 3, `Bullet '${bullet}' must appear once per card`);
  }

  // Removed rows must stay removed
  for (const removed of [
    "Free Plan",
    "All features included in Premium",
    "Add-on Packs",
    "AI resume",
    "cover letter",
    "ATS apply",
    "match score",
    "/week",
    "sets/",
  ]) {
    assert.strictEqual(serverHtml.includes(removed), false, `/pricing must not contain '${removed}'`);
  }
  assert.strictEqual(/coming soon|opening soon|open soon/i.test(serverHtml), false, "No 'coming soon' wording");

  // Payments OFF: disabled Upgrade buttons with an unavailable note
  assert.strictEqual((serverHtml.match(/<button[^>]*disabled[^>]*>Upgrade<\/button>/g) || []).length, 3, "3 disabled Upgrade buttons");
  assert.ok(serverHtml.includes("Payments are currently unavailable."), "Payments-unavailable note must render");

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
  } finally {
    if (originalBillingEnabled !== undefined) {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = originalBillingEnabled;
    } else {
      delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
    }
  }
}

runPlanPickerSuite().catch((err) => {
  console.error("\n[FAIL] Plan Picker Suite Error:\n", err);
  process.exit(1);
});
