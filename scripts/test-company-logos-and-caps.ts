import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { capJobsPerCompany, getLiveJobs } from "../src/lib/jobs/service";
import { extractDomainFromUrl } from "../src/components/CompanyLogo";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_service_key";
process.env.NODE_ENV = "test";

(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
};

async function runSuite() {
  console.log("==================================================================================");
  console.log("   CAREERMONKE COMPANY LOGOS & COMPANY CAPS VERIFICATION SUITE                    ");
  console.log("==================================================================================");
  console.log(`Mode: ${IS_NEGATIVE_CONTROL ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VERIFICATION"}\n`);

  const failures: string[] = [];

  // ====================================================================================
  // TEST 1: capJobsPerCompany Algorithm, Length Preservation & Visible Top-30 Invariants
  // ====================================================================================
  console.log("TEST 1: Verifying capJobsPerCompany (length preservation & max 3 per company in visible top-30)...");

  // 1a. Mass posting scenario: Company A posts 20 jobs, 20 diverse companies post 2 jobs each (total 60 jobs)
  const massPostingJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a-${i}`, company_id: "comp-a", company: "MassiveCorp", title: `Role A${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `b-${i}`, company_id: `comp-b-${i}`, company: `Company_B_${i}`, title: `Role B${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, company_id: `comp-c-${i}`, company: `Company_C_${i}`, title: `Role C${i}` })),
  ];

  const cappedMass = capJobsPerCompany(massPostingJobs, 3, 30);

  // In deliberate negative control mode, corrupt the capped array length and top 30
  if (IS_NEGATIVE_CONTROL) {
    cappedMass.pop(); // corrupt length
    cappedMass.unshift({ id: "corrupt-1", company_id: "comp-a", company: "MassiveCorp", title: "Corrupt 1" });
    cappedMass.unshift({ id: "corrupt-2", company_id: "comp-a", company: "MassiveCorp", title: "Corrupt 2" });
  }

  // Check 1: Length preservation (never drop jobs)
  if (cappedMass.length !== massPostingJobs.length) {
    failures.push(`LENGTH MISMATCH: Input length was ${massPostingJobs.length}, but capped output length is ${cappedMass.length}`);
  } else {
    console.log(`  [PASS] 1a. capJobsPerCompany preserves total length: ${cappedMass.length} === ${massPostingJobs.length} (no jobs dropped)`);
  }

  const visibleTop30 = cappedMass.slice(0, 30);
  const compACountInTop30 = visibleTop30.filter((j) => (j.company_id || "").toLowerCase() === "comp-a").length;

  if (compACountInTop30 > 3) {
    failures.push(`CAP VIOLATION: Company A has ${compACountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1b. Company A capped at ${compACountInTop30}/3 in visible top-30`);
  }

  // 1c. Anonymous / Free user capping using company_id as cap key when company is "Verified Employer"
  const freeUserJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `fa-${i}`, company_id: "comp-free-a", company: "Verified Employer", title: `Free A${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `fb-${i}`, company_id: `comp-free-b-${i}`, company: "Verified Employer", title: `Free B${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `fc-${i}`, company_id: `comp-free-c-${i}`, company: "Verified Employer", title: `Free C${i}` })),
  ];
  const cappedFree = capJobsPerCompany(freeUserJobs, 3, 30);
  assert.strictEqual(cappedFree.length, freeUserJobs.length, "Free user capped list must preserve exact input length");
  const freeAInTop = cappedFree.slice(0, 30).filter((j) => j.company_id === "comp-free-a").length;
  if (freeAInTop > 3) {
    failures.push(`FREE USER CAP VIOLATION: comp-free-a has ${freeAInTop} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1c. company_id cap key correctly caps free user jobs masked as "Verified Employer" (${freeAInTop}/3 in top-30)`);
  }

  // ====================================================================================
  // TEST 2: Real getLiveJobs Mapping with Mocked Row Set (only company_id and logo_url)
  // ====================================================================================
  console.log("\nTEST 2: Verifying real getLiveJobs mapping & pagination beyond 100...");

  let capturedRangeFrom: number | null = null;
  let capturedRangeTo: number | null = null;

  // Create a mock row set where only company_id and logo_url are present (no company name)
  const mockDbRowsBeyond100 = Array.from({ length: 25 }, (_, i) => ({
    id: `job-p5-${i}`,
    title: `Staff Distributed Systems Engineer ${i}`,
    company_id: `comp-uuid-${i % 5}`,
    logo_url: `https://mock.supabase.co/storage/v1/object/public/company-logos/comp-${i % 5}.png`,
    location: "Remote",
    remote: true,
    category: "engineering",
    job_type: "full-time",
    verified: true,
    posted_at: new Date(Date.now() - i * 3600000).toISOString(),
    created_at: new Date(Date.now() - i * 3600000).toISOString(),
  }));

  // Build a query chain mock that records range and returns the mock rows
  const createMockQuery = () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      not: () => chain,
      ilike: () => chain,
      gte: () => chain,
      order: () => chain,
      range: (from: number, to: number) => {
        capturedRangeFrom = from;
        capturedRangeTo = to;
        return Promise.resolve({
          data: mockDbRowsBeyond100,
          count: 500, // Total 500 rows in database
          error: null,
        });
      },
    };
    return chain;
  };

  (globalThis as any).__mockSupabaseClient = {
    from: (table: string) => {
      assert.strictEqual(table, "jobs_public", "getLiveJobs query must target jobs_public for public reads");
      return createMockQuery();
    },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };

  // Run getLiveJobs for page 5, pageSize 25 (from = 100, to = 124)
  const jobsResult = await getLiveJobs({
    page: 5,
    pageSize: 25,
    sortBy: "match",
  });

  // Check 2a: Range parameters passed to query
  if (capturedRangeFrom !== 100 || capturedRangeTo !== 124) {
    failures.push(`PAGINATION ERROR: Expected .range(100, 124) for page 5, received .range(${capturedRangeFrom}, ${capturedRangeTo})`);
  } else {
    console.log(`  [PASS] 2a. Query requested range(${capturedRangeFrom}, ${capturedRangeTo}) - pagination preserved`);
  }

  // Check 2b: Pages beyond 100 still return rows
  if (!jobsResult.jobs || jobsResult.jobs.length !== 25) {
    failures.push(`PAGE BEYOND 100 EMPTY: Page 5 returned ${jobsResult.jobs?.length ?? 0} rows (expected 25)`);
  } else {
    console.log(`  [PASS] 2b. Page 5 (from=100) successfully returned ${jobsResult.jobs.length} rows`);
  }

  // Check 2c: Mapping when only company_id and logo_url are present
  const firstJob = jobsResult.jobs[0];
  if (!firstJob) {
    failures.push("No first job returned from getLiveJobs");
  } else {
    if (firstJob.company !== "Verified Employer") {
      failures.push(`PAID FIELD LEAKAGE: Free user job mapped company='${firstJob.company}' (expected strictly 'Verified Employer')`);
    } else {
      console.log(`  [PASS] 2c. Free user company mapped to '${firstJob.company}' (zero employer name leaked)`);
    }

    if (firstJob.company_id !== "comp-uuid-0" || firstJob.companyId !== "comp-uuid-0") {
      failures.push(`COMPANY ID MAPPING FAIL: Expected 'comp-uuid-0', received company_id='${firstJob.company_id}'`);
    } else {
      console.log(`  [PASS] 2d. company_id and companyId properly mapped: ${firstJob.company_id}`);
    }

    if (!firstJob.logo_url || !firstJob.logoUrl || !firstJob.logo_url.includes("comp-0.png")) {
      failures.push(`LOGO URL MAPPING FAIL: Expected logo_url with comp-0.png, received '${firstJob.logo_url}'`);
    } else {
      console.log(`  [PASS] 2e. logo_url and logoUrl properly mapped: ${firstJob.logo_url}`);
    }
  }

  // ====================================================================================
  // TEST 3: /api/ticker & Netlify ticker Endpoint Capping (Max 2 per company in 20)
  // ====================================================================================
  console.log("\nTEST 3: Verifying /api/ticker and Netlify ticker company capping (max 2 per company)...");

  const now = Date.now();
  const mockTickerDbRows = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `ticker-flood-${i}`,
      company: "DominantCorp",
      company_id: "comp-dom-id",
      title: `Dominant Role ${i}`,
      posted_at: new Date(now - i * 1000).toISOString(),
      created_at: new Date(now - i * 1000).toISOString(),
    })),
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `ticker-other-${i}`,
      company: `Company_${i}`,
      company_id: `comp-other-${i}`,
      title: `Other Role ${i}`,
      posted_at: new Date(now - (i + 20) * 1000).toISOString(),
      created_at: new Date(now - (i + 20) * 1000).toISOString(),
    })),
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockTickerDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockTickerDbRows.length - 1}/${mockTickerDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-dom-id",
            name: "DominantCorp",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/dominant.png",
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

    const req = new Request("http://localhost:3000/api/ticker", { method: "GET" });
    const res = await tickerGet(req);
    const tickerItems = await res.json();

    assert(Array.isArray(tickerItems), "Ticker response must be an array");
    const domCount = tickerItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (domCount > 2) {
      failures.push(`TICKER CAP FAIL (App Route): DominantCorp has ${domCount} jobs in ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 3a. App Router /api/ticker caps DominantCorp at ${domCount}/2 in ticker items`);
    }

    assert(tickerItems.length <= 20, "Ticker must return max 20 items");
    console.log(`  [PASS] 3b. /api/ticker total items capped at ${tickerItems.length} (<= 20)`);

    const netlifyRes = await netlifyTicker();
    const netlifyItems = JSON.parse(netlifyRes.body);
    const netlifyDomCount = netlifyItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (netlifyDomCount > 2) {
      failures.push(`TICKER CAP FAIL (Netlify): DominantCorp has ${netlifyDomCount} jobs in netlify ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 3c. Netlify functions/ticker caps DominantCorp at ${netlifyDomCount}/2 in ticker items`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // ====================================================================================
  // TEST 4: CompanyLogo Component Contract & ATS Host Filtering
  // ====================================================================================
  console.log("\nTEST 4: Verifying CompanyLogo component contract and ATS filtering...");
  const companyLogoPath = path.resolve(__dirname, "../src/components/CompanyLogo.tsx");
  const logoCode = fs.readFileSync(companyLogoPath, "utf-8");

  // 4a. No name-slug guessing
  if (logoCode.includes("cleanCompany.replace") || logoCode.includes(".replace(/[^a-z0-9]/g") || logoCode.includes("`${slug}.com`")) {
    failures.push("CompanyLogo must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 4a. Zero name-slug domain guessing in CompanyLogo");
  }

  // 4b. Rejects ATS hosts
  const greenhouseDomain = extractDomainFromUrl("https://boards.greenhouse.io/stripe/jobs/12345");
  const ashbyDomain = extractDomainFromUrl("https://jobs.ashbyhq.com/linear/54321");
  const leverDomain = extractDomainFromUrl("https://jobs.lever.co/figma/67890");
  const directDomain = extractDomainFromUrl("https://stripe.com/careers/software-engineer");

  if (greenhouseDomain !== "") {
    failures.push(`ATS FILTER FAIL: Greenhouse URL resolved to '${greenhouseDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 4b. Greenhouse ATS URL rejected from unavatar fallback");
  }

  if (ashbyDomain !== "") {
    failures.push(`ATS FILTER FAIL: Ashby URL resolved to '${ashbyDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 4c. Ashby ATS URL rejected from unavatar fallback");
  }

  if (leverDomain !== "") {
    failures.push(`ATS FILTER FAIL: Lever URL resolved to '${leverDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 4d. Lever ATS URL rejected from unavatar fallback");
  }

  if (directDomain !== "stripe.com") {
    failures.push(`DIRECT DOMAIN FAIL: Direct company URL resolved to '${directDomain}' (expected 'stripe.com')`);
  } else {
    console.log(`  [PASS] 4e. Direct company URL resolved to valid domain: '${directDomain}'`);
  }

  // 4f. Uses self-hosted logo first
  if (!logoCode.includes('"self-hosted"') || !logoCode.includes("logoUrl")) {
    failures.push("CompanyLogo must prioritize self-hosted logoUrl first");
  } else {
    console.log("  [PASS] 4f. CompanyLogo prioritizes self-hosted logoUrl first");
  }

  // 4g. Letter tile rendered if both fail or if no non-ATS domain exists
  if (!logoCode.includes("bg-gradient-to-br") || !logoCode.includes("{initial}")) {
    failures.push("CompanyLogo must render letter tile if both fail");
  } else {
    console.log("  [PASS] 4g. CompanyLogo renders neutral letter tile when both fail");
  }

  // ====================================================================================
  // TEST 5: LandingJobsTickerStrip Logo Contract (Zero name-slug guessing)
  // ====================================================================================
  console.log("\nTEST 5: Verifying LandingJobsTickerStrip logo contract...");
  const tickerStripPath = path.resolve(__dirname, "../src/components/LandingJobsTickerStrip.tsx");
  const stripCode = fs.readFileSync(tickerStripPath, "utf-8");

  if (stripCode.includes("cleanCompany.replace") || stripCode.includes("`${slug}.com`")) {
    failures.push("LandingJobsTickerStrip must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 5a. Zero name-slug domain guessing in LandingJobsTickerStrip");
  }

  if (!stripCode.includes("job.logo_url")) {
    failures.push("LandingJobsTickerStrip must use job.logo_url (self-hosted) first");
  } else {
    console.log("  [PASS] 5b. LandingJobsTickerStrip uses job.logo_url (self-hosted) first");
  }

  if (!stripCode.includes("{letter}")) {
    failures.push("LandingJobsTickerStrip must show letter tile if self-hosted logo fails");
  } else {
    console.log("  [PASS] 5c. LandingJobsTickerStrip shows neutral letter tile if self-hosted fails");
  }

  // ====================================================================================
  // TEST 6: Server-side search joins company_id and companies(name, logo_url)
  // ====================================================================================
  console.log("\nTEST 6: Verifying server-side search joins company_id & companies(name, logo_url)...");
  const searchRoutePath = path.resolve(__dirname, "../src/app/api/jobs/search/route.ts");
  const searchCode = fs.readFileSync(searchRoutePath, "utf-8");

  if (!searchCode.includes("companies(name, logo_url)")) {
    failures.push("/api/jobs/search must join companies(name, logo_url) server-side");
  } else {
    console.log("  [PASS] 6a. /api/jobs/search joins companies(name, logo_url) server-side");
  }

  if (!searchCode.includes('company: "Verified Employer"')) {
    failures.push("/api/jobs/search must keep paid-field lock for free users");
  } else {
    console.log("  [PASS] 6b. /api/jobs/search keeps paid-field lock (company: 'Verified Employer')");
  }

  // ====================================================================================
  // TEST 7: Negative Control Mode Handling
  // ====================================================================================
  if (IS_NEGATIVE_CONTROL) {
    if (failures.length > 0) {
      console.error("\n❌ NEGATIVE CONTROL PROVED: Injected failure caught as expected!");
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.error("\n❌ NEGATIVE CONTROL FAILED: Injected failure was NOT caught!");
      process.exit(2);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ VALIDATION FAILED with ${failures.length} errors:`);
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }

  // ====================================================================================
  // TEST 8: Automated Negative Control Subprocess (Proves Non-Zero Exit)
  // ====================================================================================
  console.log("\nTEST 7: Spawning negative control child process to verify non-zero exit...");
  const child = spawnSync("npx", [
    "tsx",
    path.resolve(__dirname, "test-company-logos-and-caps.ts"),
    "--negative-control",
  ], {
    shell: true,
    stdio: "pipe",
  });

  const negStatus = child.status;
  assert.strictEqual(
    negStatus,
    1,
    `Negative control MUST exit with status 1! Received status: ${negStatus}`
  );
  console.log(`  [PASS] 7a. Negative control exited with code ${negStatus} (non-zero exit verified on cap/length violation)`);

  console.log("\n==================================================================================");
  console.log("COMPANY LOGOS & COMPANY CAPS VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
