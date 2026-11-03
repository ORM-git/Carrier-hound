import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-credibility-section.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS] Negative control '--negative-control' exited non-zero (1)");
}

async function testMiddlewareExemption() {
  const { middleware } = await import("../src/middleware");

  // 1. Signed-out GET /api/stats passes (200)
  const statsGetReq = new NextRequest("http://localhost:3000/api/stats", {
    method: "GET",
  });
  const statsGetRes = await middleware(statsGetReq);
  assert.strictEqual(
    statsGetRes.status,
    200,
    "Signed-out GET /api/stats must pass middleware (status 200)"
  );

  // 1b. Signed-out GET /.netlify/functions/stats passes (200)
  const netlifyStatsGetReq = new NextRequest("http://localhost:3000/.netlify/functions/stats", {
    method: "GET",
  });
  const netlifyStatsGetRes = await middleware(netlifyStatsGetReq);
  assert.strictEqual(
    netlifyStatsGetRes.status,
    200,
    "Signed-out GET /.netlify/functions/stats must pass middleware (status 200)"
  );

  // 2. Signed-out POST /api/stats returns 403
  const statsPostReq = new NextRequest("http://localhost:3000/api/stats", {
    method: "POST",
  });
  const statsPostRes = await middleware(statsPostReq);
  assert.strictEqual(
    statsPostRes.status,
    403,
    "Signed-out POST /api/stats must return 403"
  );
  const statsPostBody = await statsPostRes.json();
  assert.strictEqual(statsPostBody.error, "Early access only");

  // 3. Signed-out GET /api/jobs/search returns 403
  const searchReq = new NextRequest("http://localhost:3000/api/jobs/search", {
    method: "GET",
  });
  const searchRes = await middleware(searchReq);
  assert.strictEqual(
    searchRes.status,
    403,
    "Signed-out GET /api/jobs/search must return 403"
  );

  // 4. Other /api paths return 403 for signed-out visitors
  for (const blockedPath of ["/api/jobs/pro", "/api/ai", "/api/track", "/api/admin/stats"]) {
    const res = await middleware(new NextRequest(`http://localhost:3000${blockedPath}`, { method: "GET" }));
    assert.strictEqual(
      res.status,
      403,
      `Signed-out visitor to ${blockedPath} must return 403`
    );
  }

  // 5. Verify no prefix or wildcard match (/api/stats/extra must return 403)
  const prefixReq = new NextRequest("http://localhost:3000/api/stats/extra", {
    method: "GET",
  });
  const prefixRes = await middleware(prefixReq);
  assert.strictEqual(
    prefixRes.status,
    403,
    "GET /api/stats/extra must return 403 (exact match only, no prefix)"
  );

  if (isNegativeControl) {
    throw new Error("Negative control: simulated middleware failure");
  }

  console.log("  [PASS] Middleware: GET /api/stats passes; POST /api/stats, GET /api/jobs/search, /api/stats/extra and other /api return 403");
}

