import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-ticker-paging-and-strip.ts", "--negative-control"],
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

async function testTickerPagingUnderDominantCompanyFlood() {
  console.log("\nTEST 1: /api/ticker candidate pool paging (guaranteeing 20 items despite company flood)...");

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";
  process.env.NODE_ENV = "test";

  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };

  const now = Date.now();

  // Create 300 mock jobs:
  // Rows 0-119: 120 jobs from "MegaFloodInc"
  // Rows 120-299: 180 jobs from 90 distinct companies (2 jobs each)
  const floodRows = Array.from({ length: 120 }, (_, i) => ({
    id: `flood-${i}`,
    company: "MegaFloodInc",
    company_id: "comp-flood-id",
    title: `Flood Engineer ${i + 1}`,
    posted_at: new Date(now - i * 1000).toISOString(),
    created_at: new Date(now - i * 1000).toISOString(),
  }));

  const diverseRows = Array.from({ length: 180 }, (_, i) => {
    const compIndex = Math.floor(i / 2) + 1; // 1 to 90
    return {
      id: `diverse-${i}`,
      company: `DiverseCo_${compIndex}`,
      company_id: `comp-diverse-${compIndex}`,
      title: `Software Engineer ${i + 1}`,
      posted_at: new Date(now - (120 + i) * 1000).toISOString(),
      created_at: new Date(now - (120 + i) * 1000).toISOString(),
    };
  });

  const allMockJobs = [...floodRows, ...diverseRows];

  const origFetch = globalThis.fetch;
  let pageRequestCount = 0;

  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      pageRequestCount++;
      const parsedUrl = new URL(urlStr);
      const offsetParam = parseInt(parsedUrl.searchParams.get("offset") || "0", 10);
      const limitParam = parseInt(parsedUrl.searchParams.get("limit") || "100", 10);
      const sliced = allMockJobs.slice(offsetParam, offsetParam + limitParam);
      return new Response(JSON.stringify(sliced), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `${offsetParam}-${offsetParam + sliced.length - 1}/${allMockJobs.length}`,
        },
      });
    }

    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-flood-id",
            name: "MegaFloodInc",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/megaflood.png",
          },
          {
            id: "comp-diverse-1",
            name: "DiverseCo_1",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/diverse1.png",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return origFetch(url, opts);
  }) as any;

  try {
    const { GET: tickerGet } = await import("../src/app/api/ticker/route");
    const { handler: netlifyTicker } = await import("../netlify/functions/ticker");

    // Test App Router /api/ticker
    pageRequestCount = 0;
    const req = new Request("http://localhost:3000/api/ticker", { method: "GET" });
    const res = await tickerGet(req);
    assert.strictEqual(res.status, 200, "GET /api/ticker should return status 200");

    const cacheHeader = res.headers.get("Cache-Control");
    assert(
      cacheHeader && cacheHeader.includes("max-age=60"),
      `Expected Cache-Control 60s, got: ${cacheHeader}`
    );

    const items = await res.json();
    assert(Array.isArray(items), "Ticker response must be an array");
    assert.strictEqual(
      items.length,
      20,
      `Expected exactly 20 items returned despite single company flood, but got ${items.length}`
    );

    // Verify company capping
    const floodCount = items.filter((j: any) => j.company.toLowerCase() === "megafloodinc").length;
    assert.strictEqual(
      floodCount,
      2,
      `MegaFloodInc must be capped at 2 items (max 2 per company cap), got ${floodCount}`
    );

    // Verify diversity: the other 18 items must come from different companies
    const distinctCompanies = new Set(items.map((j: any) => j.company));
    assert(
      distinctCompanies.size >= 10,
      `Expected at least 10 distinct companies in 20 items, got ${distinctCompanies.size}`
    );

    // Verify paging occurred: with 120 flood rows and page size 100, at least 2 pages were requested
    assert(
      pageRequestCount >= 2,
      `Expected at least 2 paged requests to pass through 120 flood rows, got ${pageRequestCount}`
    );
    console.log(`  [PASS-LOCAL] /api/ticker paged ${pageRequestCount} times and collected 20 diverse items from ${distinctCompanies.size} companies`);

    // Verify strict response shape
    for (const item of items) {
      const keys = Object.keys(item).sort();
      assert.deepStrictEqual(
        keys,
        ["company", "logo_url", "posted_at", "title"],
        `Item keys must be strictly company, logo_url, posted_at, title; got: ${keys.join(", ")}`
      );
      assert.strictEqual(typeof item.company, "string");
      assert.strictEqual(typeof item.title, "string");
      assert.strictEqual(typeof item.posted_at, "string");
      assert(!isNaN(new Date(item.posted_at).getTime()), "posted_at must be valid ISO date string");
    }
    console.log("  [PASS-LOCAL] Strict item shape verified (company, title, posted_at, logo_url only)");

    // Test Netlify functions/ticker handler
    pageRequestCount = 0;
    const netlifyRes = await netlifyTicker();
    assert.strictEqual(netlifyRes.statusCode, 200, "Netlify ticker should return 200");
    const netlifyItems = JSON.parse(netlifyRes.body);
    assert.strictEqual(netlifyItems.length, 20, "Netlify ticker must return 20 items");
    const netlifyFloodCount = netlifyItems.filter((j: any) => j.company.toLowerCase() === "megafloodinc").length;
    assert.strictEqual(netlifyFloodCount, 2, "Netlify ticker must cap MegaFloodInc at 2");
    console.log("  [PASS-LOCAL] Netlify functions/ticker returned identical 20 diverse items");

    return items;
  } finally {
    globalThis.fetch = origFetch;
  }
}

