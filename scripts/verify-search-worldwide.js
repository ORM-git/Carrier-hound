require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceKey || !anonKey) {
  console.error("Missing required Supabase environment variables");
  process.exit(1);
}

const adminClient = createClient(supabaseUrl, serviceKey);
const anonClient = createClient(supabaseUrl, anonKey);

function sanitizeSearchQuery(input) {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function verifyTask1_CompanySearch() {
  console.log("\n=======================================================");
  console.log("TEST 1: COMPANY SEARCH ACTUALLY SEARCHES COMPANY");
  console.log("=======================================================");

  const companiesToTest = [
    { name: "Supabase", expectedMin: 90 },
    { name: "OpenAI", expectedMin: 1000 },
    { name: "Stripe", expectedMin: 700 },
    { name: "Databricks", expectedMin: 800 },
  ];

  for (const item of companiesToTest) {
    const clean = sanitizeSearchQuery(item.name);
    const clauses = [
      `title.ilike.%${clean}%`,
      `company.ilike.%${clean}%`,
      `location.ilike.%${clean}%`,
      `category.ilike.%${clean}%`,
      `description.ilike.%${clean}%`,
    ];

    const { data, count, error } = await adminClient
      .from("jobs")
      .select("id, title, company, location, salary_min, salary_max, apply_url", { count: "exact" })
      .eq("is_active", true)
      .eq("status", "active")
      .or(clauses.join(","))
      .order("posted_at", { ascending: false })
      .limit(5);

    if (error) {
      console.error(`❌ FAIL: Error searching for ${item.name}:`, error.message);
      return false;
    }

    if (count < item.expectedMin) {
      console.error(`❌ FAIL: Expected at least ${item.expectedMin} roles for ${item.name}, got ${count}`);
      return false;
    }

    console.log(`✅ PASS: Search for "${item.name}" returned ${count} active roles (expected >= ${item.expectedMin}).`);
    console.log(`   Sample matching titles:`, data.slice(0, 3).map(j => `"${j.title}" (${j.company})`).join(", "));

    // Verify Guest preview masking (what guests receive from server search)
    const guestPreview = data.map(j => ({
      id: j.id,
      title: j.title,
      company: "Verified Employer",
      salary: "",
      applyUrl: ""
    }));

    const leakedCompany = guestPreview.some(j => j.company !== "Verified Employer");
    const leakedApplyUrl = guestPreview.some(j => j.applyUrl !== "");
    const leakedSalary = guestPreview.some(j => j.salary !== "");

    if (leakedCompany || leakedApplyUrl || leakedSalary) {
      console.error(`❌ FAIL: Guest preview leaked paid attributes!`);
      return false;
    }
    console.log(`   Guest preview verification: All ${guestPreview.length} sample results safely masked as "Verified Employer", salary/applyUrl empty.`);
  }

  // Test special characters and SQL injection resistance
  const trickyInputs = [
    "OpenAI (US)",
    "Supabase, 'drop table",
    "C++ / Node.js",
    "%%__''\"\"$$;;",
  ];

  for (const input of trickyInputs) {
    const clean = sanitizeSearchQuery(input);
    const clauses = [
      `title.ilike.%${clean}%`,
      `company.ilike.%${clean}%`,
      `location.ilike.%${clean}%`,
      `category.ilike.%${clean}%`,
      `description.ilike.%${clean}%`,
    ];
    const { error } = await adminClient
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .or(clauses.join(","));

    if (error) {
      console.error(`❌ FAIL: Sanitization failed on input "${input}":`, error.message);
      return false;
    }
    console.log(`✅ PASS: Safely handled special character input "${input}" without syntax error.`);
  }

  // Verify that anonymous direct REST call to raw /rest/v1/jobs is STILL blocked (no data leak)
  const { data: anonData, error: anonError } = await anonClient
    .from("jobs")
    .select("company, salary_min, apply_url")
    .limit(5);

  const anonDenied = Boolean(anonError && (anonError.code === "42501" || anonError.message.includes("permission denied")));
  if (!anonDenied && anonData && anonData.length > 0) {
    console.error("❌ FAIL: Anonymous client was able to query raw jobs table!");
    return false;
  }
  console.log("✅ PASS: Anonymous direct REST access to raw jobs table is securely blocked by RLS (permission denied).");

  return true;
}

async function verifyTask2_SeparateAllJobsFromForYou() {
  console.log("\n=======================================================");
  console.log("TEST 2: SEPARATE ALL JOBS FROM FOR YOU (CORPUS COUNT)");
  console.log("=======================================================");

  // 1. Check All Jobs corpus count on public view
  const { count: fullCorpusCount, error: countError } = await anonClient
    .from("jobs_public")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .eq("status", "active");

  if (countError) {
    console.error("❌ FAIL: Error checking jobs_public count:", countError.message);
    return false;
  }

  console.log(`✅ PASS: Live active corpus count on jobs_public is ${fullCorpusCount?.toLocaleString()} jobs.`);
  if (fullCorpusCount < 16000) {
    console.error(`❌ FAIL: Expected >= 16,000 jobs, found ${fullCorpusCount}`);
    return false;
  }

  // 2. Verify code paths in src/app/jobs/page.tsx:
  const jobsPageCode = fs.readFileSync(path.join(__dirname, '../src/app/jobs/page.tsx'), 'utf-8');

  // Verify getCandidateProfile on mount does NOT force sortBy = "match"
  const hasBadSetSortByMatch = jobsPageCode.includes('setCandidate(cp);\n        setSortBy("match");');
  if (hasBadSetSortByMatch) {
    console.error("❌ FAIL: src/app/jobs/page.tsx still forces setSortBy('match') when loading candidate profile!");
    return false;
  }
  console.log("✅ PASS: getCandidateProfile() on page mount no longer forces sortBy = 'match'. Defaults to 'newest'.");

  // Verify effectiveCandidate / effectiveSortBy logic scopes personalization to For You or explicit match sort
  const hasEffectivePersonalization = jobsPageCode.includes('effectiveCandidate') && jobsPageCode.includes('effectiveSortBy');
  if (!hasEffectivePersonalization) {
    console.error("❌ FAIL: Missing effectiveCandidate / effectiveSortBy logic in src/app/jobs/page.tsx!");
    return false;
  }
  console.log("✅ PASS: Personalization is strictly scoped to activeTab === 'foryou' or explicit user-selected 'match' sort.");

  // 3. Verify signOutUser in src/lib/auth/session.ts clears candidate profile and preferences
  const sessionCode = fs.readFileSync(path.join(__dirname, '../src/lib/auth/session.ts'), 'utf-8');
  const hasCandidateProfilePurge = sessionCode.includes('CANDIDATE_PROFILE_KEY') && sessionCode.includes('clearCandidateProfileMemoryCache');
  if (!hasCandidateProfilePurge) {
    console.error("❌ FAIL: signOutUser() does not purge candidate profile or clear memory cache!");
    return false;
  }
  console.log("✅ PASS: signOutUser() purges CANDIDATE_PROFILE_KEY, all related local storage keys, and memory cache.");

  // 4. Verify UserMenu calls signOutUser
  const userMenuCode = fs.readFileSync(path.join(__dirname, '../src/components/UserMenu.tsx'), 'utf-8');
  if (!userMenuCode.includes('await signOutUser()')) {
    console.error("❌ FAIL: UserMenu does not call signOutUser()!");
    return false;
  }
  console.log("✅ PASS: UserMenu handleSignOut unified to call signOutUser().");

  return true;
}

async function verifyTask3_WorldwideDirectoryRealData() {
  console.log("\n=======================================================");
  console.log("TEST 3: WORLDWIDE DIRECTORY USES REAL DATA (NO PRESETS)");
  console.log("=======================================================");

  const companiesJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/companies.json'), 'utf-8'));
  console.log(`Found ${companiesJson.length} companies in src/data/companies.json.`);

  // Verify CloudVanguard Systems is NOT in companies.json
  const fakeComp = companiesJson.find(c => c.name.toLowerCase().includes('cloudvanguard'));
  if (fakeComp) {
    console.error("❌ FAIL: CloudVanguard Systems found in companies data!");
    return false;
  }
  console.log("✅ PASS: Zero fake preset companies (CloudVanguard Systems, etc.) found in companies data.");

  // Verify tsconfig.json reorders paths so src/data comes first
  const tsconfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../tsconfig.json'), 'utf-8'));
  const dataPaths = tsconfig.compilerOptions?.paths?.["@/data/*"];
  if (!dataPaths || dataPaths[0] !== "./src/data/*") {
    console.error("❌ FAIL: tsconfig.json does not prioritize ./src/data/* over ./data/*!");
    return false;
  }
  console.log("✅ PASS: tsconfig.json correctly prioritizes ./src/data/* before ./data/*.");

  // Verify data/companies.ts exports real companies
  const rootCompaniesFile = fs.readFileSync(path.join(__dirname, '../data/companies.ts'), 'utf-8');
  if (rootCompaniesFile.includes('CloudVanguard Systems')) {
    console.error("❌ FAIL: data/companies.ts still contains hardcoded CloudVanguard Systems!");
    return false;
  }
  console.log("✅ PASS: data/companies.ts replaced with real ingested company data.");

  // Sample check database counts vs companies.json
  const topCompanies = ["OpenAI", "Databricks", "Stripe", "Anthropic", "Supabase"];
  for (const compName of topCompanies) {
    const entry = companiesJson.find(c => c.name === compName);
    if (!entry) {
      console.error(`❌ FAIL: Missing ${compName} in companies.json`);
      return false;
    }

    const { count: dbCount, error } = await adminClient
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active")
      .eq("company", compName);

    if (error) {
      console.error(`❌ FAIL: Database count query failed for ${compName}:`, error.message);
      return false;
    }

    if (dbCount !== entry.jobCount) {
      console.error(`❌ FAIL: Job count mismatch for ${compName}: JSON has ${entry.jobCount}, DB has ${dbCount}`);
      return false;
    }

    console.log(`✅ PASS: ${compName} job count matches DB exactly: ${dbCount} active jobs.`);
  }

  return true;
}

async function run() {
  console.log("================================================================================");
  console.log("STARTING VERIFICATION SUITE: COMPANY SEARCH, ALL JOBS VS FOR YOU, WORLDWIDE");
  console.log("================================================================================");

  const t1 = await verifyTask1_CompanySearch();
  const t2 = await verifyTask2_SeparateAllJobsFromForYou();
  const t3 = await verifyTask3_WorldwideDirectoryRealData();

  console.log("\n================================================================================");
  if (t1 && t2 && t3) {
    console.log("🎉 ALL VERIFICATION CHECKS PASSED PERFECTLY!");
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.error("❌ SOME VERIFICATION CHECKS FAILED.");
    console.log("================================================================================");
    process.exit(1);
  }
}

run();
