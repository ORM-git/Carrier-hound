import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import Module from "module";
import { capJobsPerCompany, getLiveJobs } from "../src/lib/jobs/service";
import { extractDomainFromUrl } from "../src/components/CompanyLogo";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

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

  // 1c. Free user capping using company_id as cap key when company is "Verified Employer"
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
  // TEST 2: Run Real Search Route with Free Token (Assert No logo_url or Company Name in Any Free Job)
  // ====================================================================================
  console.log("\nTEST 2: Running real search route with Free token (asserting zero logo_url & zero company name leakage)...");

  const mockSecretDbRows = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `secret-job-${i}`,
      title: `Senior Infrastructure Engineer ${i}`,
      company: "Top Secret Tech Unicorn",
      company_id: "comp-unicorn-uuid",
      logo_url: "https://secret-cdn.com/unicorn-logo.png",
      location: "San Francisco, CA",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      status: "active",
      is_active: true,
      posted_at: new Date(Date.now() - i * 3600000).toISOString(),
      created_at: new Date(Date.now() - i * 3600000).toISOString(),
    })),
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `other-job-${i}`,
      title: `Backend Developer ${i}`,
      company: `Confidential Enterprise ${i}`,
      company_id: `comp-other-${i}`,
      logo_url: `https://secret-cdn.com/other-${i}.png`,
      location: "New York, NY",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      status: "active",
      is_active: true,
      posted_at: new Date(Date.now() - (i + 15) * 3600000).toISOString(),
      created_at: new Date(Date.now() - (i + 15) * 3600000).toISOString(),
    })),
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockSecretDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockSecretDbRows.length - 1}/${mockSecretDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-unicorn-uuid",
            name: "Top Secret Tech Unicorn",
            logo_url: "https://secret-cdn.com/unicorn-logo.png",
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
    const { GET: searchGet } = await import("../src/app/api/jobs/search/route");
    const { createHandler: createSearchHandler } = await import("../netlify/functions/jobs-search");

    // 2a. Call App Route /api/jobs/search with Free Token (and unauthenticated)
    const freeReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25", {
      method: "GET",
      headers: { Authorization: "Bearer free-user-mock-token" },
    });
    const searchRes = await searchGet(freeReq);
    const searchJson = await searchRes.json();

    assert(Array.isArray(searchJson.jobs) && searchJson.jobs.length > 0, "Route must return jobs array");

    let leakedLogoCount = 0;
    let leakedCompanyNameCount = 0;
    let missingCompanyIdCount = 0;

    for (const job of searchJson.jobs) {
      if (job.logo_url !== null || job.logoUrl !== null) {
        leakedLogoCount++;
      }
      if (job.company !== "Verified Employer") {
        leakedCompanyNameCount++;
      }
      if (!job.company_id && !job.companyId) {
        missingCompanyIdCount++;
      }
    }

    if (leakedLogoCount > 0) {
      failures.push(`LOGO LEAKAGE IN FREE JOBS: ${leakedLogoCount} jobs returned non-null logo_url/logoUrl to free account`);
    } else {
      console.log(`  [PASS] 2a. App Route /api/jobs/search returns logo_url === null and logoUrl === null for all ${searchJson.jobs.length} free jobs`);
    }

    if (leakedCompanyNameCount > 0) {
      failures.push(`COMPANY NAME LEAKAGE: ${leakedCompanyNameCount} jobs leaked real company name instead of 'Verified Employer'`);
    } else {
      console.log(`  [PASS] 2b. App Route /api/jobs/search masks all company names as 'Verified Employer' for free jobs`);
    }

    if (missingCompanyIdCount > 0) {
      failures.push(`MISSING OPAQUE CAP KEY: ${missingCompanyIdCount} jobs lack opaque company_id for capping`);
    } else {
      console.log(`  [PASS] 2c. App Route /api/jobs/search includes opaque company_id for capping on all ${searchJson.jobs.length} free jobs`);
    }

    // 2b. Call Netlify functions/jobs-search with Free Token
    const netlifyHandler = createSearchHandler();
    const netlifyRes = await netlifyHandler({
      httpMethod: "GET",
      queryStringParameters: { page: "1", pageSize: "25" },
      headers: { authorization: "Bearer free-user-mock-token" },
    });
    const netlifyJson = JSON.parse(netlifyRes.body);

    assert(Array.isArray(netlifyJson.jobs) && netlifyJson.jobs.length > 0, "Netlify route must return jobs array");

    let netlifyLeakedLogos = 0;
    let netlifyLeakedNames = 0;

    for (const job of netlifyJson.jobs) {
      if (job.logo_url !== null || job.logoUrl !== null) {
        netlifyLeakedLogos++;
      }
      if (job.company !== "Verified Employer") {
        netlifyLeakedNames++;
      }
    }

    if (netlifyLeakedLogos > 0) {
      failures.push(`NETLIFY LOGO LEAK: ${netlifyLeakedLogos} jobs returned logo_url to free account in Netlify function`);
    } else {
      console.log(`  [PASS] 2d. Netlify functions/jobs-search returns logo_url === null for all ${netlifyJson.jobs.length} free jobs`);
    }

    if (netlifyLeakedNames > 0) {
      failures.push(`NETLIFY NAME LEAK: ${netlifyLeakedNames} jobs leaked company name in Netlify function`);
    } else {
      console.log(`  [PASS] 2e. Netlify functions/jobs-search masks company as 'Verified Employer' for all free jobs`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // ====================================================================================
  // TEST 3: Default getLiveJobs List Actually Caps with company_id Present in Rows
  // ====================================================================================
  console.log("\nTEST 3: Verifying default getLiveJobs list actually caps with company_id present in rows...");

  // Mock database rows for default list: 20 jobs from MassiveCorp (comp-mass-a), 30 from diverse employers (total 50)
  const mockDefaultJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `default-mass-${i}`,
      title: `Platform Engineer ${i}`,
      company: "Real MassiveCorp Name", // database column
      company_id: "comp-mass-a",
      logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/mass-a.png",
      location: "Remote",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      posted_at: new Date(Date.now() - i * 1800000).toISOString(),
      created_at: new Date(Date.now() - i * 1800000).toISOString(),
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `default-div-${i}`,
      title: `Software Developer ${i}`,
      company: `Real Company ${i}`,
      company_id: `comp-div-${i}`,
      logo_url: `https://mock.supabase.co/storage/v1/object/public/company-logos/div-${i}.png`,
      location: "Remote",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      posted_at: new Date(Date.now() - (i + 20) * 1800000).toISOString(),
      created_at: new Date(Date.now() - (i + 20) * 1800000).toISOString(),
    })),
  ];

  let capturedRangeFrom: number | null = null;
  let capturedRangeTo: number | null = null;

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
          data: mockDefaultJobs,
          count: mockDefaultJobs.length,
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

  // Run DEFAULT getLiveJobs call (no search, no company filter, default Recommended parameters)
  const defaultListResult = await getLiveJobs({
    page: 1,
    pageSize: 50,
    sortBy: "match",
  });

  const returnedJobs = defaultListResult.jobs;
  assert(Array.isArray(returnedJobs) && returnedJobs.length > 0, "Default getLiveJobs must return jobs");

  // Check 3a: Total length preserved (never drop jobs)
  if (returnedJobs.length !== mockDefaultJobs.length) {
    failures.push(`DEFAULT LIST LENGTH LOSS: Expected ${mockDefaultJobs.length} jobs, got ${returnedJobs.length}`);
  } else {
    console.log(`  [PASS] 3a. Default getLiveJobs preserves total list length: ${returnedJobs.length} === ${mockDefaultJobs.length}`);
  }

  // Check 3b: company_id is present in all rows
  const missingCompanyIdInDefault = returnedJobs.filter((j) => !j.company_id && !j.companyId).length;
  if (missingCompanyIdInDefault > 0) {
    failures.push(`MISSING company_id IN DEFAULT LIST: ${missingCompanyIdInDefault} jobs lack company_id`);
  } else {
    console.log(`  [PASS] 3b. company_id is present in all ${returnedJobs.length} returned default jobs`);
  }

  // Check 3c: Free user default list has zero company name leakage & zero logo leakage
  const freeNamesLeaked = returnedJobs.filter((j) => j.company !== "Verified Employer").length;
  const freeLogosLeaked = returnedJobs.filter((j) => j.logo_url !== null || j.logoUrl !== null).length;

  if (freeNamesLeaked > 0) {
    failures.push(`COMPANY NAME LEAK IN DEFAULT LIST: ${freeNamesLeaked} jobs leaked real company name`);
  } else {
    console.log(`  [PASS] 3c. Default getLiveJobs masks company as 'Verified Employer' (zero company name leaked from client)`);
  }

  if (freeLogosLeaked > 0) {
    failures.push(`LOGO LEAK IN DEFAULT LIST: ${freeLogosLeaked} jobs returned non-null logoUrl`);
  } else {
    console.log(`  [PASS] 3d. Default getLiveJobs returns logoUrl === null & logo_url === null for free/guest users`);
  }

  // Check 3d: Actually caps using company_id! (comp-mass-a must be <= 3 in visible top-30)
  const top30Default = returnedJobs.slice(0, 30);
  const massACountInTop30 = top30Default.filter((j) => j.company_id === "comp-mass-a").length;

  if (massACountInTop30 > 3) {
    failures.push(`DEFAULT LIST CAP VIOLATION: comp-mass-a has ${massACountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 3e. Default getLiveJobs actually caps comp-mass-a at ${massACountInTop30}/3 in visible top-30 using company_id`);
  }

  // ====================================================================================
  // TEST 4: /api/ticker & Netlify ticker Endpoint Capping (Max 2 per company in 20)
  // ====================================================================================
  console.log("\nTEST 4: Verifying /api/ticker and Netlify ticker company capping (max 2 per company)...");

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

  const origTickerFetch = globalThis.fetch;
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
    return origTickerFetch(url, opts);
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
      console.log(`  [PASS] 4a. App Router /api/ticker caps DominantCorp at ${domCount}/2 in ticker items`);
    }

    assert(tickerItems.length <= 20, "Ticker must return max 20 items");
    console.log(`  [PASS] 4b. /api/ticker total items capped at ${tickerItems.length} (<= 20)`);

    const netlifyRes = await netlifyTicker();
    const netlifyItems = JSON.parse(netlifyRes.body);
    const netlifyDomCount = netlifyItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (netlifyDomCount > 2) {
      failures.push(`TICKER CAP FAIL (Netlify): DominantCorp has ${netlifyDomCount} jobs in netlify ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 4c. Netlify functions/ticker caps DominantCorp at ${netlifyDomCount}/2 in ticker items`);
    }
  } finally {
    globalThis.fetch = origTickerFetch;
  }

  // ====================================================================================
  // TEST 5: CompanyLogo Component Contract & ATS Host Filtering
  // ====================================================================================
  console.log("\nTEST 5: Verifying CompanyLogo component contract and ATS filtering...");
  const companyLogoPath = path.resolve(__dirname, "../src/components/CompanyLogo.tsx");
  const logoCode = fs.readFileSync(companyLogoPath, "utf-8");

  // 5a. No name-slug guessing
  if (logoCode.includes("cleanCompany.replace") || logoCode.includes(".replace(/[^a-z0-9]/g") || logoCode.includes("`${slug}.com`")) {
    failures.push("CompanyLogo must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 5a. Zero name-slug domain guessing in CompanyLogo");
  }

  // 5b. Rejects ATS hosts
  const greenhouseDomain = extractDomainFromUrl("https://boards.greenhouse.io/stripe/jobs/12345");
  const ashbyDomain = extractDomainFromUrl("https://jobs.ashbyhq.com/linear/54321");
  const leverDomain = extractDomainFromUrl("https://jobs.lever.co/figma/67890");
  const directDomain = extractDomainFromUrl("https://stripe.com/careers/software-engineer");

  if (greenhouseDomain !== "") {
    failures.push(`ATS FILTER FAIL: Greenhouse URL resolved to '${greenhouseDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5b. Greenhouse ATS URL rejected from unavatar fallback");
  }

  if (ashbyDomain !== "") {
    failures.push(`ATS FILTER FAIL: Ashby URL resolved to '${ashbyDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5c. Ashby ATS URL rejected from unavatar fallback");
  }

  if (leverDomain !== "") {
    failures.push(`ATS FILTER FAIL: Lever URL resolved to '${leverDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5d. Lever ATS URL rejected from unavatar fallback");
  }

  if (directDomain !== "stripe.com") {
    failures.push(`DIRECT DOMAIN FAIL: Direct company URL resolved to '${directDomain}' (expected 'stripe.com')`);
  } else {
    console.log(`  [PASS] 5e. Direct company URL resolved to valid domain: '${directDomain}'`);
  }

  // 5f. Uses self-hosted logo first
  if (!logoCode.includes('"self-hosted"') || !logoCode.includes("logoUrl")) {
    failures.push("CompanyLogo must prioritize self-hosted logoUrl first");
  } else {
    console.log("  [PASS] 5f. CompanyLogo prioritizes self-hosted logoUrl first");
  }

  // 5g. Letter tile rendered if both fail or if no non-ATS domain exists
  if (!logoCode.includes("bg-gradient-to-br") || !logoCode.includes("{initial}")) {
    failures.push("CompanyLogo must render letter tile if both fail");
  } else {
    console.log("  [PASS] 5g. CompanyLogo renders neutral letter tile when both fail");
  }

  // ====================================================================================
  // TEST 6: LandingJobsTickerStrip Logo Contract (Zero name-slug guessing)
  // ====================================================================================
  console.log("\nTEST 6: Verifying LandingJobsTickerStrip logo contract...");
  const tickerStripPath = path.resolve(__dirname, "../src/components/LandingJobsTickerStrip.tsx");
  const stripCode = fs.readFileSync(tickerStripPath, "utf-8");

  if (stripCode.includes("cleanCompany.replace") || stripCode.includes("`${slug}.com`")) {
    failures.push("LandingJobsTickerStrip must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 6a. Zero name-slug domain guessing in LandingJobsTickerStrip");
  }

  if (!stripCode.includes("job.logo_url")) {
    failures.push("LandingJobsTickerStrip must use job.logo_url (self-hosted) first");
  } else {
    console.log("  [PASS] 6b. LandingJobsTickerStrip uses job.logo_url (self-hosted) first");
  }

  if (!stripCode.includes("{letter}")) {
    failures.push("LandingJobsTickerStrip must show letter tile if self-hosted logo fails");
  } else {
    console.log("  [PASS] 6c. LandingJobsTickerStrip shows neutral letter tile if self-hosted fails");
  }

  // ====================================================================================
  // TEST 7: Server-side search joins company_id & companies(name, logo_url)
  // ====================================================================================
  console.log("\nTEST 7: Verifying server-side search joins company_id & companies(name, logo_url)...");
  const searchRoutePath = path.resolve(__dirname, "../src/app/api/jobs/search/route.ts");
  const searchCode = fs.readFileSync(searchRoutePath, "utf-8");

  if (!searchCode.includes("companies(name, logo_url)")) {
    failures.push("/api/jobs/search must join companies(name, logo_url) server-side");
  } else {
    console.log("  [PASS] 7a. /api/jobs/search joins companies(name, logo_url) server-side");
  }

  if (!searchCode.includes('company: "Verified Employer"')) {
    failures.push("/api/jobs/search must keep paid-field lock for free users");
  } else {
    console.log("  [PASS] 7b. /api/jobs/search keeps paid-field lock (company: 'Verified Employer')");
  }

  // ====================================================================================
  // TEST 8: Negative Control Mode Handling
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
  // TEST 9: Automated Negative Control Subprocess (Proves Non-Zero Exit)
  // ====================================================================================
  console.log("\nTEST 8: Spawning negative control child process to verify non-zero exit...");
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
  console.log(`  [PASS] 8a. Negative control exited with code ${negStatus} (non-zero exit verified on cap/length violation)`);

  console.log("\n==================================================================================");
  console.log("COMPANY LOGOS & COMPANY CAPS VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
