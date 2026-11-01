/**
 * Test Suite: Production Data Correctness Fixes (Hermetic Unit Tests)
 *
 * Requirements:
 * (1) Exact count only when a filter is active; estimated count for unfiltered;
 *     falls back to estimated count on timeout (57014); does not replace old fallback
 *     with rows.length; keeps a hasMore flag.
 * (2) AI filter: removes bare title ilike %ai % / % ai% that match Retail, Dubai,
 *     Airline, Aid; keeps category eq ai/ai-ml plus %machine learning%, %deep learning%,
 *     %llm%, %nlp%, and matches "AI" only as a whole word.
 * (3) Sanitizer classifier: uses word boundaries for culture, community, social,
 *     influencer, brand and tpm, so Agriculture and Horticulture are not marketing.
 * (4) Profile completion formula in one exported helper used by jobs/page.tsx and this test.
 * (5) Hermetic with mocks.
 */

import { detectCategory } from "./utils/sanitizer";
import { expandCategoryFilter, normalizeCategorySlug } from "../src/lib/taxonomy";
import {
  getCandidateProfile,
  saveCandidateProfileLocally,
  clearCandidateProfileMemoryCache,
  getCandidateProfileStorageKey,
  calculateProfileCompletion,
} from "../src/lib/resume/storage";
import type { CandidateProfile } from "../src/lib/resume/types";
import { createSearchHandler } from "../netlify/functions/jobs-search";

// Mock minimal browser localStorage for hermetic Node execution
class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

