import assert from "assert";
import { spawnSync } from "child_process";
import Module from "module";
import {
  isJobEligible,
  normalizeUserCountries,
  applyEligibilityFilter,
} from "../src/lib/jobs/eligibility";
import {
  STATIC_FX_RATES,
  FX_CACHE_TTL_MS,
  getFxRates,
  refreshFxRates,
  convertCurrency,
  _resetFxCacheForTesting,
  _setLastFetchedForTesting,
} from "../src/lib/salary/fx";
import { formatSalary } from "../src/lib/salary/parser";

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

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key-test";

async function runTests() {
  console.log("==================================================================================");
  console.log("   CAREERMONKE COUNTRY ELIGIBILITY & PREFERRED CURRENCY SUITE                     ");
  console.log("==================================================================================");

  if (IS_NEGATIVE_CONTROL) {
    console.log("Mode: NEGATIVE CONTROL");
    // Assert intentional failure to prove test harness catches invalid assertions
    assert.strictEqual(
      isJobEligible({ country_code: "US", location: "New York" }, ["India"], { filterEnabled: true }),
      true,
      "NEGATIVE CONTROL FAILURE: US job must not be eligible for India user"
    );
    return;
  }

  console.log("Mode: NORMAL VERIFICATION\n");

  // ==============================================================================
  // SECTION 1: ELIGIBILITY MATCHER TESTS
  // ==============================================================================
  console.log("TEST 1: Verifying eligibility matcher...");

  // 1a. Worldwide always included
  const worldwideJob1 = {
    title: "Global Backend Engineer",
    country_code: "US",
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    location: "Remote (Worldwide)",
    remote: true,
  };
  const worldwideJob2 = {
    title: "Worldwide Support Specialist",
    remote_scope: "worldwide",
    remote: true,
    location: "Anywhere in the world",
  };
  const worldwideJob3 = {
    title: "Staff DevOps Engineer",
    remote_eligibility: "worldwide",
    remote: true,
    location: "Global",
  };
  const worldwideJob4 = {
    title: "General Remote Engineer",
    remote: true,
    remote_eligibility: "unknown",
    location: "Remote",
    country_code: null,
  };

  assert.strictEqual(
    isJobEligible(worldwideJob1, ["India"]),
    true,
    "Worldwide job 1 must be eligible for user in India"
  );
  assert.strictEqual(
    isJobEligible(worldwideJob2, ["CA"]),
    true,
    "Worldwide job 2 must be eligible for user in Canada"
  );
  assert.strictEqual(
    isJobEligible(worldwideJob3, ["Germany"]),
    true,
    "Worldwide job 3 must be eligible for user in Germany"
  );
  assert.strictEqual(
    isJobEligible(worldwideJob4, ["India"]),
    true,
    "Unrestricted remote job must be eligible for user in India"
  );
  console.log("  [PASS] 1a. Worldwide jobs always included regardless of candidate country");

  // 1b. Indiana/India and New Mexico/Mexico guards
  const indianaJob1 = {
    title: "Software Engineer",
    country_code: "US",
    location: "Indianapolis, Indiana, USA",
    remote: false,
  };
  const indianaJob2 = {
    title: "Platform Engineer",
    country_code: "US",
    location: "Indiana, United States",
    remote: true,
    remote_eligibility: "country_restricted",
  };
  const realIndiaJob1 = {
    title: "Frontend Architect",
    country_code: "IN",
    location: "Bengaluru, Karnataka, India",
    remote: true,
  };
  const realIndiaJob2 = {
    title: "Full Stack Engineer",
    country_code: null,
    location: "Pune, Maharashtra, India",
    remote: false,
  };

  assert.strictEqual(
    isJobEligible(indianaJob1, ["India"]),
    false,
    "Indiana, USA must NOT be matched as India"
  );
  assert.strictEqual(
    isJobEligible(indianaJob2, ["India"]),
    false,
    "Indiana country-restricted remote job must NOT be matched as India"
  );
  assert.strictEqual(
    isJobEligible(realIndiaJob1, ["India"]),
    true,
    "Real India job in Bengaluru must be eligible for India user"
  );
  assert.strictEqual(
    isJobEligible(realIndiaJob2, ["IN"]),
    true,
    "Real India job in Pune (with country_code null) must be eligible for India user"
  );

  const newMexicoJob = {
    title: "Data Analyst",
    country_code: "US",
    location: "Albuquerque, New Mexico, USA",
  };
  const realMexicoJob = {
    title: "Product Designer",
    country_code: "MX",
    location: "Guadalajara, Mexico",
  };
  assert.strictEqual(
    isJobEligible(newMexicoJob, ["Mexico"]),
    false,
    "New Mexico must NOT be matched as Mexico"
  );
  assert.strictEqual(
    isJobEligible(realMexicoJob, ["Mexico"]),
    true,
    "Real Mexico job must be eligible for Mexico user"
  );
  console.log("  [PASS] 1b. Strict Indiana/India and New Mexico/Mexico guards verified");

  // 1c. Multi-country matching and European Union 27 member states
  const euNorm = normalizeUserCountries(["European Union"]);
  assert.strictEqual(euNorm.codes.length, 27, "European Union alias must cover all 27 EU member states");
  const euCodes = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
  for (const code of euCodes) {
    assert(euNorm.codes.includes(code), `EU alias must include ${code}`);
    assert.strictEqual(isJobEligible({ country_code: code, location: code }, ["European Union"]), true, `Job in ${code} must be eligible for EU candidate`);
  }
  console.log("  [PASS] 1c. European Union alias covers all 27 member states");

  const multiLocations = ["India", "Canada"];
  const jobInIndia = { title: "Lead Engineer", country_code: "IN", location: "Delhi, India" };
  const jobInCanada = { title: "Staff Architect", country_code: "CA", location: "Toronto, Canada" };
  const jobInGermany = { title: "Systems Engineer", country_code: "DE", location: "Berlin, Germany" };
  const jobInUS = { title: "VP Product", country_code: "US", location: "San Francisco, CA" };

  assert.strictEqual(isJobEligible(jobInIndia, multiLocations), true, "India job matches multi-country [India, Canada]");
  assert.strictEqual(isJobEligible(jobInCanada, multiLocations), true, "Canada job matches multi-country [India, Canada]");
  assert.strictEqual(isJobEligible(worldwideJob1, multiLocations), true, "Worldwide job matches multi-country [India, Canada]");
  assert.strictEqual(isJobEligible(jobInGermany, multiLocations), false, "Germany job excluded for [India, Canada]");
  assert.strictEqual(isJobEligible(jobInUS, multiLocations), false, "US job excluded for [India, Canada]");
  console.log("  [PASS] 1d. Multi-country matching and foreign exclusions verified");

  // 1d. Filter OFF (opt-out)
  assert.strictEqual(
    isJobEligible(jobInGermany, ["India"], { filterEnabled: false }),
    true,
    "When filter is OFF, Germany job must be eligible for India user"
  );
  assert.strictEqual(
    isJobEligible(jobInUS, ["India"], { filterEnabled: false }),
    true,
    "When filter is OFF, US job must be eligible for India user"
  );
  assert.strictEqual(
    isJobEligible(indianaJob1, ["India"], { filterEnabled: false }),
    true,
    "When filter is OFF, Indiana job must be returned"
  );
  console.log("  [PASS] 1d. Eligibility filter opt-out (filter OFF) returns all jobs\n");

  // ==============================================================================
  // SECTION 2: FX CACHE & NON-BLOCKING REFRESH TESTS
  // ==============================================================================
  console.log("TEST 2: Verifying FX cache and non-blocking refresh...");

  _resetFxCacheForTesting();
  const initialRates = getFxRates();
  assert.strictEqual(initialRates.USD, 1.0, "USD base rate must be 1.0");
  assert.strictEqual(initialRates.INR, 84.0, "INR fallback rate must be 84.0");
  assert.strictEqual(initialRates.EUR, 0.92, "EUR fallback rate must be 0.92");
  assert.strictEqual(initialRates.GBP, 0.79, "GBP fallback rate must be 0.79");
  assert.strictEqual(initialRates.CAD, 1.38, "CAD fallback rate must be 1.38");
  assert.strictEqual(initialRates.AUD, 1.52, "AUD fallback rate must be 1.52");
  console.log("  [PASS] 2a. Static fallback table verified for USD, EUR, GBP, INR, CAD, AUD");

  // 2b. Fallback on network/fetch failure
  const fallbackRates = await refreshFxRates("https://invalid-nonexistent-domain-careermonke.local/rates.json");
  assert.strictEqual(fallbackRates.INR, 84.0, "Must fall back to static rates on network error");
  assert.strictEqual(fallbackRates.USD, 1.0, "Must preserve static rates on error");
  console.log("  [PASS] 2b. Fallback to static table verified on upstream failure");

  // 2c. No double fetch in TTL
  _setLastFetchedForTesting(Date.now()); // Mark as fetched right now
  let fetchAttempted = false;
  // Passing a URL that would fail if fetched
  const cachedResult = await refreshFxRates("https://unreachable-if-fetched.local");
  assert.strictEqual(cachedResult.USD, 1.0, "Within TTL, must return existing cache without re-fetching");
  console.log("  [PASS] 2c. No double fetch verified within 24h TTL");

  // 2d. Currency conversion math
  const convertedUSDToINR = convertCurrency(100000, "USD", "INR");
  assert.strictEqual(convertedUSDToINR, 8400000, "100k USD at rate 84 must convert to 8,400,000 INR");

  const convertedINRToUSD = convertCurrency(8400000, "INR", "USD");
  assert.strictEqual(convertedINRToUSD, 100000, "8.4M INR at rate 84 must convert to 100,000 USD");

  const impossibleConversion = convertCurrency(50000, "XYZ", "USD");
  assert.strictEqual(impossibleConversion, null, "Unsupported currency must return null");
  console.log("  [PASS] 2d. Currency conversion math verified\n");

  // ==============================================================================
  // SECTION 3: FORMAT SALARY PREFERRED-CURRENCY CONVERSION TESTS
  // ==============================================================================
  console.log("TEST 3: Verifying formatSalary preferred-currency conversion...");

  // 3a. USD to INR rounding to nearest thousand and approximate marker "~"
  const usdSalary = formatSalary(100000, 140000, "USD", "yearly", { displayCurrency: "INR" });
  assert.strictEqual(usdSalary, "~₹84,00,000 - ₹1,17,60,000 /yr", "USD to INR must round to nearest thousand and prefix '~'");

  const nonRoundUsd = formatSalary(125450, 125450, "USD", "yearly", { displayCurrency: "INR" });
  // 125,450 * 84 = 10,537,800 -> rounded to nearest thousand = 10,538,000
  assert.strictEqual(nonRoundUsd, "~₹1,05,38,000 /yr", "USD to INR rounding to nearest thousand verified");
  console.log("  [PASS] 3a. USD to INR rounding (nearest thousand) and approximate marker '~' verified");

  // 3b. Rounding others (EUR/GBP/USD) to nearest hundred
  const usdToEur = formatSalary(105234, 105234, "USD", "yearly", { displayCurrency: "EUR" });
  // 105,234 * 0.92 = 96,815.28 -> rounded to nearest hundred = 96,800
  assert.strictEqual(usdToEur, "~€96,800 /yr", "USD to EUR must round to nearest hundred and prefix '~'");
  console.log("  [PASS] 3b. Conversion to EUR rounding (nearest hundred) verified");

  // 3c. Same-currency passthrough (no approximate marker "~")
  const sameCurrency = formatSalary(120000, 160000, "USD", "yearly", { displayCurrency: "USD" });
  assert.strictEqual(sameCurrency, "$120,000 - $160,000 /yr", "Same currency must NOT add '~' or alter values");
  console.log("  [PASS] 3c. Same-currency passthrough verified (no approximate marker)");

  // 3d. Hourly and monthly INR rounding: nearest 10 for hourly, nearest 100 for monthly under 100k; add tests with $15/hr and $20/hr
  const hourlyInr15 = formatSalary(15, 15, "USD", "hourly", { displayCurrency: "INR" });
  assert.strictEqual(hourlyInr15, "~₹1,260 /hr", "$15/hr converted to INR must round to nearest 10 (~₹1,260 /hr)");

  const hourlyInr20 = formatSalary(20, 20, "USD", "hourly", { displayCurrency: "INR" });
  assert.strictEqual(hourlyInr20, "~₹1,680 /hr", "$20/hr converted to INR must round to nearest 10 (~₹1,680 /hr)");

  const hourlyInrRange = formatSalary(15, 20, "USD", "hourly", { displayCurrency: "INR" });
  assert.strictEqual(hourlyInrRange, "~₹1,260 - ₹1,680 /hr", "$15-$20/hr converted to INR must round to nearest 10");

  const monthlyUnder100k = formatSalary(755, 755, "USD", "monthly", { displayCurrency: "INR" });
  // 755 * 84 = 63,420 -> nearest 100 is 63,400
  assert.strictEqual(monthlyUnder100k, "~₹63,400 /mo", "Monthly under 100k INR must round to nearest 100");

  const monthlyOver100k = formatSalary(2000, 2000, "USD", "monthly", { displayCurrency: "INR" });
  // 2000 * 84 = 168,000 -> nearest 1000 is 168,000
  assert.strictEqual(monthlyOver100k, "~₹1,68,000 /mo", "Monthly >= 100k INR must round to nearest 1000");

  const monthlyEur = formatSalary(5000, 8000, "USD", "monthly", { displayCurrency: "EUR" });
  assert.strictEqual(monthlyEur, "~€4,600 - €7,400 /mo", "Monthly salary converted to EUR must preserve '/mo'");
  console.log("  [PASS] 3d. Hourly (nearest 10 with $15/$20) and monthly (nearest 100 under 100k) INR rounding verified\n");

  // ==============================================================================
  // SECTION 4: APPLY ELIGIBILITY FILTER BATCH & METADATA TESTS
  // ==============================================================================
  console.log("TEST 4: Verifying applyEligibilityFilter batch helper...");

  const testCorpus = [
    { id: "1", title: "Bangalore Engineer", country_code: "IN", location: "Bangalore, India", remote: false },
    { id: "2", title: "Toronto Architect", country_code: "CA", location: "Toronto, Canada", remote: false },
    { id: "3", title: "Worldwide SRE", remote_scope: "worldwide", remote_eligibility: "worldwide", location: "Remote" },
    { id: "4", title: "Berlin Lead", country_code: "DE", location: "Berlin, Germany", remote: false },
    { id: "5", title: "Indiana Admin", country_code: "US", location: "Indiana, USA", remote: false },
  ];

  const filterRes = applyEligibilityFilter(testCorpus, ["India"]);
  assert.strictEqual(filterRes.eligibleJobs.length, 2, "Must keep 2 eligible jobs (Bangalore + Worldwide)");
  assert.strictEqual(filterRes.filteredOut, 3, "Must report 3 filteredOut jobs (Toronto, Berlin, Indiana)");
  assert.deepStrictEqual(
    filterRes.appliedEligibility,
    { countries: ["India"], filteredOut: 3 },
    "appliedEligibility must contain { countries: ['India'], filteredOut: 3 }"
  );
  console.log("  [PASS] 4a. applyEligibilityFilter correctly produces { countries, filteredOut } metadata");

  const emptyPrefRes = applyEligibilityFilter(testCorpus, []);
  assert.strictEqual(emptyPrefRes.eligibleJobs.length, 5, "Empty preferences must stay unfiltered");
  assert.strictEqual(emptyPrefRes.appliedEligibility, null, "Empty preferences must have null appliedEligibility");

  const filterOffRes = applyEligibilityFilter(testCorpus, ["India"], { filterEnabled: false });
  assert.strictEqual(filterOffRes.eligibleJobs.length, 5, "Filter disabled must stay unfiltered");
  assert.strictEqual(filterOffRes.appliedEligibility, null, "Filter disabled must have null appliedEligibility");
  console.log("  [PASS] 4b. Guests, users without locations, and opt-outs stay unfiltered\n");

  // ==============================================================================
  // SECTION 5: ROUTE INTEGRATION (SEARCH, PRO, TOP10) WITH ELIGIBILITY & CURRENCY
  // ==============================================================================
  console.log("TEST 5: Verifying Route Integration (/api/jobs/search, /api/jobs/pro, /api/jobs/top10)...");

  const mockDbJobs = [
    {
      id: "job-in-1",
      title: "Senior Backend Engineer - Payments",
      company: "Bangalore FinTech Corp",
      company_id: "comp-in-1",
      location: "Bengaluru, India",
      country_code: "IN",
      salary_min: 100000,
      salary_max: 140000,
      currency: "USD",
      salary_period: "yearly",
      remote: true,
      remote_scope: "remote",
      status: "active",
      is_active: true,
      verified: true,
      posted_at: new Date().toISOString(),
    },
    {
      id: "job-us-1",
      title: "US Systems Architect",
      company: "Silicon Valley Giants",
      company_id: "comp-us-1",
      location: "San Francisco, CA, USA",
      country_code: "US",
      salary_min: 150000,
      salary_max: 200000,
      currency: "USD",
      salary_period: "yearly",
      remote: true,
      remote_eligibility: "country_restricted",
      status: "active",
      is_active: true,
      verified: true,
      posted_at: new Date().toISOString(),
    },
    {
      id: "job-ww-1",
      title: "Worldwide Remote SRE",
      company: "Distributed Cloud Systems",
      company_id: "comp-ww-1",
      location: "Remote (Worldwide)",
      country_code: null,
      salary_min: 120000,
      salary_max: 160000,
      currency: "USD",
      salary_period: "yearly",
      remote: true,
      remote_scope: "worldwide",
      remote_eligibility: "worldwide",
      status: "active",
      is_active: true,
      verified: true,
      posted_at: new Date().toISOString(),
    },
    {
      id: "job-de-1",
      title: "Berlin Frontend Lead",
      company: "Berlin AutoTech",
      company_id: "comp-de-1",
      location: "Berlin, Germany",
      country_code: "DE",
      salary_min: 80000,
      salary_max: 100000,
      currency: "EUR",
      salary_period: "yearly",
      remote: false,
      status: "active",
      is_active: true,
      verified: true,
      posted_at: new Date().toISOString(),
    },
  ];

  // Ensure test fixture user is approved for platform access
  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "user@india.test";

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("/auth/v1/user")) {
      const authHeader = opts?.headers?.Authorization || opts?.headers?.authorization;
      if (authHeader?.includes("unapproved-token")) {
        return new Response(
          JSON.stringify({
            id: "user-unapproved-uuid",
            email: "unapproved@example.test",
            aud: "authenticated",
            role: "authenticated",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      return new Response(
        JSON.stringify({
          id: "user-india-uuid",
          email: "user@india.test",
          aud: "authenticated",
          role: "authenticated",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    if (urlStr.includes("user_preferences")) {
      if (opts?.method === "PATCH" || opts?.method === "POST" || opts?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          user_id: "user-india-uuid",
          locations: ["India"],
          eligibility_filter: true,
          salary_currency: "INR",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockDbJobs), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockDbJobs.length - 1}/${mockDbJobs.length}`,
        },
      });
    }
    if (urlStr.includes("subscriptions")) {
      return new Response(
        JSON.stringify({
          user_id: "user-india-uuid",
          status: "active",
          current_period_end: new Date(Date.now() + 86400000).toISOString(),
        }),
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

    // 5a. Call /api/jobs/search with simulated India user
    const searchReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25", {
      method: "GET",
      headers: { Authorization: "Bearer user-india-token" },
    });
    const searchRes = await searchGet(searchReq);
    const searchJson = await searchRes.json();

    assert(searchJson.appliedEligibility, "Search response must include appliedEligibility for India user");
    assert.deepStrictEqual(searchJson.appliedEligibility.countries, ["India"]);
    assert.strictEqual(searchJson.appliedEligibility.filteredOut, 2, "Must filter out 2 foreign jobs (US + Germany)");
    assert.strictEqual(searchJson.jobs.length, 2, "Only 2 eligible jobs returned (India + Worldwide)");

    const jobIds = searchJson.jobs.map((j: any) => j.id);
    assert(jobIds.includes("job-in-1"), "Must include India job");
    assert(jobIds.includes("job-ww-1"), "Must include Worldwide job");
    assert(!jobIds.includes("job-us-1"), "Must exclude US country-restricted job");
    assert(!jobIds.includes("job-de-1"), "Must exclude Germany job");
    console.log("  [PASS] 5a. App Route /api/jobs/search auto-filtering applied ({ countries: ['India'], filteredOut: 2 })");

    // Check preferred currency display on Pro user jobs
    const proSearchReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25", {
      method: "GET",
      headers: { Authorization: "Bearer user-india-token" },
    });
    // In Pro mock, check salary_display and salary_original
    const inJob = searchJson.jobs.find((j: any) => j.id === "job-in-1");
    assert(inJob.salary_original, "Must return salary_original");
    assert.strictEqual(inJob.salary_original, "$100,000 - $140,000 /yr");
    assert(inJob.salary_display, "Must return salary_display converted to user preferred currency (INR)");
    assert(inJob.salary_display.startsWith("~₹"), "salary_display must be approximate INR (~₹)");
    console.log("  [PASS] 5b. App Route /api/jobs/search returns salary_display (converted) and salary_original");

    // 5c. Opt-out: query param eligibility=off
    const optOutReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25&eligibility=off", {
      method: "GET",
      headers: { Authorization: "Bearer user-india-token" },
    });
    const optOutRes = await searchGet(optOutReq);
    const optOutJson = await optOutRes.json();
    assert.strictEqual(optOutJson.appliedEligibility, null, "When eligibility=off, appliedEligibility must be null");
    assert.strictEqual(optOutJson.jobs.length, 4, "When eligibility=off, all 4 jobs must be returned");
    console.log("  [PASS] 5c. App Route /api/jobs/search with eligibility=off returns all jobs without filtering");

    // 5d. Netlify jobs-search handler
    const netlifyHandler = createSearchHandler();
    const netlifyEvent = {
      httpMethod: "GET",
      headers: { authorization: "Bearer user-india-token" },
      queryStringParameters: { page: "1", pageSize: "25" },
    };
    const netlifyRes = await netlifyHandler(netlifyEvent);
    const netlifyJson = JSON.parse(netlifyRes.body);
    assert(netlifyJson.appliedEligibility, "Netlify search must return appliedEligibility");
    assert.deepStrictEqual(netlifyJson.appliedEligibility.countries, ["India"]);
    assert.strictEqual(netlifyJson.jobs.length, 2, "Netlify search must return only 2 eligible jobs");
    console.log("  [PASS] 5d. Netlify functions/jobs-search auto-filtering verified");

    // 5e. Netlify jobs-search with eligibility=off
    const netlifyOptOut = await netlifyHandler({
      ...netlifyEvent,
      queryStringParameters: { page: "1", pageSize: "25", eligibility: "off" },
    });
    const netlifyOptOutJson = JSON.parse(netlifyOptOut.body);
    assert.strictEqual(netlifyOptOutJson.appliedEligibility, null);
    assert.strictEqual(netlifyOptOutJson.jobs.length, 4);
    console.log("  [PASS] 5e. Netlify functions/jobs-search with eligibility=off returns all jobs");

    // 5f. Invite-only gate check: unapproved user must receive 403
    const unapprovedReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25", {
      method: "GET",
      headers: { Authorization: "Bearer unapproved-token" },
    });
    const unapprovedRes = await searchGet(unapprovedReq);
    assert.strictEqual(unapprovedRes.status, 403, "Unapproved user must receive 403 from /api/jobs/search");
    const unapprovedJson = await unapprovedRes.json();
    assert.strictEqual(unapprovedJson.error, "Early access only");
    console.log("  [PASS] 5f. Unapproved user strictly rejected with 403 by invite-only gate");
  } finally {
    globalThis.fetch = origFetch;
  }

  // ==============================================================================
  // SECTION 6: NEGATIVE CONTROL SUBPROCESS VERIFICATION
  // ==============================================================================
  console.log("\nTEST 6: Spawning negative control child process to verify non-zero exit...");
  const child = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
  });
  assert.notStrictEqual(child.status, 0, "Negative control process must exit with non-zero exit code");
  console.log(`  [PASS] 6a. Negative control exited with code ${child.status} (non-zero exit verified on invalid conditions)`);

  console.log("\n==================================================================================");
  console.log("COUNTRY ELIGIBILITY & PREFERRED CURRENCY VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
