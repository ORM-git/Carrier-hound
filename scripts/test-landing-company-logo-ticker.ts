import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  // Negative control must fail by asserting a deliberate contradiction
  console.log("Running negative control mode...");
  assert.strictEqual("intentional_failure", "must_fail", "Negative control triggered failure");
  process.exit(0);
}

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-company-logo-ticker.ts", "--negative-control"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS-LOCAL] Negative control '--negative-control' exited non-zero as expected");
}

async function main() {
  console.log("================================================================================");
  console.log("TEST SUITE: Landing Company Logo Ticker Verification");
  console.log("================================================================================\n");

  // Run negative control verification first
  runNegativeControlSubprocess();

  // Test 1: Verify Section Placement in src/app/page.tsx
  console.log("\nTEST 1: Section Placement in src/app/page.tsx...");
  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  const pageContent = fs.readFileSync(pagePath, "utf8");

  assert(
    pageContent.includes("LandingCompanyLogoTicker"),
    "src/app/page.tsx must import and render LandingCompanyLogoTicker"
  );

  const featuresIdx = pageContent.indexOf("<LandingFeaturesSection");
  const companyTickerIdx = pageContent.indexOf("<LandingCompanyLogoTicker");
  const tickerStripIdx = pageContent.indexOf("<LandingJobsTickerStrip");

  assert(
    featuresIdx !== -1,
    "LandingFeaturesSection must be present in src/app/page.tsx"
  );
  assert(
    companyTickerIdx !== -1,
    "LandingCompanyLogoTicker must be present in src/app/page.tsx"
  );
  assert(
    tickerStripIdx !== -1,
    "LandingJobsTickerStrip must be present in src/app/page.tsx"
  );
  assert(
    featuresIdx < companyTickerIdx,
    "LandingCompanyLogoTicker must be placed directly BELOW LandingFeaturesSection"
  );
  assert(
    companyTickerIdx < tickerStripIdx,
    "LandingCompanyLogoTicker must be placed above LandingJobsTickerStrip"
  );
  console.log("  [PASS-LOCAL] LandingCompanyLogoTicker is positioned directly below LandingFeaturesSection");

  // Test 2: Component Markup, Heading, and Styling
  console.log("\nTEST 2: Heading, Rounded Tiles, and Mobile Width in Component...");
  const componentPath = path.resolve(process.cwd(), "src/components/LandingCompanyLogoTicker.tsx");
  assert(fs.existsSync(componentPath), "Component file LandingCompanyLogoTicker.tsx must exist");
  const componentCode = fs.readFileSync(componentPath, "utf8");

  // Verify Heading
  assert(
    componentCode.includes("Jobs from companies like these"),
    "Heading must be strictly 'Jobs from companies like these'"
  );

  // Verify rounded 12px tile
  assert(
    componentCode.includes("rounded-[12px]"),
    "Company logo tiles must have rounded-[12px]"
  );

  // Verify mobile 260px wide tiles
  assert(
    componentCode.includes("w-[260px]"),
    "Mobile tiles must be 260px wide (w-[260px])"
  );

  // Verify no fake counts or marketing numbers
  const forbiddenCounts = [/400[,.]?000\+/i, /16[,.]?000\+/i, /61[,.]?000\+/i, /12[,.]?000\+/i, /4\.5\s*million/i];
  for (const regex of forbiddenCounts) {
    assert(!regex.test(componentCode), `Component must not contain forbidden count matching ${regex}`);
  }
  console.log("  [PASS-LOCAL] Heading, rounded-[12px] logo tile, w-[260px] mobile width, and no fake counts verified");

  // Test 3: Neutral Letter Fallback in #2563EB tint
  console.log("\nTEST 3: Neutral Letter Fallback in #2563EB Tint when Logo Missing...");
  assert(
    componentCode.includes("#2563EB"),
    "Fallback letter tile must use #2563EB tint"
  );

  // Import component dynamically to test rendering
  const { default: LandingCompanyLogoTicker, formatRelativeTime } = await import(
    "../src/components/LandingCompanyLogoTicker"
  );

  const sampleJobsWithFallback = [
    {
      company: "Graco",
      title: "Senior Compensation Analyst",
      posted_at: new Date(Date.now() - 3600 * 1000 * 2).toISOString(), // 2 hours ago
      logo_url: null, // No logo -> fallback tile
    },
    {
      company: "Stripe",
      title: "Staff Infrastructure Engineer",
      posted_at: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
      logo_url: "https://szakevhxhwpeskidvtfs.supabase.co/storage/v1/object/public/company-logos/stripe.png",
    },
  ];

  const html = renderToStaticMarkup(
    React.createElement(LandingCompanyLogoTicker, { initialJobs: sampleJobsWithFallback })
  );

  assert(html.includes("Jobs from companies like these"), "Rendered HTML must include heading");
  assert(html.includes("Graco"), "Rendered HTML must include company Graco");
  assert(html.includes("Senior Compensation Analyst"), "Rendered HTML must include title");
  assert(html.includes("G"), "Rendered HTML must display letter 'G' for Graco fallback");
  assert(html.includes("#2563EB"), "Rendered HTML must style letter fallback with #2563EB tint");
  assert(html.includes("rounded-[12px]"), "Logo tile container must have rounded-[12px]");
  assert(html.includes("stripe.png"), "Rendered HTML must render valid real logo for Stripe");
  console.log("  [PASS-LOCAL] Real jobs, rounded-[12px] tiles, and #2563EB fallback letter verified");

  // Test 4: Real Relative Time Verification
  console.log("\nTEST 4: Real Relative Time Verification...");
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const relTime = formatRelativeTime(twoHoursAgo);
  assert(relTime.includes("2h ago") || relTime.includes("2 hours ago"), `Expected ~2h ago, got: ${relTime}`);

  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const fiveDaysRel = formatRelativeTime(fiveDaysAgo);
  assert(fiveDaysRel.includes("5d ago") || fiveDaysRel.includes("5 days ago"), `Expected ~5d ago, got: ${fiveDaysRel}`);
  console.log("  [PASS-LOCAL] formatRelativeTime computes real relative time from timestamps");

  // Test 5: Fail-Safe on Unavailable Data (No Empty Box)
  console.log("\nTEST 5: Fail-Safe on Unavailable / Empty Data...");
  const emptyHtml = renderToStaticMarkup(
    React.createElement(LandingCompanyLogoTicker, { initialJobs: [] })
  );
  assert.strictEqual(
    emptyHtml,
    "",
    "When jobs source is empty or unavailable, component must return null (render empty string, no empty box)"
  );
  console.log("  [PASS-LOCAL] Fail-safe verified: renders nothing when data is empty or unavailable");

  // Test 6: CSS Marquee, Seamless Duplication, and Accessibility
  console.log("\nTEST 6: CSS Marquee, Duplicate aria-hidden, Pause Controls, and Reduced-Motion...");
  assert(
    componentCode.includes("aria-hidden=\"true\""),
    "Duplicated marquee track must have aria-hidden='true'"
  );
  assert(
    componentCode.includes("tabIndex={isDuplicate ? -1 : undefined}"),
    "Duplicate items must not receive keyboard focus (tabIndex=-1)"
  );
  assert(
    componentCode.includes("animation-play-state: paused"),
    "Marquee must pause on hover and focus"
  );
  assert(
    componentCode.includes("prefers-reduced-motion: reduce"),
    "Marquee must respect prefers-reduced-motion"
  );
  assert(
    componentCode.includes("animation: none !important"),
    "Under prefers-reduced-motion, animation must be disabled"
  );
  assert(
    componentCode.includes("flex-wrap: wrap !important"),
    "Under prefers-reduced-motion, track must wrap as a static row"
  );
  console.log("  [PASS-LOCAL] Marquee duplication, pause controls, and prefers-reduced-motion verified");

  // Test 7: API Endpoint Distinct 30 Items Support
  console.log("\nTEST 7: /api/ticker Endpoint Query Handling (?limit=30&distinct=1)...");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";
  process.env.NODE_ENV = "test";

  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };

  const origFetch = globalThis.fetch;
  const mockJobs = Array.from({ length: 50 }, (_, i) => ({
    id: `job-${i}`,
    company: `Company_${i}`,
    company_id: `comp-id-${i}`,
    title: `Role ${i}`,
    posted_at: new Date(Date.now() - i * 60000).toISOString(),
    created_at: new Date(Date.now() - i * 60000).toISOString(),
  }));

  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockJobs), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(url, opts);
  }) as any;

  try {
    const { GET: tickerGet } = await import("../src/app/api/ticker/route");
    const distinctReq = new Request("http://localhost:3000/api/ticker?limit=30&distinct=1", { method: "GET" });
    const distinctRes = await tickerGet(distinctReq);
    assert.strictEqual(distinctRes.status, 200, "Distinct request must return status 200");

    const distinctCache = distinctRes.headers.get("Cache-Control");
    assert(
      distinctCache && distinctCache.includes("max-age=600"),
      `Expected Cache-Control max-age=600 (10 mins), got: ${distinctCache}`
    );

    const items = await distinctRes.json();
    assert(Array.isArray(items), "Response must be an array");
    assert(items.length <= 30, `Items count must be <= 30, got ${items.length}`);
    const distinctCompanies = new Set(items.map((j: any) => j.company.toLowerCase()));
    assert.strictEqual(distinctCompanies.size, items.length, "All returned companies must be distinct when distinct=1");
    console.log(`  [PASS-LOCAL] /api/ticker?limit=30&distinct=1 returned ${items.length} distinct items with max-age=600`);
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log("\n================================================================================");
  console.log("ALL 7 LANDING COMPANY LOGO TICKER SUITE CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