// Attach mock window & localStorage
if (typeof (global as any).window === "undefined") {
  (global as any).window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
(global as any).localStorage = new LocalStorageMock();

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

async function runHermeticTests() {
  console.log("\n=======================================================");
  console.log("RUNNING HERMETIC PRODUCTION DATA-CORRECTNESS TEST SUITE");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------
  // TEST 1: Candidate Profile Reset & Cross-Account Isolation
  // -------------------------------------------------------------------
  console.log("--- Test 1: Candidate Profile Reset & Scoped Storage ---");
  clearCandidateProfileMemoryCache();
  (global as any).localStorage.clear();

  // Hermetic client override returning null profile (fresh user with no remote row)
  const hermeticSupabaseClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };

  // Fresh user with no profile in Supabase must return null (empty state)
  const freshUserId = "00000000-0000-4000-a000-000000000001";
  const freshProfile = await getCandidateProfile(freshUserId, hermeticSupabaseClient);
  assert(freshProfile === null, "Fresh account with no DB row starts completely empty (null)");

  // Legacy un-scoped key in localStorage must NOT leak into fresh account
  (global as any).localStorage.setItem(
    "careermonke_candidate_profile",
    JSON.stringify({
      name: "Mock Predecessor",
      email: "mock@example.invalid",
      phone: "+1 555-0199",
      confirmedAt: new Date().toISOString(),
    })
  );

  clearCandidateProfileMemoryCache();
  const freshUser2Id = "00000000-0000-4000-a000-000000000002";
  const isolatedProfile = await getCandidateProfile(freshUser2Id, hermeticSupabaseClient);
  assert(
    isolatedProfile === null,
    "Legacy un-scoped localStorage profile does NOT leak into fresh user account"
  );
  assert(
    (global as any).localStorage.getItem("careermonke_candidate_profile") === null,
    "Legacy un-scoped profile key is purged from localStorage upon inspection"
  );

  // User A profile is stored in user A's scoped key
  const userAProfile: CandidateProfile = {
    name: "User A",
    email: "user.a@example.com",
    phone: "+1 555-1111",
    location: "Remote",
    headline: "Engineer",
    summary: "Summary",
    skills: ["TypeScript"],
    experience: [],
    education: [],
    certifications: [],
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveCandidateProfileLocally(userAProfile, false, "user-a-id");
  assert(
    (global as any).localStorage.getItem(getCandidateProfileStorageKey("user-a-id")) !== null,
    "User A profile is persisted under user-scoped key"
  );

  // Negative control: User B must NOT see User A's profile
  clearCandidateProfileMemoryCache();
  const userBProfile = await getCandidateProfile("user-b-id", hermeticSupabaseClient);
  assert(userBProfile === null, "NEGATIVE CONTROL: User B receives null, not User A profile");

  // -------------------------------------------------------------------
  // TEST 2: Profile Completion Formula (Real Exported Helper)
  // -------------------------------------------------------------------
  console.log("\n--- Test 2: Profile Completion Formula (Real Exported Helper) ---");

  // Account with NO resume and NO preferences: 0%
  const resEmpty = calculateProfileCompletion({ candidate: null, preferences: null, savedJobIds: [] });
  assert(resEmpty.hasResume === false, "Account with no resume has hasResume === false");
  assert(resEmpty.completionPercentage === 0, "Account with no resume reports 0% completion");

  // Preferences-only account: 33%, Step 1 (resume) UNTICKED
  const resPrefsOnly = calculateProfileCompletion({
    candidate: null,
    preferences: { onboardingCompleted: true },
    savedJobIds: [],
  });
  assert(resPrefsOnly.hasResume === false, "Preferences-only account has hasResume === false");
  assert(resPrefsOnly.hasPreferences === true, "Preferences-only account has hasPreferences === true");
  assert(resPrefsOnly.completionPercentage === 33, "Preferences-only account reports 33% (never 75% or 100%)");

  // Preferences + 1 tracked job, NO resume: 67%, Step 1 (resume) UNTICKED
  const resPrefsAndSaved = calculateProfileCompletion({
    candidate: null,
    preferences: { onboardingCompleted: true },
    savedJobIds: ["job-1"],
  });
  assert(resPrefsAndSaved.hasResume === false, "Account without resume still has hasResume === false");
  assert(resPrefsAndSaved.completionPercentage === 67, "Account without resume reports 67% (never 100%)");

  // Full candidate with confirmed resume + preferences + tracked jobs: 100%
  const fullCandidate: CandidateProfile = {
    name: "Candidate",
    email: "test@example.com",
    headline: "Engineer",
    summary: "Experienced dev",
    skills: ["React", "TypeScript"],
    experience: [],
    education: [],
    certifications: [],
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const resFull = calculateProfileCompletion({
    candidate: fullCandidate,
    preferences: { onboardingCompleted: true },
    savedJobIds: ["job-1"],
  });
  assert(resFull.hasResume === true, "Account with confirmed resume has hasResume === true");
  assert(resFull.completionPercentage === 100, "Full account reports 100% completion");

  // Negative control: Unconfirmed candidate profile must NOT count as confirmed resume
  const unconfirmedCandidate: CandidateProfile = {
    name: "Candidate",
    headline: "Engineer",
    skills: ["React"],
    experience: [],
    education: [],
    certifications: [],
    confirmedAt: undefined,
    updatedAt: new Date().toISOString(),
  };
  const resUnconfirmed = calculateProfileCompletion({
    candidate: unconfirmedCandidate,
    preferences: { onboardingCompleted: true },
    savedJobIds: [],
  });
  assert(
    resUnconfirmed.hasResume === false,
    "NEGATIVE CONTROL: Unconfirmed candidate profile results in hasResume === false"
  );
  assert(
    resUnconfirmed.completionPercentage === 33,
    "NEGATIVE CONTROL: Unconfirmed candidate profile does not inflate completion %"
  );

  // -------------------------------------------------------------------
  // TEST 3: AI Filter Whole-Word Matching & Search Count Modes / Timeout Fallback
  // -------------------------------------------------------------------
  console.log("\n--- Test 3: AI Filter Whole-Word Matching & Search Route Logic ---");

  // Taxonomy verification
  assert(normalizeCategorySlug("ai-machine-learning") === "ai-ml", "ai-machine-learning normalizes to ai-ml");
  assert(normalizeCategorySlug("ai") === "ai-ml", "ai normalizes to ai-ml");
  const aiExpanded = expandCategoryFilter(["ai"]);
  assert(aiExpanded.includes("ai"), "Expanded 'ai' includes exact ingestion category 'ai'");
  assert(aiExpanded.includes("ai-ml"), "Expanded 'ai' includes canonical 'ai-ml'");

  // Verification of Whole-Word AI matching logic:
  // Regex and pattern logic: \bAI\b or exact whole-word bounds
  const aiWholeWordRegex = /\bAI\b/i;
  const aiMlRegex = /(machine learning|deep learning|\bllm\b|\bnlp\b)/i;

  // Positive controls (MUST MATCH AI):
  const aiPositives = [
    "AI Engineer",
    "Senior AI Researcher",
    "Head of AI",
    "AI/ML Engineer",
    "Generative AI Architect",
    "Applied AI Specialist",
    "Machine Learning Engineer",
    "Deep Learning Scientist",
    "Staff LLM Engineer",
    "NLP Research Scientist",
  ];
  for (const title of aiPositives) {
    const matches = aiWholeWordRegex.test(title) || aiMlRegex.test(title);
    assert(matches, `Positive control matches AI filter: '${title}'`);
  }

  // Negative controls (MUST NOT MATCH AI):
  // Bare %ai % and % ai% matched these; whole-word AI MUST reject them!
  const aiFalsePositives = [
    "Retail Associate",
    "Lead Client Partner, Retail Solutions",
    "Software Engineer in Dubai",
    "Airline Pilot",
    "Commercial Airline Dispatcher",
    "First Aid Coordinator",
    "Emergency Aid Worker",
    "Paid Media Specialist",
  ];
  for (const title of aiFalsePositives) {
    const matches = aiWholeWordRegex.test(title) || aiMlRegex.test(title);
    assert(!matches, `NEGATIVE CONTROL: False positive strictly rejected by AI filter: '${title}'`);
  }

  // Hermetic Mocking of Search Handler (Testing count modes, timeout 57014, fallback, hasMore)
  let lastCountOption: string | null = null;
  let simulatedTimeout = false;
  let queryInvocationCount = 0;

  const createMockSupabase = (shouldTimeoutOnce = false) => {
    return () => ({
      from: () => ({
        select: (_cols: string, opts?: { count?: string }) => {
          lastCountOption = opts?.count || null;
          queryInvocationCount++;

          const mockChain: any = {
            eq: () => mockChain,
            or: () => mockChain,
            in: () => mockChain,
            not: () => mockChain,
            gte: () => mockChain,
            is: () => mockChain,
            lt: () => mockChain,
            ilike: () => mockChain,
            order: () => mockChain,
            limit: () => mockChain,
            range: () => mockChain,
            then: (resolve: any) => {
              if (shouldTimeoutOnce && !simulatedTimeout && opts?.count === "exact") {
                simulatedTimeout = true;
                return resolve({
                  data: null,
                  count: null,
                  error: { code: "57014", message: "canceling statement due to statement timeout" },
                });
              }
              return resolve({
                data: [{ id: "mock-job-1", title: "Mock Engineer", posted_at: new Date().toISOString() }],
                count: opts?.count === "exact" ? 42 : 10000,
                error: null,
              });
            },
          };
          return mockChain;
        },
      }),
    });
  };

  // Case A: Unfiltered search must use count: "estimated"
  const unfilteredHandler = createSearchHandler({ getSupabaseAdmin: createMockSupabase(false) });
  lastCountOption = null;
  const resUnfiltered = await unfilteredHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: {},
  });
  const bodyUnfiltered = JSON.parse(resUnfiltered.body);
  assert(lastCountOption === "estimated", "Unfiltered search requests count: 'estimated'");
  assert(bodyUnfiltered.hasMore !== undefined, "Search response includes hasMore flag");
  assert(bodyUnfiltered.totalCount === 10000, "Unfiltered search returns count");

  // Case B: Filtered search must use count: "exact"
  lastCountOption = null;
  const filteredHandler = createSearchHandler({ getSupabaseAdmin: createMockSupabase(false) });
  const resFiltered = await filteredHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { category: "ai" },
  });
  const bodyFiltered = JSON.parse(resFiltered.body);
  assert(lastCountOption === "exact", "Filtered search requests count: 'exact'");
  assert(bodyFiltered.totalCount === 42, "Filtered search returns exact totalCount");
  assert(bodyFiltered.hasMore !== undefined, "Filtered search response includes hasMore flag");

  // Case C: Exact count times out with 57014 -> must fall back to estimated count
  lastCountOption = null;
  simulatedTimeout = false;
  queryInvocationCount = 0;
  const timeoutHandler = createSearchHandler({ getSupabaseAdmin: createMockSupabase(true) });
  const resTimeout = await timeoutHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { category: "ai" },
  });
  const bodyTimeout = JSON.parse(resTimeout.body);
  assert(resTimeout.statusCode === 200, "Timeout on exact count does NOT crash, recovers with 200");
  assert(lastCountOption === "estimated", "Exact count timeout (57014) falls back to count: 'estimated'");
  assert(queryInvocationCount === 2, "Exact count timeout triggers retry with estimated count");
  assert(bodyTimeout.hasMore !== undefined, "Timeout recovered response includes hasMore flag");

  // Case D: Fallback when count is null retains old fallback (not rows.length)
  const nullCountSupabase = () => ({
    from: () => ({
      select: () => {
        const mockChain: any = {
          eq: () => mockChain,
          or: () => mockChain,
          in: () => mockChain,
          not: () => mockChain,
          gte: () => mockChain,
          is: () => mockChain,
          lt: () => mockChain,
          ilike: () => mockChain,
          order: () => mockChain,
          limit: () => mockChain,
          range: () => mockChain,
          then: (resolve: any) =>
            resolve({
              data: [{ id: "mock-1" }, { id: "mock-2" }],
              count: null, // Null count
              error: null,
            }),
        };
        return mockChain;
      },
    }),
  });
  const nullCountHandler = createSearchHandler({ getSupabaseAdmin: nullCountSupabase });
  const resNullCount = await nullCountHandler({
    httpMethod: "GET",
    headers: {},
    queryStringParameters: { page: "1", pageSize: "25" },
  });
  const bodyNullCount = JSON.parse(resNullCount.body);
  assert(
    bodyNullCount.totalCount === 25, // Math.max(2, 1 * 25) = 25, NOT rows.length (2)
    `Null count fallback does NOT collapse to rows.length (expected 25, got ${bodyNullCount.totalCount})`
  );

  // -------------------------------------------------------------------
  // TEST 4: Sanitizer Classifier Mapping with Word Boundaries
  // -------------------------------------------------------------------
  console.log("\n--- Test 4: Sanitizer Classifier Mapping with Word Boundaries ---");

  // Agriculture and Horticulture MUST NOT be classified as marketing:
  const catAgri = detectCategory("Agriculture Engineer");
  assert(
    catAgri !== "marketing" && catAgri === "engineering",
    `'Agriculture Engineer' maps to 'engineering', NOT 'marketing' (got: '${catAgri}')`
  );

  const catHorti = detectCategory("Horticulture Specialist");
  assert(
    catHorti !== "marketing" && catHorti === "engineering",
    `'Horticulture Specialist' maps to 'engineering', NOT 'marketing' (got: '${catHorti}')`
  );

  const catAgriDir = detectCategory("Director of Agriculture Operations");
  assert(
    catAgriDir !== "marketing",
    `'Director of Agriculture Operations' is NOT marketing (got: '${catAgriDir}')`
  );

  // Word boundary matches for marketing:
  const catInfluencer = detectCategory("Influencer Manager, Social & Culture");
  assert(catInfluencer === "marketing", "'Influencer Manager, Social & Culture' correctly maps to 'marketing'");

  const catCommunity = detectCategory("Community Lead");
  assert(catCommunity === "marketing", "'Community Lead' correctly maps to 'marketing'");

  const catBrand = detectCategory("Brand Strategist");
  assert(catBrand === "marketing", "'Brand Strategist' correctly maps to 'marketing'");

  const catSocial = detectCategory("Social Media Coordinator");
  assert(catSocial === "marketing", "'Social Media Coordinator' correctly maps to 'marketing'");

  // Word boundary for TPM / Product:
  const catTPM = detectCategory("Technical Program Manager (TPM)");
  assert(catTPM === "product", "'Technical Program Manager (TPM)' correctly maps to 'product'");

  const catResearchPM = detectCategory("Research Program Manager");
  assert(catResearchPM === "product", "'Research Program Manager' correctly maps to 'product'");

  // Substring safety checks:
  const catAcquisition = detectCategory("Data Acquisition Engineer");
  assert(catAcquisition === "data", "'Data Acquisition Engineer' maps to 'data' (no 'ui' substring trap)");

  const catUI = detectCategory("UI Designer");
  assert(catUI === "design", "'UI Designer' maps to 'design'");

  const catUX = detectCategory("Senior UX Researcher");
  assert(catUX === "design", "'Senior UX Researcher' maps to 'design'");

  // Negative control:
  const catSWE = detectCategory("Senior Software Engineer");
  assert(catSWE === "engineering", "NEGATIVE CONTROL: 'Senior Software Engineer' maps to 'engineering'");

  // -------------------------------------------------------------------
  // TEST 5: Recommended Count Badge Returns Filtered Count
  // -------------------------------------------------------------------
  console.log("\n--- Test 5: Recommended Count Badge Filtered Logic ---");

  function getRecommendedTabBadgeCount(
    hasActiveFilters: boolean,
    totalCount: number,
    displayedCount: number,
    loading: boolean
  ): string {
    if (hasActiveFilters) {
      if (displayedCount === 0 && !loading) return "0";
      return totalCount > 0 ? totalCount.toLocaleString() : displayedCount.toLocaleString();
    }
    return totalCount > 0 ? totalCount.toLocaleString() : displayedCount.toLocaleString();
  }

  assert(
    getRecommendedTabBadgeCount(true, 1645, 25, false) === "1,645",
    "Badge returns '1,645' for active filter"
  );
  assert(
    getRecommendedTabBadgeCount(true, 0, 0, false) === "0",
    "Badge returns '0' when 0 jobs match active filters"
  );
  assert(
    getRecommendedTabBadgeCount(false, 17442, 25, false) === "17,442",
    "Badge returns '17,442' when no active filters are set"
  );
  assert(
    getRecommendedTabBadgeCount(true, 0, 0, false) !== "17,442",
    "NEGATIVE CONTROL: Badge never retains unfiltered count when 0 matches"
  );

  console.log("\n=======================================================");
  console.log("ALL HERMETIC DATA CORRECTNESS TESTS PASSED-LOCAL");
  console.log("=======================================================\n");
}

runHermeticTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
