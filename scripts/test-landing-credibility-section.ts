import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

async function testRealRouteCode() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_key_for_offline_suite";
  process.env.NODE_ENV = "test";

  // Mock global rate limit client to test route cleanly
  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs_public") || urlStr.includes("companies")) {
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

    // 1. Public route test: 200 for signed-out visitors (no Authorization header)
    const publicReq = new Request("https://careermonke.com/api/stats", {
      method: "GET",
      headers: {
        "x-forwarded-for": "203.0.113.195",
      },
    });

    const res = await GET(publicReq);
    assert.strictEqual(res.status, 200, "GET /api/stats must return HTTP 200 for signed-out visitors");

    // 2. Aggregates only, no rows, no PII
    const data = await res.json();
    assert.strictEqual(typeof data.activeJobs, "number", "activeJobs must be a number aggregate");
    assert.strictEqual(typeof data.companies, "number", "companies must be a number aggregate");
    assert.strictEqual(data.activeJobs, 16423, "activeJobs must reflect database count");
    assert.strictEqual(data.companies, 500, "companies must reflect database count");
    assert.strictEqual(data.rows, undefined, "Must NOT return raw rows");
    assert.strictEqual(data.data, undefined, "Must NOT return data array");
    assert.strictEqual(data.jobs, undefined, "Must NOT return jobs array");
    assert.strictEqual(data.users, undefined, "Must NOT return users");
    assert.strictEqual(data.emails, undefined, "Must NOT return PII emails");

    if (isNegativeControl) {
      throw new Error("Negative control: simulated route failure");
    }

    // 3. Cache-Control 5 min
    const cacheControl = res.headers.get("Cache-Control") || "";
    assert.ok(
      cacheControl.includes("max-age=300") || cacheControl.includes("s-maxage=300"),
      `Cache-Control header must specify 5 min (300s), got: "${cacheControl}"`
    );

    // 4. Rate limiting test on route
    const { _resetStatsRateLimitStore, statsRateLimitStore } = await import("../src/lib/api/sharedRateLimit");
    _resetStatsRateLimitStore();

    // Fill in-memory bucket to verify 429
    statsRateLimitStore.set("198.51.100.99", { count: 60, resetAt: Date.now() + 30000 });

    const rateLimitedReq = new Request("https://careermonke.com/api/stats", {
      method: "GET",
      headers: {
        "x-forwarded-for": "198.51.100.99",
      },
    });

    // Disable shared RPC mock temporarily to test memory rate limit fallback
    (globalThis as any).__mockRateLimitClient = null;
    const rlRes = await GET(rateLimitedReq);
    assert.strictEqual(rlRes.status, 429, "Expected HTTP 429 when rate limit is exceeded");
    const rlData = await rlRes.json();
    assert.ok(rlData.error?.includes("Rate limit"), "Expected rate limit error message");
    assert.ok(rlRes.headers.get("Retry-After"), "Expected Retry-After header on 429");

    console.log("  [PASS] Real route code GET /api/stats: 200 for signed-out visitors, aggregates only (no rows/PII), 5m cache, rate limited");
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

  const heroDemoIdx = pageSrc.indexOf("<LandingInteractiveDemoSection />");
  const credIdx = pageSrc.indexOf("<LandingCredibilitySection />");
  const featuresIdx = pageSrc.indexOf("<LandingFeaturesSection />");

  assert.ok(heroDemoIdx > -1, "LandingInteractiveDemoSection must exist");
  assert.ok(credIdx > -1, "LandingCredibilitySection must exist");
  assert.ok(featuresIdx > -1, "LandingFeaturesSection must exist");

  assert.ok(
    heroDemoIdx < credIdx,
    "LandingCredibilitySection must be placed after the hero demo"
  );
  assert.ok(
    credIdx < featuresIdx,
    "LandingCredibilitySection must be placed before the Features section"
  );

  // 2. Existing sections remain intact
  assert.ok(pageSrc.includes("Find jobs not on LinkedIn/Indeed"), "Hero headline intact");
  assert.ok(pageSrc.includes("Tired of getting auto-rejections?"), "Comparison section intact");
  assert.ok(pageSrc.includes("Meet the monke that fixes your resume."), "AI Resume Monke intact");
  assert.ok(pageSrc.includes("Orissa Lee Patnaik"), "Founder section intact");
  assert.ok(pageSrc.includes("<Testimonials />"), "Testimonials intact");
  assert.ok(pageSrc.includes("Frequently Asked Questions"), "FAQ intact");
  assert.ok(pageSrc.includes('id="contact"'), "Contact section intact");
  assert.ok(pageSrc.includes("<LandingFeaturesSection />"), "Features section intact");
  assert.ok(pageSrc.includes("<Footer />"), "Footer intact");

  console.log("  [PASS] Landing page placement: credibility section anchored between hero demo and Features section; all existing sections intact");

  // 3. Design specifications on LandingCredibilitySection.tsx
  assert.ok(
    compSrc.includes("Real numbers, not promises"),
    "Must include bold large heading 'Real numbers, not promises'"
  );
  assert.ok(
    compSrc.includes("#ECFDF3"),
    "Must use soft green rounded panel with color #ECFDF3"
  );
  assert.ok(
    compSrc.includes("<BrandIcon"),
    "Must include CareerMonke monkey mascot logo (BrandIcon)"
  );

  // Exactly 3 stat rows
  assert.ok(
    compSrc.includes("jobs straight from company career pages"),
    "Row 1 caption must be 'jobs straight from company career pages'"
  );
  assert.ok(
    compSrc.includes("companies scanned"),
    "Row 2 caption must be 'companies scanned'"
  );
  assert.ok(
    compSrc.includes("Direct from employer sites"),
    "Row 3 title must be 'Direct from employer sites'"
  );
  assert.ok(
    compSrc.includes("no reposted aggregator listings"),
    "Row 3 caption must be 'no reposted aggregator listings'"
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
