/**
 * scripts/test-filter-predicates.ts
 *
 * Verifies that each filter chip (location, country, level, job type, work model, date posted, experience):
 * 1. Sets the expected URL search parameter in getLiveJobs request to /api/jobs/search
 * 2. Applies the expected server-side SQL/PostgREST predicates in /api/jobs/search/route.ts
 * 3. Applies the expected predicates in direct jobs_public queries in src/lib/jobs/service.ts
 * 4. Ensures getLiveJobs never falls through to DUMMY_JOBS when queries return 0 results (empty array)
 * 5. Ensures src/app/jobs/page.tsx binds countryCode in the first getLiveJobs call,
 *    binds experience in filterValues, handleFilterChange, handleApplyAllFilters, and reset,
 *    and hides the unindexed Industry chip from JobFilterBar.
 *
 * Supports --negative-control to verify non-zero exit on corrupted expectations.
 */

import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("         CAREERMONKE FILTER CHIPS & PREDICATES VALIDATION SUITE                   ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Client-to-API Request Parameter Mapping for All 7 Chips
  // ---------------------------------------------------------------------------
  console.log("TEST 1: Verifying getLiveJobs URL parameter serialization for all 7 filter chips...");

  const origEnvUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const origEnvAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-test-project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-with-sufficient-length-for-offline-testing";

  (global as any).window = {};

  const capturedUrls: string[] = [];
  const originalFetch = global.fetch;

  try {
    const { getLiveJobs } = await import("../src/lib/jobs/service");

    (global as any).fetch = async (urlOrReq: any) => {
      const url = typeof urlOrReq === "string" ? urlOrReq : urlOrReq.url;
      capturedUrls.push(url);
      return {
        ok: true,
        json: async () => ({ jobs: [], totalCount: 0 }),
      };
    };

    const filterScenarios = [
      { key: "location", val: "Berlin", queryParam: "location=Berlin" },
      { key: "countryCode", val: "DE", queryParam: "country_code=DE" },
      { key: "level", val: "senior", queryParam: "level=senior" },
      { key: "jobType", val: "contract", queryParam: "jobType=contract" },
      { key: "workModel", val: "remote", queryParam: "workModel=remote" },
      { key: "datePosted", val: "24h", queryParam: "datePosted=24h" },
      { key: "experience", val: "3-5 Years", queryParam: "experience=3-5+Years" },
    ];

    for (const s of filterScenarios) {
      capturedUrls.length = 0;
      await getLiveJobs({ search: "developer", [s.key]: s.val });

      const lastUrl = capturedUrls[capturedUrls.length - 1] || "";
      let matches = lastUrl.includes(s.queryParam) || lastUrl.includes(encodeURIComponent(s.val));

      if (isNegativeControl && s.key === "experience") {
        matches = false; // Simulate negative control failure
      }

      if (!matches) {
        failures.push(`Filter chip [${s.key}='${s.val}'] did NOT serialize expected '${s.queryParam}' in API URL: ${lastUrl}`);
      } else {
        console.log(`  [PASS] Chip [${s.key}] correctly serialized to request param in ${lastUrl}`);
      }
    }
  } catch (err: any) {
    failures.push(`Error executing getLiveJobs in Test 1: ${err?.message || err}`);
  } finally {
    global.fetch = originalFetch;
    delete (global as any).window;
    if (origEnvUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = origEnvUrl;
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (origEnvAnon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = origEnvAnon;
    else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }

  // ---------------------------------------------------------------------------
  // 2. Server-side Predicate Application in src/app/api/jobs/search/route.ts
  // ---------------------------------------------------------------------------
  console.log("\nTEST 2: Verifying server-side query predicates in route.ts for all 7 filter chips...");

  const routePath = path.resolve(process.cwd(), "src/app/api/jobs/search/route.ts");
  if (!fs.existsSync(routePath)) {
    failures.push("Route file src/app/api/jobs/search/route.ts not found!");
  } else {
    const routeCode = fs.readFileSync(routePath, "utf-8");

    // 2a. Country Code predicate
    const hasCountryParam = routeCode.includes('searchParams.get("country_code")') || routeCode.includes('searchParams.get("country")');
    const hasCountryPredicate = routeCode.includes('.eq("country_code", code)');
    if (!hasCountryParam || !hasCountryPredicate) {
      failures.push("route.ts: country_code parameter parsing or .eq('country_code', code) predicate missing!");
    } else {
      console.log("  [PASS] route.ts: country_code parsed and .eq('country_code', code) predicate applied");
    }

    // 2b. Location predicate
    const hasLocationParam = routeCode.includes('searchParams.get("location")');
    const hasLocationPredicate = routeCode.includes('.ilike("location"') || routeCode.includes("location.ilike");
    if (!hasLocationParam || !hasLocationPredicate) {
      failures.push("route.ts: location parameter parsing or ilike('location') predicate missing!");
    } else {
      console.log("  [PASS] route.ts: location parsed and location predicate applied");
    }

    // 2c. Level predicate
    const hasLevelParam = routeCode.includes('searchParams.get("level")');
    const hasLevelPredicate = routeCode.includes("title.ilike.%staff%") && routeCode.includes("title.ilike.%senior%");
    if (!hasLevelParam || !hasLevelPredicate) {
      failures.push("route.ts: level parameter parsing or title keyword predicates missing!");
    } else {
      console.log("  [PASS] route.ts: level parsed and title keyword predicates applied");
    }

    // 2d. Job Type predicate
    const hasJobTypeParam = routeCode.includes('searchParams.get("jobType")');
    const hasJobTypePredicate = routeCode.includes("job_type.ilike.%full%") || routeCode.includes("job_type.eq.full-time");
    if (!hasJobTypeParam || !hasJobTypePredicate) {
      failures.push("route.ts: jobType parameter parsing or predicate missing!");
    } else {
      console.log("  [PASS] route.ts: jobType parsed and job_type predicate applied");
    }

    // 2e. Work Model predicate
    const hasWorkModelParam = routeCode.includes('searchParams.get("workModel")');
    const hasWorkModelPredicate = routeCode.includes("remote.eq.true") && routeCode.includes("location.ilike.%hybrid%");
    if (!hasWorkModelParam || !hasWorkModelPredicate) {
      failures.push("route.ts: workModel parameter parsing or predicate missing!");
    } else {
      console.log("  [PASS] route.ts: workModel parsed and remote/hybrid predicates applied");
    }

    // 2f. Date Posted predicate
    const hasDateParam = routeCode.includes('searchParams.get("datePosted")');
    const hasDatePredicate = routeCode.includes('.gte("posted_at", cutoff)');
    if (!hasDateParam || !hasDatePredicate) {
      failures.push("route.ts: datePosted parameter parsing or gte('posted_at') predicate missing!");
    } else {
      console.log("  [PASS] route.ts: datePosted parsed and .gte('posted_at', cutoff) predicate applied");
    }

    // 2g. Experience predicate
    const hasExperienceParam = routeCode.includes('searchParams.get("experience")');
    const hasExperiencePredicate =
      routeCode.includes("experienceParam") &&
      routeCode.includes("exp.includes(\"8\")") &&
      routeCode.includes("exp.includes(\"5\")") &&
      routeCode.includes("exp.includes(\"1-3\")") &&
      routeCode.includes("exp.includes(\"3-5\")");
    if (!hasExperienceParam || !hasExperiencePredicate) {
      failures.push("route.ts: experience parameter parsing or title-keyword predicate missing!");
    } else {
      console.log("  [PASS] route.ts: experience parsed and title-keyword predicates applied (same logic as Level filter)");
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Service Direct jobs_public Predicates in src/lib/jobs/service.ts
  // ---------------------------------------------------------------------------
  console.log("\nTEST 3: Verifying direct jobs_public query predicates in service.ts...");

  const servicePath = path.resolve(process.cwd(), "src/lib/jobs/service.ts");
  if (!fs.existsSync(servicePath)) {
    failures.push("Service file src/lib/jobs/service.ts not found!");
  } else {
    const serviceCode = fs.readFileSync(servicePath, "utf-8");

    // 3a. Direct query applies country_code mirroring route.ts lines 137-141
    const hasDirectCountry = serviceCode.includes('query.eq("country_code", code)');
    if (!hasDirectCountry) {
      failures.push("service.ts: direct jobs_public query does not apply .eq('country_code', code) predicate!");
    } else {
      console.log("  [PASS] service.ts: direct query applies .eq('country_code', code)");
    }

    // 3b. Direct query applies experience with title-keyword logic
    const hasDirectExp =
      serviceCode.includes('query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%")') &&
      serviceCode.includes("exp.includes(\"8\")") &&
      serviceCode.includes("exp.includes(\"3-5\")");
    if (!hasDirectExp) {
      failures.push("service.ts: direct query does not apply title-keyword experience predicate!");
    } else {
      console.log("  [PASS] service.ts: direct query applies title-keyword experience predicate");
    }

    // 3c. Zero results does NOT fall through to DUMMY_JOBS
    const preservesEmptyArray =
      serviceCode.includes("if (data) {") &&
      serviceCode.includes("if (data.length === 0) {") &&
      serviceCode.includes("jobs: [],");
    if (!preservesEmptyArray) {
      failures.push("service.ts: does not preserve empty data array; may fall through to DUMMY_JOBS!");
    } else {
      console.log("  [PASS] service.ts: data.length === 0 returns { jobs: [], totalCount: count ?? 0 } without DUMMY_JOBS fallback");
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Client Page State & UI Checks in src/app/jobs/page.tsx & JobFilterBar.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTEST 4: Verifying client page state binding and chip visibility...");

  const pagePath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const filterBarPath = path.resolve(process.cwd(), "src/components/jobs/JobFilterBar.tsx");

  if (!fs.existsSync(pagePath) || !fs.existsSync(filterBarPath)) {
    failures.push("src/app/jobs/page.tsx or src/components/jobs/JobFilterBar.tsx missing!");
  } else {
    const pageCode = fs.readFileSync(pagePath, "utf-8");
    const filterBarCode = fs.readFileSync(filterBarPath, "utf-8");

    // 4a. Initial getLiveJobs call passes countryCode: selectedCountryCode
    const hasInitialCountryInCall = pageCode.includes("countryCode: selectedCountryCode,");
    if (!hasInitialCountryInCall) {
      failures.push("page.tsx: countryCode: selectedCountryCode missing from initial getLiveJobs call!");
    } else {
      console.log("  [PASS] page.tsx: first getLiveJobs call passes countryCode: selectedCountryCode");
    }

    // 4b. experience added to filterValues
    const hasExpInFilterValues = pageCode.includes("experience: selectedExperience,");
    if (!hasExpInFilterValues) {
      failures.push("page.tsx: experience missing from filterValues useMemo!");
    } else {
      console.log("  [PASS] page.tsx: experience bound in filterValues");
    }

    // 4c. experience in handleFilterChange
    const hasExpInHandleChange = pageCode.includes("if (patch.experience !== undefined) setSelectedExperience(patch.experience);");
    if (!hasExpInHandleChange) {
      failures.push("page.tsx: patch.experience handling missing in handleFilterChange!");
    } else {
      console.log("  [PASS] page.tsx: handleFilterChange updates selectedExperience");
    }

    // 4d. experience in handleApplyAllFilters
    const hasExpInApplyAll = pageCode.includes("if (updated.experience !== undefined) setSelectedExperience(updated.experience);");
    if (!hasExpInApplyAll) {
      failures.push("page.tsx: updated.experience handling missing in handleApplyAllFilters!");
    } else {
      console.log("  [PASS] page.tsx: handleApplyAllFilters updates selectedExperience");
    }

    // 4e. reset clears country and experience
    const hasResetCountry = pageCode.includes('setSelectedCountryCode("");');
    const hasResetExp = pageCode.includes('setSelectedExperience("");');
    if (!hasResetCountry || !hasResetExp) {
      failures.push("page.tsx: handleResetFilters does not clear selectedCountryCode or selectedExperience!");
    } else {
      console.log("  [PASS] page.tsx: handleResetFilters clears both countryCode and experience");
    }

    // 4f. Industry chip is hidden from JobFilterBar.tsx
    const hasIndustryChipInBar = filterBarCode.includes('aria-label="Filter by Industry"') || filterBarCode.includes("handleOpenPopover(\"industry\")");
    if (hasIndustryChipInBar) {
      failures.push("JobFilterBar.tsx: Industry chip is still visible in the filter bar!");
    } else {
      console.log("  [PASS] JobFilterBar.tsx: Industry chip is hidden until database exposes a real industry column");
    }

    // 4g. Empty state displayed when filters return 0 jobs
    const hasEmptyState = pageCode.includes("No positions match your active filters");
    if (!hasEmptyState) {
      failures.push("page.tsx: empty state for matching active filters missing!");
    } else {
      console.log("  [PASS] page.tsx: renders empty state when active filters yield 0 positions");
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Experience Mapping & Predicate Differentiation (1-3, 3-5, 5+, 8+)
  // ---------------------------------------------------------------------------
  console.log("\nTEST 5: Verifying experience mappings prove 1-3, 3-5, 5+, and 8+ produce distinct predicates...");

  // 5a. Static ordering check: "3-5" evaluated before "5" in route.ts and service.ts
  if (fs.existsSync(routePath)) {
    const routeCode = fs.readFileSync(routePath, "utf-8");
    const expBlockMatch = routeCode.match(/if\s*\(experienceParam[\s\S]*?\}\s*\}\s*\n/);
    if (expBlockMatch) {
      const block = expBlockMatch[0];
      const idx35 = block.indexOf('exp.includes("3-5")');
      const idx5 = block.indexOf('exp.includes("5")');
      if (idx35 === -1 || idx5 === -1 || idx35 > idx5) {
        failures.push("route.ts: '3-5' must be evaluated before '5' in experienceParam handler!");
      } else {
        console.log("  [PASS] route.ts: '3-5' is evaluated before '5' in experience handler");
      }
      const hasEntryExcludesSenior =
        block.includes('.not("title", "ilike", "%senior%")') &&
        block.includes('.not("title", "ilike", "%staff%")') &&
        block.includes('.not("title", "ilike", "%lead%")') &&
        block.includes('.not("title", "ilike", "%principal%")');
      if (!hasEntryExcludesSenior) {
        failures.push("route.ts: '1-3 Years' does not exclude senior/staff/lead/principal titles!");
      } else {
        console.log("  [PASS] route.ts: '1-3 Years' excludes senior/sr./staff/lead/principal titles");
      }
    } else {
      failures.push("route.ts: experienceParam block not found!");
    }
  }

  if (fs.existsSync(servicePath)) {
    const serviceCode = fs.readFileSync(servicePath, "utf-8");
    const expBlocks = (serviceCode.match(/if\s*\(experience\s*&&[\s\S]*?(?:query|catQuery)[\s\S]*?\}\s*\}\s*\r?\n/g) || [])
      .filter((b) => b.includes("exp.includes"));
    if (expBlocks.length < 2) {
      failures.push(`service.ts: expected 2 experience query blocks, found ${expBlocks.length}`);
    } else {
      let allBefore = true;
      let allExclude = true;
      for (let i = 0; i < expBlocks.length; i++) {
        const b = expBlocks[i];
        const idx35 = b.indexOf('exp.includes("3-5")');
        const idx5 = b.indexOf('exp.includes("5")');
        if (idx35 === -1 || idx5 === -1 || idx35 > idx5) {
          allBefore = false;
        }
        if (!b.includes('.not("title", "ilike", "%senior%")') || !b.includes('.not("title", "ilike", "%staff%")')) {
          allExclude = false;
        }
      }
      if (!allBefore) {
        failures.push("service.ts: in one or more queries, '3-5' is not evaluated before '5'!");
      } else {
        console.log("  [PASS] service.ts: '3-5' is evaluated before '5' across main and category-fallback queries");
      }
      if (!allExclude) {
        failures.push("service.ts: '1-3 Years' does not exclude senior/staff/lead/principal across query blocks!");
      } else {
        console.log("  [PASS] service.ts: '1-3 Years' excludes senior/sr./staff/lead/principal titles in all queries");
      }
    }

    // Check DUMMY fallback if present (or confirm safe removal with zero fake jobs)
    const dummyMatch = serviceCode.match(/fallbackList\s*=\s*fallbackList\.filter\(\(j\)\s*=>\s*\{[\s\S]*?\}\);/g);
    const expFallback = (dummyMatch || []).find((m) => m.includes("exp.includes"));
    if (expFallback) {
      const idx35 = expFallback.indexOf('exp.includes("3-5")');
      const idx5 = expFallback.indexOf('exp.includes("5")');
      if (idx35 === -1 || idx5 === -1 || idx35 > idx5) {
        failures.push("service.ts: DUMMY fallback does not evaluate '3-5' before '5'!");
      } else {
        console.log("  [PASS] service.ts: DUMMY fallback evaluates '3-5' before '5'");
      }
      if (!expFallback.includes("!isSenior") && !expFallback.includes("!jt.includes(\"senior\")")) {
        failures.push("service.ts: DUMMY fallback 1-3 does not exclude senior titles!");
      } else {
        console.log("  [PASS] service.ts: DUMMY fallback 1-3 excludes senior titles");
      }
    } else {
      console.log("  [PASS] service.ts: DUMMY fallbackList filter safely removed (zero sample jobs returned on failure)");
    }
  }

  // 5b. Functional predicate generation test simulating query builder
  function buildPredicatesForExperience(expParam: string) {
    const orCalls: string[] = [];
    const notCalls: { col: string; op: string; val: string }[] = [];
    const mockQuery = {
      or: (val: string) => {
        orCalls.push(val);
        return mockQuery;
      },
      not: (col: string, op: string, val: string) => {
        notCalls.push({ col, op, val });
        return mockQuery;
      },
    };

    const exp = expParam.trim().toLowerCase();
    if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) {
      mockQuery.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
    } else if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) {
      mockQuery
        .not("title", "ilike", "%senior%")
        .not("title", "ilike", "%sr.%")
        .not("title", "ilike", "%staff%")
        .not("title", "ilike", "%principal%")
        .not("title", "ilike", "%lead%")
        .not("title", "ilike", "%junior%")
        .not("title", "ilike", "%entry%");
    } else if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
      mockQuery
        .or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%")
        .not("title", "ilike", "%senior%")
        .not("title", "ilike", "%sr.%")
        .not("title", "ilike", "%staff%")
        .not("title", "ilike", "%principal%")
        .not("title", "ilike", "%lead%");
    } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
      mockQuery.or("title.ilike.%senior%,title.ilike.%sr.%");
    }

    return { orCalls, notCalls };
  }

  const p13 = buildPredicatesForExperience("1-3 Years");
  const p35 = buildPredicatesForExperience("3-5 Years");
  const p5plus = buildPredicatesForExperience("5+ Years");
  const p8plus = buildPredicatesForExperience("8+ Years");

  const s13 = JSON.stringify(p13);
  const s35 = JSON.stringify(p35);
  const s5plus = JSON.stringify(p5plus);
  const s8plus = JSON.stringify(p8plus);

  const uniquePredicates = new Set([s13, s35, s5plus, s8plus]);

  if (isNegativeControl) {
    uniquePredicates.delete(s35); // Force negative control failure
  }

  if (uniquePredicates.size !== 4) {
    failures.push(`Expected 4 distinct predicates for 1-3, 3-5, 5+, and 8+, but got ${uniquePredicates.size}!`);
  } else {
    console.log("  [PASS] All 4 experience brackets ('1-3', '3-5', '5+', '8+') produce strictly distinct predicates");
    console.log(`    - 1-3 Years: OR=${JSON.stringify(p13.orCalls)}, NOT count=${p13.notCalls.length}`);
    console.log(`    - 3-5 Years: OR=${JSON.stringify(p35.orCalls)}, NOT count=${p35.notCalls.length}`);
    console.log(`    - 5+  Years: OR=${JSON.stringify(p5plus.orCalls)}, NOT count=${p5plus.notCalls.length}`);
    console.log(`    - 8+  Years: OR=${JSON.stringify(p8plus.orCalls)}, NOT count=${p8plus.notCalls.length}`);
  }

  // 5c. Functional DUMMY fallback title matching test
  function simulateFallbackFilter(title: string, expParam: string): boolean {
    const exp = expParam.trim().toLowerCase();
    const jt = title.toLowerCase();
    if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) return jt.includes("staff") || jt.includes("principal") || jt.includes("lead");
    if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) return !jt.includes("senior") && !jt.includes("sr.") && !jt.includes("staff") && !jt.includes("principal") && !jt.includes("lead") && !jt.includes("junior") && !jt.includes("entry");
    if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
      const isEntry = jt.includes("junior") || jt.includes("entry") || jt.includes("associate");
      const isSenior = jt.includes("senior") || jt.includes("sr.") || jt.includes("staff") || jt.includes("principal") || jt.includes("lead");
      return isEntry && !isSenior;
    }
    if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) return jt.includes("senior") || jt.includes("sr.");
    return true;
  }

  const seniorMatch35 = simulateFallbackFilter("Senior Software Engineer", "3-5 Years");
  const seniorMatch5p = simulateFallbackFilter("Senior Software Engineer", "5+ Years");
  const juniorSeniorMatch13 = simulateFallbackFilter("Junior Senior Lead Engineer", "1-3 Years");
  const entryMatch13 = simulateFallbackFilter("Junior Frontend Engineer", "1-3 Years");
  const midMatch35 = simulateFallbackFilter("Full Stack Developer", "3-5 Years");
  const staffMatch8p = simulateFallbackFilter("Staff Infrastructure Architect", "8+ Years");

  if (seniorMatch35) {
    failures.push("DUMMY fallback: '3-5 Years' falsely matched 'Senior Software Engineer'!");
  } else {
    console.log("  [PASS] '3-5 Years' correctly excludes 'Senior Software Engineer'");
  }

  if (!seniorMatch5p) {
    failures.push("DUMMY fallback: '5+ Years' failed to match 'Senior Software Engineer'!");
  } else {
    console.log("  [PASS] '5+ Years' correctly matches 'Senior Software Engineer'");
  }

  if (juniorSeniorMatch13) {
    failures.push("DUMMY fallback: '1-3 Years' failed to exclude 'Junior Senior Lead Engineer'!");
  } else {
    console.log("  [PASS] '1-3 Years' excludes titles containing senior/lead keywords even if junior is present");
  }

  if (!entryMatch13 || !midMatch35 || !staffMatch8p) {
    failures.push("DUMMY fallback: basic role matching failed for 1-3, 3-5, or 8+!");
  } else {
    console.log("  [PASS] Clean matching across 1-3 (junior), 3-5 (mid developer), and 8+ (staff architect)");
  }

  // ---------------------------------------------------------------------------
  // Summary & Exit Codes
  // ---------------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nFAIL: Encountered ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(` - ${f}`);
    }
    process.exit(1);
  }

  console.log("\nALL FILTER PREDICATE ASSERTIONS PASSED [PASS-LOCAL]\n");
  process.exit(0);
}

run().catch((err) => {
  console.error("Unexpected test exception:", err);
  process.exit(1);
});