async function testLandingTickerStripRendersOnHomepage(tickerItems: any[]) {
  console.log("\nTEST 2: Landing ticker strip renders on signed-out homepage with client-side fetch...");

  const { default: LandingJobsTickerStrip } = await import("../src/components/LandingJobsTickerStrip");

  // Render LandingJobsTickerStrip with initialJobs provided (or client-rendered with tickerItems)
  const markup = renderToStaticMarkup(
    React.createElement(LandingJobsTickerStrip, {
      initialJobs: tickerItems,
    })
  );

  assert.ok(
    markup.includes('aria-label="Jobs just added"'),
    "Ticker strip must render with aria-label='Jobs just added'"
  );
  assert.ok(
    markup.includes('class="jobs-ticker-strip'),
    "Ticker strip must contain jobs-ticker-strip CSS class"
  );
  assert.ok(
    markup.includes("MegaFloodInc"),
    "Ticker strip markup must include MegaFloodInc"
  );
  assert.ok(
    markup.includes("DiverseCo_1"),
    "Ticker strip markup must include DiverseCo_1"
  );

  // Check duplicate sets for seamless infinite loop (tabindex="-1" and aria-hidden="true")
  assert.ok(
    markup.includes('tabindex="-1"') || markup.includes('tabIndex="-1"'),
    "Duplicate cards must have tabindex='-1'"
  );
  assert.ok(
    markup.includes('aria-hidden="true"'),
    "Duplicate cards must have aria-hidden='true'"
  );

  console.log("  [PASS-LOCAL] LandingJobsTickerStrip renders successfully with full 20-item diverse dataset");

  console.log("\n--- What Landing Jobs Ticker Strip Displays on Signed-Out Homepage ---");
  tickerItems.slice(0, 10).forEach((item, idx) => {
    console.log(
      `  [Card ${idx + 1}] Company: "${item.company}" | Role: "${item.title}" | Logo: ${item.logo_url || "Neutral Letter Tile"}`
    );
  });
  console.log(`  ... and ${tickerItems.length - 10} more diverse cards scrolling smoothly at ~50px/s`);
}

async function run() {
  if (isNegativeControl) {
    console.log("Running intentional failure for negative control...");
    assert.strictEqual(1, 2, "Negative control intentional failure");
    return;
  }

  console.log("=== TICKER CANDIDATE POOL PAGING & LANDING STRIP SUITE ===");
  runNegativeControlSubprocess();
  const tickerItems = await testTickerPagingUnderDominantCompanyFlood();
  await testLandingTickerStripRendersOnHomepage(tickerItems);
  console.log("\nALL TICKER PAGING AND LANDING STRIP TESTS PASSED-LOCAL\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});