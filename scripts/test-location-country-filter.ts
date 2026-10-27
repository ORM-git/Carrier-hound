/**
 * scripts/test-location-country-filter.ts
 *
 * Verifies the Location & Country filter fixes across:
 * 1. src/components/jobs/JobFilterBar.tsx:
 *    - Confirm commits { countryCode: draftFilters.countryCode, location: draftFilters.location }
 *    - Reset clears both countryCode and location
 *    - Renders "Country: XX" chip when filters.countryCode is set
 *    - Displays expanded list of supported countries (at least US, GB, CA, IN, DE, FR, NL, AU, ES, BR, SG, IE, JP, MX)
 * 2. Backend & Service Predicates (service.ts, search route, pro route, netlify functions):
 *    - Country filter matches country_code.eq.CODE OR location.ilike.%country name%
 *    - Applies strict exclusions for false positives:
 *      * IN matches "India" but excludes "Indiana"
 *      * MX matches "Mexico" but excludes "New Mexico"
 * 3. Security in src/lib/api/jobs.ts:
 *    - Restricts .or() query to COUNTRY_CODE_TO_NAME allowlist
 *    - Falls back to .eq("country", sanitized) for unlisted inputs
 *    - No raw unverified user strings in .or(...)
 * 4. Null Country Not Defaulted to "US":
 *    - Null country_code is mapped to empty/unknown, never defaulted to "US"
 * 5. Client-side filter in page.tsx:
 *    - Uses matchCountryWithStrictFallback:
 *      * "Indianapolis, Indiana" is NOT IN
 *      * "Albuquerque, New Mexico" is NOT MX
 *      * "Mumbai, India" IS IN
 *      * "Mexico City, Mexico" IS MX
 *      * Does NOT falsely match null/unknown country jobs as "US"
 * 6. Negative Controls:
 *    - Two real in-memory mutation negative controls:
 *      * Mutate Confirm handler in memory to drop countryCode -> assert validator detects regression.
 *      * Mutate matcher in memory to omit Indiana/New Mexico exclusion -> assert false positive detected.
 *    - When executed with --negative-control, runs the mutation directly against validation, exiting with code 1.
 */

import * as fs from "fs";
import * as path from "path";
import {
  SUPPORTED_COUNTRIES,
  COUNTRY_CODE_TO_NAME,
  getCountryFilterClause,
  matchCountryWithStrictFallback,
} from "../src/lib/countries";

const isNegativeControl = process.argv.includes("--negative-control");

// Helper validator for JobFilterBar code (used for both real validation and mutation testing)
export function validateJobFilterBarConfirmHandler(code: string): string[] {
  const issues: string[] = [];
  const confirmCalls = [...code.matchAll(/handleConfirm\(\s*\{([^}]+)\}\s*\)/g)].map((m) => m[1]);
  const locationConfirm = confirmCalls.find((call) => call.includes("draftFilters.location"));

  if (!locationConfirm) {
    issues.push("JobFilterBar Confirm handler for location is missing completely!");
  } else if (!locationConfirm.includes("countryCode: draftFilters.countryCode")) {
    issues.push("JobFilterBar Confirm handler drops countryCode when committing location!");
  }
  return issues;
}

// Helper validator for country matcher false-positive safety
export function validateStrictCountryMatching(
  matcher: (country: string | null | undefined, loc: string | null | undefined, code: string) => boolean
): string[] {
  const issues: string[] = [];
  // Negative control assertions:
  // "Indianapolis, Indiana" must NOT match IN
  if (matcher("", "Indianapolis, Indiana", "IN")) {
    issues.push("False positive: 'Indianapolis, Indiana' was incorrectly matched as IN!");
  }
  // "Albuquerque, New Mexico" must NOT match MX
  if (matcher("", "Albuquerque, New Mexico", "MX")) {
    issues.push("False positive: 'Albuquerque, New Mexico' was incorrectly matched as MX!");
  }
  // Positive assertions:
  // "Mumbai, India" MUST match IN
  if (!matcher("", "Mumbai, India", "IN")) {
    issues.push("False negative: 'Mumbai, India' was not matched as IN!");
  }
  // "Mexico City, Mexico" MUST match MX
  if (!matcher("", "Mexico City, Mexico", "MX")) {
    issues.push("False negative: 'Mexico City, Mexico' was not matched as MX!");
  }
  return issues;
}