async function testRealRouteCode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_key_for_offline_suite";
  process.env.NODE_ENV = "test";

  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs_public") || urlStr.includes("companies") || urlStr.includes("/jobs")) {
      const count = urlStr.includes("companies") ? "500" : "16423";
      return new Response("", {
        status: 200,
        headers: {
          "content-range": "*/" + count,
          "content-type": "application/json",
        },
      });
    }
    return origFetch(url, opts);
  }) as any;

  try {
    const { GET } = await import("../src/app/api/stats/route");
    const { handler: netlifyStatsHandler } = await import("../netlify/functions/stats");

    // 1. Public route test: 200 for signed-out visitors
    const publicReq = new Request("https://careermonke.com/api/stats", {
      method: "GET",
      headers: {
        "x-forwarded-for": "203.0.113.195",
      },
    });

    const res = await GET(publicReq);
    assert.strictEqual(res.status, 200, "GET /api/stats must return HTTP 200 for signed-out visitors");

    // 2. Aggregates only, no rows, no PII, plus aliases
    const data = await res.json();
    assert.strictEqual(typeof data.activeJobs, "number", "activeJobs must be a number aggregate");
    assert.strictEqual(typeof data.companies, "number", "companies must be a number aggregate");
    assert.strictEqual(data.activeJobs, 16423, "activeJobs must reflect database count");
    assert.strictEqual(data.companies, 500, "companies must reflect database count");
    assert.strictEqual(data.totalJobs, 16423, "totalJobs alias preserved");
    assert.strictEqual(data.companiesScanned, 500, "companiesScanned alias preserved");
    assert.strictEqual(typeof data.jobsToday, "number", "jobsToday alias preserved");
    assert.strictEqual(data.rows, undefined, "Must NOT return raw rows");
    assert.strictEqual(data.data, undefined, "Must NOT return data array");
    assert.strictEqual(data.jobs, undefined, "Must NOT return jobs array");
    assert.strictEqual(data.users, undefined, "Must NOT return users");
    assert.strictEqual(data.emails, undefined, "Must NOT return PII emails");

    // 3. Cache-Control 5 min
    const cacheControl = res.headers.get("Cache-Control") || "";
    assert.ok(
      cacheControl.includes("max-age=300") || cacheControl.includes("s-maxage=300"),
      `Cache-Control header must specify 5 min (300s), got: "${cacheControl}"`
    );

    // 4. Netlify function returns 200 with same contract
    const netlifyRes = await netlifyStatsHandler();
    assert.strictEqual(netlifyRes.statusCode, 200);
    const netlifyData = JSON.parse(netlifyRes.body);
    assert.strictEqual(netlifyData.activeJobs, 16423);
    assert.strictEqual(netlifyData.companies, 500);
    assert.strictEqual(netlifyData.totalJobs, 16423);
    assert.strictEqual(netlifyData.companiesScanned, 500);

    // 5. 503 Fail-Closed on Database Query Error (no counts, Cache-Control: no-store)
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "DB connection timeout" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const dbErrRes = await GET(new Request("https://careermonke.com/api/stats", {
      headers: { "x-forwarded-for": "198.51.100.5" },
    }));
    assert.strictEqual(dbErrRes.status, 503, "DB error must return HTTP 503");
    assert.strictEqual(dbErrRes.headers.get("Cache-Control"), "no-store", "503 must have Cache-Control: no-store");
    const dbErrData = await dbErrRes.json();
    assert.strictEqual(dbErrData.activeJobs, undefined, "503 must NOT return activeJobs count");
    assert.strictEqual(dbErrData.totalJobs, undefined, "503 must NOT return totalJobs count");
    assert.strictEqual(dbErrData.companies, undefined, "503 must NOT return companies count");

    // 5b. Netlify 503 Fail-Closed on Database Query Error
    const netlifyDbErr = await netlifyStatsHandler();
    assert.strictEqual(netlifyDbErr.statusCode, 503, "Netlify DB error must return statusCode 503");
    assert.strictEqual(netlifyDbErr.headers["Cache-Control"], "no-store");
    const netlifyDbErrData = JSON.parse(netlifyDbErr.body);
    assert.strictEqual(netlifyDbErrData.activeJobs, undefined);
    assert.strictEqual(netlifyDbErrData.totalJobs, undefined);

    // 6. 500 Unexpected Error returns fixed "temporarily unavailable" message, NEVER err.message
    const origSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      // Set malformed URL to force unexpected constructor error
      process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-valid-url-at-all";
      const unexpRes = await GET(new Request("https://careermonke.com/api/stats", {
        headers: { "x-forwarded-for": "198.51.100.6" },
      }));
      assert.strictEqual(unexpRes.status, 500);
      assert.strictEqual(unexpRes.headers.get("Cache-Control"), "no-store");
      const unexpData = await unexpRes.json();
      assert.strictEqual(unexpData.error, "temporarily unavailable", "500 must return fixed 'temporarily unavailable' message");
      assert.strictEqual(unexpData.activeJobs, undefined, "500 must NOT return counts");
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = origSupabaseUrl;
    }

    // 7. Anon-key fallback removed: fails closed if service key is missing
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const savedKey2 = process.env.SUPABASE_SERVICE_KEY;
    try {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_SERVICE_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-that-must-not-be-used";

      const failClosedRes = await GET(new Request("https://careermonke.com/api/stats", {
        headers: { "x-forwarded-for": "198.51.100.7" },
      }));
      assert.strictEqual(failClosedRes.status, 500);
      const failClosedData = await failClosedRes.json();
      assert.strictEqual(failClosedData.missingVariable, "SUPABASE_SERVICE_ROLE_KEY", "Must fail closed naming SUPABASE_SERVICE_ROLE_KEY (anon key ignored)");
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
      process.env.SUPABASE_SERVICE_KEY = savedKey2;
    }

    console.log("  [PASS] Real route code GET /api/stats & Netlify stats: 200 aggregates/aliases, 503 fail-closed (no-store, no counts), 500 fixed message, anon key ignored");
  } finally {
    globalThis.fetch = origFetch;
    (globalThis as any).__mockRateLimitClient = undefined;
  }
}

