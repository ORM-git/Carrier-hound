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

async function runPricingHeaderFirstRenderSuite() {
  console.log("================================================================================");
  console.log("   PRICING PAGE FIRST-RENDER HEADER & HYDRATION TEST SUITE [PASS-LOCAL]         ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (server HTML must NOT equal first client render)...\n");
    // Deliberately assert mismatch between server HTML and first client render
    delete (globalThis as any).window;
    delete (globalThis as any).location;
    const serverHtml = renderWithRouter(React.createElement(PricingPage));
    (globalThis as any).window = globalThis;
    (globalThis as any).location = new URL("http://localhost:3000/pricing");
    const clientMarkup = renderWithRouter(React.createElement(PricingPage));

    assert.notStrictEqual(
      serverHtml,
      clientMarkup,
      "Negative control expected mismatch: Server HTML must equal first client render!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Server HTML equals First Client Render (Zero Hydration Mismatch)
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying Server HTML strictly equals first client render (user=null)...");
  
  // Render Server HTML (window is undefined, as in static export / SSR)
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).location;
  const serverHtml = renderWithRouter(React.createElement(PricingPage));

  // Render First Client Render (window is defined, synchronous first pass before useEffect)
  (globalThis as any).window = globalThis;
  (globalThis as any).location = new URL("http://localhost:3000/pricing");
  (globalThis as any).localStorage = {
    getItem: (key: string) => (key === "careermonke_user_email" ? "stale-cached@example.com" : null),
  };
  const firstClientMarkup = renderWithRouter(React.createElement(PricingPage));

  // Assert exact equality: Server HTML === First Client Render (no hydration mismatch)
  assert.strictEqual(
    firstClientMarkup,
    serverHtml,
    "First client render MUST strictly equal server HTML to prevent hydration mismatch!"
  );

  // Assert LoggedInAppShell elements are rendered on both
  assert.ok(
    serverHtml.includes("data-testid=\"app-top-bar\""),
    "Server HTML must render AppTopBar (settled header shell)"
  );
  assert.ok(
    serverHtml.includes("data-testid=\"app-icon-rail\""),
    "Server HTML must render AppIconRail (settled desktop sidebar rail)"
  );
  assert.ok(
    serverHtml.includes("PRICING"),
    "Server HTML must render pageLabel 'PRICING' in the top bar"
  );

  // Assert GuideHeader is completely absent
  assert.strictEqual(
    serverHtml.includes("data-testid=\"guide-header\""),
    false,
    "Server HTML must NOT contain GuideHeader testid"
  );
  assert.strictEqual(
    serverHtml.includes("Explore") && serverHtml.includes("Guides") && serverHtml.includes("Worldwide Remote"),
    false,
    "Server HTML must NOT contain GuideHeader public navigation links"
  );
  console.log("  -> [PASS-LOCAL] Server HTML strictly equals first client render (user=null, zero hydration mismatch).");

  // ---------------------------------------------------------------------------
  // TEST 2: No Fake User Object ("local-user") and No localStorage in useState
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying no fake 'local-user' object is created on initial render...");

  assert.strictEqual(
    firstClientMarkup.includes("local-user"),
    false,
    "First render must NOT contain any fake user 'local-user' reference"
  );
  assert.strictEqual(
    firstClientMarkup.includes("stale-cached@example.com"),
    false,
    "First client render must NOT read localStorage in useState initializer before session settles"
  );
  console.log("  -> [PASS-LOCAL] Verified zero fake user creation; user is strictly null before session settles.");

  // ---------------------------------------------------------------------------
  // TEST 3: Pricing Page Content & Copy Integrity (Visible Plans, Prices, Upgrade CTA)
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying visible pricing plans, copy, prices, and disabled Upgrade CTA...");
  
  const markup = renderWithRouter(React.createElement(PricingPage));
  assert.ok(
    markup.includes("Get more interviews with CareerMonke Premium"),
    "Pricing page must include the heading 'Get more interviews with CareerMonke Premium'"
  );
  assert.ok(
    markup.includes("Payments opening soon"),
    "Pricing page must retain the Upgrade CTA with 'Payments opening soon'"
  );
  assert.ok(
    markup.includes('href="/login"'),
    "Pricing page must render Upgrade CTA linking to login/signup for logged-out visitors"
  );
  assert.ok(
    markup.includes("Billed weekly"),
    "Pricing page must include the Weekly plan row"
  );
  assert.ok(
    markup.includes("₹692"),
    "Pricing page must include the Weekly price ₹692"
  );
  assert.ok(
    markup.includes("billed monthly"),
    "Pricing page must include the Monthly plan row"
  );
  assert.ok(
    markup.includes("₹1,499"),
    "Pricing page must include the Monthly price ₹1,499"
  );
  assert.ok(
    markup.includes("billed every 3 months"),
    "Pricing page must include the Quarterly plan row"
  );
  assert.ok(
    markup.includes("₹3,999"),
    "Pricing page must include the Quarterly price ₹3,999"
  );
  assert.ok(
    markup.includes("Free Plan") && markup.includes("₹0.00"),
    "Pricing page must include the Free Plan row"
  );
  console.log("  -> [PASS-LOCAL] All visible plan picker plans, copy, and CTAs intact.");

  // ---------------------------------------------------------------------------
  // TEST 4: Source Code Guard Validation in src/app/pricing/page.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying source code has zero GuideHeader, no localStorage in useState, and unconditional shell...");
  const pagePath = path.resolve(process.cwd(), "src/app/pricing/page.tsx");
  const source = fs.readFileSync(pagePath, "utf-8");

  assert.strictEqual(
    source.includes("GuideHeader"),
    false,
    "src/app/pricing/page.tsx must NOT contain any references to GuideHeader"
  );
  assert.strictEqual(
    source.includes("local-user"),
    false,
    "src/app/pricing/page.tsx must NOT create any fake 'local-user' object"
  );
  assert.strictEqual(
    source.includes("useState<User | null>(() =>"),
    false,
    "src/app/pricing/page.tsx must NOT read localStorage inside useState initializer"
  );
  assert.ok(
    source.includes("const [user, setUser] = useState<User | null>(null);"),
    "src/app/pricing/page.tsx must initialize user strictly to null"
  );
  assert.ok(
    source.includes("<LoggedInAppShell pageLabel=\"PRICING\" user={user} isPro={isPro}>"),
    "src/app/pricing/page.tsx must unconditionally return LoggedInAppShell with pageLabel 'PRICING'"
  );
  console.log("  -> [PASS-LOCAL] Source code clean: 0 GuideHeader references, user=null init, unconditional LoggedInAppShell.");

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