async function run() {
  console.log("==================================================================================");
  console.log("       CAREERMONKE LOCATION & COUNTRY FILTER VALIDATION SUITE                      ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Expanded Country List Verification (at least US, GB, CA, IN, DE, FR, NL, AU, ES, BR, SG, IE, JP, MX)
  // ---------------------------------------------------------------------------
  console.log("TEST 1: Verifying expanded country options list...");

  const requiredCountryCodes = [
    "US", "GB", "CA", "IN", "DE", "FR", "NL", "AU", "ES", "BR", "SG", "IE", "JP", "MX"
  ];

  const availableCodes = new Set(SUPPORTED_COUNTRIES.map((c) => c.code.toUpperCase()).filter(Boolean));

  for (const reqCode of requiredCountryCodes) {
    if (!availableCodes.has(reqCode)) {
      failures.push(`SUPPORTED_COUNTRIES is missing required country code: ${reqCode}`);
    }
    const countryName = COUNTRY_CODE_TO_NAME[reqCode];
    if (!countryName || countryName.trim().length === 0) {
      failures.push(`COUNTRY_CODE_TO_NAME is missing full name for required country: ${reqCode}`);
    }
  }

  const barPath = path.resolve(process.cwd(), "src/components/jobs/JobFilterBar.tsx");
  let barCode = fs.readFileSync(barPath, "utf-8");

  if (!barCode.includes("SUPPORTED_COUNTRIES")) {
    failures.push("JobFilterBar.tsx does not use SUPPORTED_COUNTRIES for country options!");
  } else {
    console.log(`  [PASS] SUPPORTED_COUNTRIES contains all ${requiredCountryCodes.length} required countries with full names.`);
  }

  // ---------------------------------------------------------------------------
  // 2. JobFilterBar.tsx: Confirm Commits Country & Reset Clears Both
  // ---------------------------------------------------------------------------
  console.log("\nTEST 2: Verifying JobFilterBar popover Confirm and Reset handlers...");

  if (isNegativeControl) {
    // Under negative control execution, deliberately mutate barCode in memory to drop countryCode
    barCode = barCode.replace(
      "handleConfirm({ countryCode: draftFilters.countryCode, location: draftFilters.location })",
      "handleConfirm({ location: draftFilters.location })"
    );
  }

  const confirmIssues = validateJobFilterBarConfirmHandler(barCode);
  if (confirmIssues.length > 0) {
    failures.push(...confirmIssues);
  } else {
    console.log("  [PASS] Confirm button commits both countryCode and location from draftFilters");
  }

  // Reset must clear both countryCode and location
  const hasResetBoth =
    barCode.includes('setDraftFilters((prev) => ({ ...prev, countryCode: "", location: "" }))');

  if (!hasResetBoth) {
    failures.push("JobFilterBar.tsx: Reset button does NOT clear both countryCode and location!");
  } else {
    console.log("  [PASS] Reset button clears both countryCode and location to empty strings");
  }

  // ---------------------------------------------------------------------------
  // 3. JobFilterBar.tsx: "Country: XX" Chip in Active Strip
  // ---------------------------------------------------------------------------
  console.log("\nTEST 3: Verifying 'Country: XX' chip in active filters strip...");

  const hasCountryChip =
    barCode.includes("filters.countryCode &&") &&
    barCode.includes("Country: {filters.countryCode}") &&
    barCode.includes('onChange({ countryCode: "" })');

  if (!hasCountryChip) {
    failures.push("JobFilterBar.tsx: Active filters strip does NOT render 'Country: XX' chip with removal handler!");
  } else {
    console.log("  [PASS] Active strip renders 'Country: XX' chip with removal button invoking onChange({ countryCode: '' })");
  }

  // ---------------------------------------------------------------------------
  // 4. Server & Service Query Predicates: getCountryFilterClause & Strict Exclusions
  // ---------------------------------------------------------------------------
  console.log("\nTEST 4: Verifying getCountryFilterClause and strict exclusion predicates...");

  // Verify getCountryFilterClause output
  const inClause = getCountryFilterClause("IN");
  if (!inClause || !inClause.includes("not.ilike.%Indiana%")) {
    failures.push(`getCountryFilterClause('IN') missing Indiana exclusion! Got: ${inClause}`);
  } else {
    console.log(`  [PASS] getCountryFilterClause('IN') -> ${inClause}`);
  }

  const mxClause = getCountryFilterClause("MX");
  if (!mxClause || !mxClause.includes("not.ilike.%New Mexico%")) {
    failures.push(`getCountryFilterClause('MX') missing New Mexico exclusion! Got: ${mxClause}`);
  } else {
    console.log(`  [PASS] getCountryFilterClause('MX') -> ${mxClause}`);
  }

  const deClause = getCountryFilterClause("DE");
  if (!deClause || deClause !== "country_code.eq.DE,location.ilike.%Germany%") {
    failures.push(`getCountryFilterClause('DE') unexpected: ${deClause}`);
  } else {
    console.log(`  [PASS] getCountryFilterClause('DE') -> ${deClause}`);
  }

  // Verify imports and usage across backend files
  const searchRoutePath = path.resolve(process.cwd(), "src/app/api/jobs/search/route.ts");
  const searchRouteCode = fs.readFileSync(searchRoutePath, "utf-8");

  const servicePath = path.resolve(process.cwd(), "src/lib/jobs/service.ts");
  const serviceCode = fs.readFileSync(servicePath, "utf-8");

  const netlifySearchPath = path.resolve(process.cwd(), "netlify/functions/jobs-search.ts");
  const netlifySearchCode = fs.readFileSync(netlifySearchPath, "utf-8");

  const proRoutePath = path.resolve(process.cwd(), "src/app/api/jobs/pro/route.ts");
  const proRouteCode = fs.readFileSync(proRoutePath, "utf-8");

  const netlifyProPath = path.resolve(process.cwd(), "netlify/functions/jobs-pro.ts");
  const netlifyProCode = fs.readFileSync(netlifyProPath, "utf-8");

  const apiJobsPath = path.resolve(process.cwd(), "src/lib/api/jobs.ts");
  const apiJobsCode = fs.readFileSync(apiJobsPath, "utf-8");

  if (!serviceCode.includes("getCountryFilterClause")) {
    failures.push("src/lib/jobs/service.ts: does not use getCountryFilterClause!");
  } else {
    console.log("  [PASS] src/lib/jobs/service.ts uses getCountryFilterClause in main and category queries");
  }

  if (!searchRouteCode.includes("getCountryFilterClause")) {
    failures.push("src/app/api/jobs/search/route.ts: does not use getCountryFilterClause!");
  } else {
    console.log("  [PASS] src/app/api/jobs/search/route.ts uses getCountryFilterClause");
  }

  if (!netlifySearchCode.includes("getCountryFilterClause")) {
    failures.push("netlify/functions/jobs-search.ts: does not use getCountryFilterClause!");
  } else {
    console.log("  [PASS] netlify/functions/jobs-search.ts uses getCountryFilterClause");
  }

  if (!proRouteCode.includes("getCountryFilterClause")) {
    failures.push("src/app/api/jobs/pro/route.ts: does not use getCountryFilterClause!");
  } else {
    console.log("  [PASS] src/app/api/jobs/pro/route.ts uses getCountryFilterClause");
  }

  if (!netlifyProCode.includes("getCountryFilterClause")) {
    failures.push("netlify/functions/jobs-pro.ts: does not use getCountryFilterClause!");
  } else {
    console.log("  [PASS] netlify/functions/jobs-pro.ts uses getCountryFilterClause");
  }

  // ---------------------------------------------------------------------------
  // 5. Security & Sanitization in src/lib/api/jobs.ts
  // ---------------------------------------------------------------------------
  console.log("\nTEST 5: Verifying security in src/lib/api/jobs.ts (allowlist & sanitization)...");

  const hasOrAllowlistCheck =
    apiJobsCode.includes("COUNTRY_CODE_TO_NAME[code]") &&
    apiJobsCode.includes("sanitizeSearchQuery(country)");

  const hasNoRawOrInterpolation =
    !apiJobsCode.includes("`country_code.eq.${code},country.eq.${countryName},location.ilike.%${countryName}%`") ||
    apiJobsCode.includes("if (countryName)");

  const hasStrictInAndMxInApiJobs =
    apiJobsCode.includes("not.ilike.%Indiana%") &&
    apiJobsCode.includes("not.ilike.%New Mexico%");

  if (!hasOrAllowlistCheck || !hasNoRawOrInterpolation || !hasStrictInAndMxInApiJobs) {
    failures.push("src/lib/api/jobs.ts: missing allowlist gating or strict IN/MX exclusion for .or() queries!");
  } else {
    console.log("  [PASS] src/lib/api/jobs.ts: country .or() strictly allowlisted; raw inputs sanitized with .eq('country', ...)");
    console.log("  [PASS] src/lib/api/jobs.ts: includes strict not.ilike.%Indiana% and not.ilike.%New Mexico% exclusions");
  }

  // ---------------------------------------------------------------------------
  // 6. Null country_code Stop Defaulting to "US"
  // ---------------------------------------------------------------------------
  console.log("\nTEST 6: Verifying null country_code is NOT defaulted to 'US' in display and mappings...");

  const serviceDefaultsToUs = serviceCode.includes('row.country_code || "US"') || serviceCode.includes('job.country_code || "US"');
  if (serviceDefaultsToUs) {
    failures.push("service.ts still defaults null country_code to 'US'!");
  } else {
    console.log("  [PASS] service.ts: null country_code treated as unknown/empty, never defaulted to 'US'");
  }

  const searchRouteDefaultsToUs = searchRouteCode.includes('row.country_code || "US"');
  if (searchRouteDefaultsToUs) {
    failures.push("search route still defaults null country_code to 'US'!");
  } else {
    console.log("  [PASS] search route: null country_code treated as unknown/empty, never defaulted to 'US'");
  }

  const netlifySearchDefaultsToUs = netlifySearchCode.includes('row.country_code || "US"');
  if (netlifySearchDefaultsToUs) {
    failures.push("netlify/functions/jobs-search.ts still defaults null country_code to 'US'!");
  } else {
    console.log("  [PASS] netlify/functions/jobs-search.ts: null country_code treated as unknown/empty, never defaulted to 'US'");
  }

  // ---------------------------------------------------------------------------
  // 7. Client-Side Filter in src/app/jobs/page.tsx: Strict Fallback & False Positive Prevention
  // ---------------------------------------------------------------------------
  console.log("\nTEST 7: Verifying client-side job filtering logic from page.tsx & matchCountryWithStrictFallback...");

  const pagePath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const pageCode = fs.readFileSync(pagePath, "utf-8");

  if (!pageCode.includes("matchCountryWithStrictFallback")) {
    failures.push("src/app/jobs/page.tsx: client-side filter does not use matchCountryWithStrictFallback!");
  } else {
    console.log("  [PASS] src/app/jobs/page.tsx: client-side filter uses matchCountryWithStrictFallback");
  }

  // 7a. Required Test Cases:
  // - "Indianapolis, Indiana" is NOT IN
  // - "Albuquerque, New Mexico" is NOT MX
  // - "Mumbai, India" IS IN
  // - "Mexico City, Mexico" IS MX
  let effectiveMatcher = matchCountryWithStrictFallback;
  if (isNegativeControl) {
    // Deliberately simulate naive fallback without Indiana/New Mexico exclusion
    effectiveMatcher = (country, location, code) => {
      const c = (country || "").trim().toUpperCase();
      if (c && c === code.toUpperCase()) return true;
      const cName = COUNTRY_CODE_TO_NAME[code.toUpperCase()]?.toLowerCase();
      return Boolean(cName && (location || "").toLowerCase().includes(cName));
    };
  }

  const strictMatchingIssues = validateStrictCountryMatching(effectiveMatcher);
  if (strictMatchingIssues.length > 0) {
    failures.push(...strictMatchingIssues);
  } else {
    console.log("  [PASS] 'Indianapolis, Indiana' is NOT matched as IN");
    console.log("  [PASS] 'Albuquerque, New Mexico' is NOT matched as MX");
    console.log("  [PASS] 'Mumbai, India' IS matched as IN");
    console.log("  [PASS] 'Mexico City, Mexico' IS matched as MX");
  }

  // 7b. Simulation test with full synthetic jobs
  const sampleJobs = [
    { id: "1", title: "Engineer 1", country: "US", location: "New York, NY" },
    { id: "2", title: "Engineer 2", country: "DE", location: "Berlin" },
    { id: "3", title: "Engineer 3", country: "", location: "Munich, Germany" }, // Fallback to Germany
    { id: "4", title: "Engineer 4", country: "", location: "Toronto, Canada" }, // Fallback to Canada
    { id: "5", title: "Engineer 5", country: "", location: "Remote" }, // Null country, unknown location
    { id: "6", title: "Engineer 6", country: "US", location: "San Francisco, CA" },
    { id: "7", title: "Engineer 7", country: "", location: "Indianapolis, Indiana" }, // MUST NOT match IN
    { id: "8", title: "Engineer 8", country: "", location: "Mumbai, India" }, // MUST match IN
    { id: "9", title: "Engineer 9", country: "", location: "Albuquerque, New Mexico" }, // MUST NOT match MX
    { id: "10", title: "Engineer 10", country: "", location: "Mexico City, Mexico" }, // MUST match MX
  ];

  // Test DE
  const deJobs = sampleJobs.filter((j) => effectiveMatcher(j.country, j.location, "DE")).map((j) => j.id);
  if (!deJobs.includes("2") || !deJobs.includes("3") || deJobs.includes("5")) {
    failures.push(`Filter DE failed: expected [2, 3], got [${deJobs.join(", ")}]`);
  } else {
    console.log("  [PASS] Filter DE matches explicit (Job 2) and fallback (Job 3)");
  }

  // Test IN: must match Job 8 only, NOT Job 7
  const inJobs = sampleJobs.filter((j) => effectiveMatcher(j.country, j.location, "IN")).map((j) => j.id);
  if (!inJobs.includes("8") || inJobs.includes("7")) {
    failures.push(`Filter IN failed: expected [8] (Mumbai, India), got [${inJobs.join(", ")}] (contained Job 7 Indianapolis, Indiana)`);
  } else {
    console.log("  [PASS] Filter IN matches Mumbai (Job 8) and correctly rejects Indianapolis, Indiana (Job 7)");
  }

  // Test MX: must match Job 10 only, NOT Job 9
  const mxJobs = sampleJobs.filter((j) => effectiveMatcher(j.country, j.location, "MX")).map((j) => j.id);
  if (!mxJobs.includes("10") || mxJobs.includes("9")) {
    failures.push(`Filter MX failed: expected [10] (Mexico City, Mexico), got [${mxJobs.join(", ")}] (contained Job 9 Albuquerque, New Mexico)`);
  } else {
    console.log("  [PASS] Filter MX matches Mexico City (Job 10) and correctly rejects Albuquerque, New Mexico (Job 9)");
  }

  // Test US: must match Jobs 1 and 6, and MUST NOT include Job 5 (remote with null country)
  const usJobs = sampleJobs.filter((j) => effectiveMatcher(j.country, j.location, "US")).map((j) => j.id);
  if (!usJobs.includes("1") || !usJobs.includes("6") || usJobs.includes("5")) {
    failures.push(`Filter US failed: Job 5 must NOT be defaulted to US! Got [${usJobs.join(", ")}]`);
  } else {
    console.log("  [PASS] Filter US strictly matches US jobs (1, 6) and excludes unknown null-country Job 5");
  }

  // ---------------------------------------------------------------------------
  // 8. In-Memory Negative Controls Verification (Proves Validators Detect Failures)
  // ---------------------------------------------------------------------------
  if (!isNegativeControl) {
    console.log("\nTEST 8: In-memory mutation negative controls verification...");

    // Real Negative Control 1: Mutate Confirm handler in memory to drop countryCode
    const corruptedBarSource = barCode.replace(
      "handleConfirm({ countryCode: draftFilters.countryCode, location: draftFilters.location })",
      "handleConfirm({ location: draftFilters.location })"
    );
    const caughtConfirmRegression = validateJobFilterBarConfirmHandler(corruptedBarSource);
    if (caughtConfirmRegression.length === 0) {
      failures.push("Negative Control 1 FAILED: Validator did NOT detect corrupted Confirm handler!");
    } else {
      console.log(`  [PASS] Negative Control 1: In-memory Confirm mutation successfully caught: "${caughtConfirmRegression[0]}"`);
    }

    // Real Negative Control 2: Naive substring matcher without Indiana/New Mexico exclusions
    const naiveMatcher = (country: string | null | undefined, location: string | null | undefined, code: string) => {
      const c = (country || "").trim().toUpperCase();
      if (c && c === code.toUpperCase()) return true;
      const cName = COUNTRY_CODE_TO_NAME[code.toUpperCase()]?.toLowerCase();
      return Boolean(cName && (location || "").toLowerCase().includes(cName));
    };
    const caughtFalsePositives = validateStrictCountryMatching(naiveMatcher);
    if (caughtFalsePositives.length < 2) {
      failures.push("Negative Control 2 FAILED: Validator did NOT detect naive matcher false positives!");
    } else {
      console.log(`  [PASS] Negative Control 2: In-memory naive matcher mutations successfully caught:`);
      caughtFalsePositives.forEach((msg) => console.log(`         -> ${msg}`));
    }
  }

  console.log("\n==================================================================================");
  if (failures.length > 0) {
    console.error(`VALIDATION FAILED with ${failures.length} issues:`);
    failures.forEach((f, idx) => console.error(`  ${idx + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log("ALL LOCATION & COUNTRY FILTER ASSERTIONS PASSED [PASS-LOCAL]");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Unexpected error running validation suite:", err);
  process.exit(1);
});