async function testLandingPageStructure() {
  const pagePath = path.join(ROOT, "src", "app", "page.tsx");
  const compPath = path.join(ROOT, "src", "components", "LandingCredibilitySection.tsx");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(compPath), "src/components/LandingCredibilitySection.tsx must exist");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  let compSrc = fs.readFileSync(compPath, "utf8");

  if (isNegativeControl) {
    compSrc += "\nAccess the largest job hub";
  }

  // 1. LandingCredibilitySection rendered between hero demo and Features section
  assert.ok(
    pageSrc.includes("<LandingCredibilitySection />"),
    "LandingCredibilitySection must be rendered in src/app/page.tsx"
  );

  const heroDemoIdx =
    pageSrc.indexOf("<LandingTopArtifact />") > -1
      ? pageSrc.indexOf("<LandingTopArtifact />")
      : pageSrc.indexOf("<LandingInteractiveDemoSection />");
  const credIdx = pageSrc.indexOf("<LandingCredibilitySection />");
  const featuresIdx = pageSrc.indexOf("<LandingFeaturesSection />");

  assert.ok(heroDemoIdx > -1, "Hero demo must exist in src/app/page.tsx");
  assert.ok(credIdx > -1, "LandingCredibilitySection must exist");
  assert.ok(featuresIdx > -1, "LandingFeaturesSection must exist");

  assert.ok(
    heroDemoIdx < credIdx,
    "LandingCredibilitySection must be placed after the hero demo"
  );
  assert.ok(
    featuresIdx < credIdx,
    "LandingFeaturesSection must be placed before LandingCredibilitySection"
  );

  // 2. Existing sections remain intact
  assert.ok(
    pageSrc.includes("Find jobs not on LinkedIn/Indeed") ||
      pageSrc.includes("<LandingTopArtifact"),
    "Hero headline / top artifact intact"
  );
  assert.ok(
    pageSrc.includes("LandingComparisonSection") ||
      pageSrc.includes("Tired of getting auto-rejected?") ||
      pageSrc.includes("Tired of getting auto-rejections?"),
    "Comparison section intact"
  );
  assert.ok(!pageSrc.includes("Meet the monke that fixes your resume."), "AI Resume Monke removed");
  assert.ok(pageSrc.includes("Orissa Lee Patnaik"), "Founder section intact");
  assert.ok(pageSrc.includes("<Testimonials />"), "Testimonials intact");
  assert.ok(pageSrc.includes("Frequently Asked Questions"), "FAQ intact");
  assert.ok(pageSrc.includes('id="contact"'), "Contact section intact");
  assert.ok(pageSrc.includes("<LandingFeaturesSection />"), "Features section intact");
  assert.ok(pageSrc.includes("<Footer />"), "Footer intact");

  console.log("  [PASS] Landing page placement: features section placed after hero demo and before credibility section; all existing sections intact");

  // 3. Design specifications on LandingCredibilitySection.tsx
  assert.ok(
    compSrc.includes("Real numbers, not promises"),
    "Must include bold large heading 'Real numbers, not promises'"
  );
  assert.ok(
    compSrc.includes("#EFF6FF"),
    "Must use soft brand blue rounded panel with color #EFF6FF"
  );
  assert.ok(
    compSrc.includes("<BrandIcon"),
    "Must include CareerMonke monkey mascot logo (BrandIcon)"
  );

  // Exactly 3 stat rows defined in config array and rendered via map
  assert.ok(
    compSrc.includes("STAT_ROWS"),
    "Must define stat rows in config array STAT_ROWS"
  );
  assert.ok(
    compSrc.includes(".map("),
    "Must render rows using a single map"
  );
  assert.ok(
    compSrc.includes("live jobs"),
    "Row 1 caption must be 'live jobs'"
  );
  assert.ok(
    compSrc.includes("companies scanned"),
    "Row 2 caption must be 'companies scanned'"
  );
  assert.ok(
    compSrc.includes("Worldwide roles"),
    "Row 3 title must be 'Worldwide roles'"
  );
  assert.ok(
    compSrc.includes("Filter roles by country"),
    "Row 3 caption must be 'Filter roles by country'"
  );
  assert.ok(
    compSrc.includes("border-dotted"),
    "Stat rows must feature dotted leader lines"
  );
  assert.ok(
    compSrc.includes("#2563EB"),
    "Icons must use brand blue #2563EB accents"
  );
  assert.ok(
    compSrc.includes("Intl.NumberFormat"),
    "Counts must be formatted with Intl.NumberFormat"
  );
  assert.ok(
    compSrc.includes("max-w-[1000px]"),
    "Panel must specify desktop max-width 1000px centered"
  );
  assert.ok(
    compSrc.includes("return null"),
    "Component must return null on error or missing data"
  );
  assert.ok(
    compSrc.includes("if (error || !stats)") || compSrc.includes("if (!stats || error)"),
    "Component must hide the whole section if fetch fails (no zeros or placeholders)"
  );

  // 4. Prohibited content checks
  const prohibitedWords = [
    { text: "Access the largest job hub", desc: "'Access the largest job hub' block" },
    { text: "Today's new jobs", desc: "'Today's new jobs' row" },
    { text: "running-man", desc: "running-man icon" },
    { text: "3x interviews", desc: "unbacked '3x interviews' figure" },
    { text: "80% time saved", desc: "unbacked '80% time saved' figure" },
    { text: "aggregator", desc: "'aggregator' phrase" },
    { text: "career pages", desc: "'career pages' phrase" },
    { text: "employer sites", desc: "'employer sites' phrase" },
  ];

  for (const { text, desc } of prohibitedWords) {
    assert.strictEqual(
      compSrc.includes(text),
      false,
      `LandingCredibilitySection must NOT contain ${desc}`
    );
  }

  console.log("  [PASS] LandingCredibilitySection styling, mascot, 3 rows, dotted leader lines, brand blue #2563EB, Intl.NumberFormat, and zero prohibited phrases verified");
}

