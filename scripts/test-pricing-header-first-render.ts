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

// In-memory mock localStorage for Node test environment
class MockLocalStorage {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

async function runPricingHeaderFirstRenderSuite() {
  console.log("================================================================================");
  console.log("   PRICING PAGE FIRST-RENDER HEADER & AUTH SETTLED TEST SUITE [PASS-LOCAL]     ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (asserting app-top-bar must NOT be rendered on first render)...\n");
    const markup = renderWithRouter(React.createElement(PricingPage));
    // Deliberately assert invalid condition: expecting app-top-bar to be absent on first render
    assert.strictEqual(
      markup.includes("data-testid=\"app-top-bar\""),
      false,
      "Negative control expected mismatch: First render MUST render app-top-bar!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: First Render Markup: LoggedInAppShell + AppTopBar ('PRICING') and NO GuideHeader
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying /pricing first render matches LoggedInAppShell without GuideHeader flash...");
  
  // Setup clean window / localStorage environment
  (globalThis as any).window = globalThis;
  (globalThis as any).localStorage = new MockLocalStorage();

  const markupInitial = renderWithRouter(React.createElement(PricingPage));

  // Assert LoggedInAppShell elements are rendered on the very first frame
  assert.ok(
    markupInitial.includes("data-testid=\"app-top-bar\""),
    "First render MUST render AppTopBar (settled header shell)"
  );
  assert.ok(
    markupInitial.includes("data-testid=\"app-icon-rail\""),
    "First render MUST render AppIconRail (settled desktop sidebar rail)"
  );
  assert.ok(
    markupInitial.includes("PRICING"),
    "First render MUST render pageLabel 'PRICING' in the top bar"
  );

  // Assert GuideHeader is completely absent
  assert.strictEqual(
    markupInitial.includes("data-testid=\"guide-header\""),
    false,
    "First render must NOT contain GuideHeader testid"
  );
  assert.strictEqual(
    markupInitial.includes("Explore") && markupInitial.includes("Guides") && markupInitial.includes("Worldwide Remote"),
    false,
    "First render must NOT contain GuideHeader public navigation links"
  );
  console.log("  -> [PASS-LOCAL] First render renders LoggedInAppShell with AppTopBar (PRICING); GuideHeader absent.");

  // ---------------------------------------------------------------------------
  // TEST 2: First Render Auth State matches Settled State when cached session exists
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying first render header immediately displays authenticated user state with cached email...");
  
  (globalThis as any).localStorage.setItem("careermonke_user_email", "patricia.candidate@example.com");

  const markupWithCachedUser = renderWithRouter(React.createElement(PricingPage));

  const headerMatch = markupWithCachedUser.match(/<header data-testid="app-top-bar"[\s\S]*?<\/header>/);
  assert.ok(headerMatch, "app-top-bar header must exist in markup");
  const headerMarkup = headerMatch[0];

  // Should immediately display user initials "P" and displayName "Patricia"
  assert.ok(
    headerMarkup.includes(">P<") && headerMarkup.includes("Patricia"),
    "Header on first render with cached user email MUST display user initials/avatar immediately"
  );
  // Header should NOT display guest action buttons "Log in" / "Get started"
  assert.strictEqual(
    headerMarkup.includes("Log in"),
    false,
    "Header on first render with cached user email must NOT render guest 'Log in' button"
  );
  assert.strictEqual(
    headerMarkup.includes("Get started"),
    false,
    "Header on first render with cached user email must NOT render guest 'Get started' button"
  );
  // Should display the settled plan pill ("Free")
  assert.ok(
    headerMarkup.includes("Free"),
    "Header on first render MUST display the default settled plan status ('Free')"
  );
  console.log("  -> [PASS-LOCAL] First render header renders avatar ('P' / 'Patricia') and plan pill ('Free') without guest buttons.");

  // ---------------------------------------------------------------------------
  // TEST 3: Pricing Page Content & Copy Integrity (Unmodified Plans, CTAs, FAQs)
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying pricing plans, copy, and CTAs remain completely intact...");
  
  // Test both billingDisabled and billingEnabled modes
  assert.ok(
    markupInitial.includes("Pro launching soon") || markupInitial.includes("Direct Career Radar, Zero Fluff"),
    "Pricing page must render either standard pricing hero or launching soon banner depending on flag"
  );

  // Render with NEXT_PUBLIC_BILLING_ENABLED=true to verify full pricing plan cards and CTAs
  const prevEnv = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  try {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    const markupBilling = renderWithRouter(React.createElement(PricingPage));
    assert.ok(
      markupBilling.includes("Subscribe with Razorpay (Test)"),
      "Pricing page must retain the India domestic CTA when billing is enabled"
    );
    assert.ok(
      markupBilling.includes("Coming soon"),
      "Pricing page must retain the International CTA"
    );
    assert.ok(
      markupBilling.includes("Transparent Pricing"),
      "Pricing hero badge must be preserved"
    );
    assert.ok(
      markupBilling.includes("Direct Career Radar, Zero Fluff"),
      "Pricing heading must be preserved"
    );
    assert.ok(
      markupBilling.includes("Frequently Asked Questions"),
      "Pricing FAQ section must be preserved"
    );
  } finally {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = prevEnv;
  }
  console.log("  -> [PASS-LOCAL] All pricing plans, copy, CTAs, and FAQ cards intact.");

  // ---------------------------------------------------------------------------
  // TEST 4: Source Code Guard Validation in src/app/pricing/page.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying source code has zero GuideHeader imports or conditional shell branches...");
  const pagePath = path.resolve(process.cwd(), "src/app/pricing/page.tsx");
  const source = fs.readFileSync(pagePath, "utf-8");

  assert.strictEqual(
    source.includes("GuideHeader"),
    false,
    "src/app/pricing/page.tsx must NOT contain any references to GuideHeader"
  );
  assert.strictEqual(
    source.includes("if (user) {\n    return (\n      <LoggedInAppShell") ||
    source.includes("if (user) {\r\n    return (\r\n      <LoggedInAppShell"),
    false,
    "src/app/pricing/page.tsx must NOT conditionally switch between different outer shells"
  );
  assert.ok(
    source.includes("<LoggedInAppShell pageLabel=\"PRICING\" user={user} isPro={isPro}>"),
    "src/app/pricing/page.tsx must unconditionally return LoggedInAppShell with pageLabel 'PRICING'"
  );
  console.log("  -> [PASS-LOCAL] Source code clean: 0 GuideHeader references, unconditional LoggedInAppShell shell.");

  // ---------------------------------------------------------------------------
  // TEST 5: Subprocess Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Confirming negative control fails with non-zero exit code...");
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
  console.log("   ALL PRICING FIRST-RENDER TESTS PASSED SUCCESSFULLY [PASS-LOCAL]              ");
  console.log("================================================================================");
}

runPricingHeaderFirstRenderSuite().catch((err) => {
  console.error("\n[FAIL] Pricing Header First Render Suite Error:\n", err);
  process.exit(1);
});