async function testSectionHiddenOnErrorContract() {
  const compPath = path.join(ROOT, "src", "components", "LandingCredibilitySection.tsx");
  const compSrc = fs.readFileSync(compPath, "utf8");

  assert.strictEqual(
    compSrc.includes("16,423") || compSrc.includes("16423"),
    false,
    "Component must NOT hardcode 16,423 fallback"
  );
  assert.strictEqual(
    compSrc.includes("500"),
    false,
    "Component must NOT hardcode 500 fallback"
  );
  assert.strictEqual(
    compSrc.includes('<span>0</span>') || compSrc.includes('>0<'),
    false,
    "Component must NOT render literal zero as fallback"
  );

  console.log("  [PASS] Section hidden on error contract verified (no zeros or placeholder constants)");
}

async function main() {
  console.log("================================================================================");
  console.log("   LANDING CREDIBILITY SECTION ('REAL NUMBERS, NOT PROMISES') VERIFICATION      ");
  console.log("================================================================================\n");

  await testMiddlewareExemption();
  await testRealRouteCode();
  await testLandingPageStructure();
  await testSectionHiddenOnErrorContract();

  if (!isNegativeControl) {
    runNegativeControlSubprocess();
  }

  console.log("\n================================================================================");
  console.log("ALL LANDING CREDIBILITY SECTION TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
