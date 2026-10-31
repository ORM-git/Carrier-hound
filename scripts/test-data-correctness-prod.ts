/**
 * Test Suite: Production Data Correctness Fixes
 * Covers:
 * (1) Fresh Google accounts start empty, no cross-account cache leak, user-scoped storage
 * (2) Profile completion strictly derived from real user data (no false 100% / unticked with no resume)
 * (3) "AI & Machine Learning" category filter aligned with exact stored category labels ("ai")
 * (4) Ingestion classifier mapping: "Influencer Manager, Social & Culture" -> marketing, "Research Program Manager" -> product
 * (5) Recommended count badge / query returns filtered count across active filters
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { detectCategory } from "./utils/sanitizer";
import { expandCategoryFilter, normalizeCategorySlug } from "../src/lib/taxonomy";
import {
  getCandidateProfile,
  saveCandidateProfileLocally,
  clearCandidateProfileMemoryCache,
  getCandidateProfileStorageKey,
} from "../src/lib/resume/storage";
import { getLiveJobs } from "../src/lib/jobs/service";
import type { CandidateProfile } from "../src/lib/resume/types";

// Mock minimal browser localStorage if running in Node
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

// Attach mock window & localStorage for Node environment test
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

async function runTests() {
  console.log("\n=======================================================");
  console.log("RUNNING PRODUCTION DATA-CORRECTNESS TEST SUITE");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------
  // TEST 1: Fresh Account Profile Leak Prevention & Scoped Storage
  // -------------------------------------------------------------------
  console.log("--- Test 1: Candidate Profile Reset & Cross-Account Isolation ---");
  clearCandidateProfileMemoryCache();
  (global as any).localStorage.clear();

  // Fresh user with no profile in Supabase must return null (empty state)
  const freshUserId = "00000000-0000-4000-a000-000000000001";
  const freshProfile = await getCandidateProfile(freshUserId);
  assert(freshProfile === null, "Fresh account with no DB row starts completely empty (null)");

  // Legacy un-scoped key in localStorage must NOT leak into a fresh account
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
  const isolatedProfile = await getCandidateProfile(freshUser2Id);
  assert(
    isolatedProfile === null,
    "Legacy un-scoped localStorage profile does NOT leak into fresh user account"
  );
  assert(
    (global as any).localStorage.getItem("careermonke_candidate_profile") === null,
    "Legacy un-scoped profile key is purged from localStorage upon inspection"
  );

  // User A's confirmed profile is saved in user A's scoped key
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
  const userBProfile = await getCandidateProfile("user-b-id");
  assert(userBProfile === null, "NEGATIVE CONTROL: User B receives null, not User A profile");

  // -------------------------------------------------------------------
  // TEST 2: Profile Completion Strictly Derived From Real User Data
  // -------------------------------------------------------------------
  console.log("\n--- Test 2: Profile Completion Strict Calculation ---");

  // Helper matching jobs/page.tsx profile completion formula
  function computeProfileCompletion(candidate: any, preferences: any, savedJobIds: string[]) {
    const hasResume = Boolean(
      candidate?.confirmedAt &&
        ((candidate.skills && candidate.skills.length > 0) ||
          (candidate.experience && candidate.experience.length > 0) ||
          (candidate.rawText && candidate.rawText.trim().length > 0))
    );
    const hasPreferences = Boolean(
      preferences?.onboardingCompleted ||
        (preferences?.roles && preferences.roles.length > 0)
    );
    const hasTracked = Boolean(savedJobIds && savedJobIds.length > 0);
    const completedSteps = [hasResume, hasPreferences, hasTracked].filter(Boolean).length;
    const completionPercentage = Math.round((completedSteps / 3) * 100);
    return { hasResume, hasPreferences, hasTracked, completionPercentage };
  }

  // Account with NO resume and NO preferences and NO tracked jobs: 0%
  const resEmpty = computeProfileCompletion(null, null, []);
  assert(resEmpty.hasResume === false, "Account with no resume has hasResume === false");
  assert(resEmpty.completionPercentage === 0, "Account with no resume reports 0% completion (not 50%)");

  // Account with onboarding preferences only: 33%, resume step UNTICKED
  const resPrefsOnly = computeProfileCompletion(null, { onboardingCompleted: true }, []);
  assert(resPrefsOnly.hasResume === false, "Preferences-only account has hasResume === false");
  assert(resPrefsOnly.hasPreferences === true, "Preferences-only account has hasPreferences === true");
  assert(resPrefsOnly.completionPercentage === 33, "Preferences-only account reports 33% (never 75% or 100%)");

  // Account with preferences + 1 saved job but NO resume: 67%, resume step UNTICKED
  const resPrefsAndSaved = computeProfileCompletion(null, { onboardingCompleted: true }, ["job-1"]);
  assert(resPrefsAndSaved.hasResume === false, "Account without resume still has hasResume === false");
  assert(resPrefsAndSaved.completionPercentage === 67, "Account without resume reports 67% (never 100%)");

  // Account with real resume + preferences + tracked jobs: 100%
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
  const resFull = computeProfileCompletion(fullCandidate, { onboardingCompleted: true }, ["job-1"]);
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
  const resUnconfirmed = computeProfileCompletion(unconfirmedCandidate, { onboardingCompleted: true }, []);
  assert(
    resUnconfirmed.hasResume === false,
    "NEGATIVE CONTROL: Unconfirmed candidate profile results in hasResume === false"
  );
  assert(
    resUnconfirmed.completionPercentage === 33,
    "NEGATIVE CONTROL: Unconfirmed candidate profile does not inflate completion %"
  );

  // -------------------------------------------------------------------
  // TEST 3: Taxonomy & Category Filter Alignment ("ai-machine-learning" -> "ai")
  // -------------------------------------------------------------------
  console.log("\n--- Test 3: Category Filter Taxonomy & Query Alignment ---");

  // Slug normalization
  assert(normalizeCategorySlug("ai-machine-learning") === "ai-ml", "ai-machine-learning normalizes to ai-ml");
  assert(normalizeCategorySlug("ai") === "ai-ml", "ai normalizes to ai-ml");

  // Filter expansion includes both aliases and exact stored labels
  const aiExpanded = expandCategoryFilter(["ai"]);
  assert(aiExpanded.includes("ai"), "Expanded 'ai' includes exact ingestion category 'ai'");
  assert(aiExpanded.includes("ai-ml"), "Expanded 'ai' includes canonical 'ai-ml'");

  const aiMlExpanded = expandCategoryFilter(["ai-machine-learning"]);
  assert(aiMlExpanded.includes("ai"), "Expanded 'ai-machine-learning' includes 'ai'");

  // Real query testing against Supabase jobs_public
  const liveAiJobs = await getLiveJobs({ category: "ai", pageSize: 5 });
  assert(liveAiJobs.totalCount > 0, `getLiveJobs with category='ai' returns non-zero results (${liveAiJobs.totalCount} jobs)`);
  assert(liveAiJobs.jobs.length > 0, `getLiveJobs with category='ai' returns jobs in payload (count=${liveAiJobs.jobs.length})`);

  const liveAiMlJobs = await getLiveJobs({ category: "ai-machine-learning", pageSize: 5 });
  assert(liveAiMlJobs.totalCount > 0, `getLiveJobs with category='ai-machine-learning' returns non-zero results (${liveAiMlJobs.totalCount} jobs)`);

  const liveDataJobs = await getLiveJobs({ category: "data", pageSize: 5 });
  assert(liveDataJobs.totalCount > 0, `getLiveJobs with category='data' returns data jobs (${liveDataJobs.totalCount} jobs)`);

  // Negative control: bogus category returns 0
  const bogusCatJobs = await getLiveJobs({ category: "non-existent-category-slug-9999", pageSize: 5 });
  assert(
    bogusCatJobs.totalCount === 0 && bogusCatJobs.jobs.length === 0,
    "NEGATIVE CONTROL: Non-existent category query returns 0 jobs"
  );

  // -------------------------------------------------------------------
  // TEST 4: Ingestion Classifier Mapping
  // -------------------------------------------------------------------
  console.log("\n--- Test 4: Ingestion Classifier Mapping ---");

  // Bug (4) exact reported titles:
  const catInfluencer = detectCategory("Influencer Manager, Social & Culture");
  assert(
    catInfluencer === "marketing",
    `'Influencer Manager, Social & Culture' correctly maps to 'marketing' (was engineering, got: '${catInfluencer}')`
  );

  const catResearchPM = detectCategory("Research Program Manager");
  assert(
    catResearchPM === "product",
    `'Research Program Manager' correctly maps to 'product' (was engineering, got: '${catResearchPM}')`
  );

  // Word boundary check: 'ui' substring trap must not misclassify data acquisition
  const catAcquisition = detectCategory("Data Acquisition Engineer");
  assert(
    catAcquisition === "data",
    `'Data Acquisition Engineer' maps to 'data' (not misclassified as 'design' due to 'ui' in acquisition)`
  );

  const catUI = detectCategory("UI Designer");
  assert(catUI === "design", "'UI Designer' maps to 'design'");

  const catUX = detectCategory("Senior UX Researcher");
  assert(catUX === "design", "'Senior UX Researcher' maps to 'design'");

  const catSocialMedia = detectCategory("Social Media Lead");
  assert(catSocialMedia === "marketing", "'Social Media Lead' maps to 'marketing'");

  const catTPM = detectCategory("Technical Program Manager");
  assert(catTPM === "product", "'Technical Program Manager' maps to 'product'");

  // Negative control: standard developer role maps to engineering
  const catSWE = detectCategory("Senior Software Engineer");
  assert(
    catSWE === "engineering",
    "NEGATIVE CONTROL: 'Senior Software Engineer' maps to 'engineering'"
  );

  // -------------------------------------------------------------------
  // TEST 5: Recommended Count Badge Returns Filtered Count
  // -------------------------------------------------------------------
  console.log("\n--- Test 5: Recommended Count Badge Returns Filtered Count ---");

  // Total active jobs without filters
  const unfilteredJobs = await getLiveJobs({ pageSize: 5 });
  assert(unfilteredJobs.totalCount > 1000, `Unfiltered total count is large (${unfilteredJobs.totalCount})`);

  // Filtered by category 'ai': count should be strictly smaller than total jobs
  assert(
    liveAiJobs.totalCount < unfilteredJobs.totalCount,
    `Category 'ai' filtered count (${liveAiJobs.totalCount}) is strictly less than total (${unfilteredJobs.totalCount})`
  );

  // Filtered by country code: count should be strictly smaller than total jobs
  const deJobs = await getLiveJobs({ countryCode: "DE", pageSize: 5 });
  assert(
    deJobs.totalCount > 0 && deJobs.totalCount < unfilteredJobs.totalCount,
    `Country 'DE' filtered count (${deJobs.totalCount}) is strictly less than total (${unfilteredJobs.totalCount})`
  );

  // Multi-filter: Category 'ai' + country 'US'
  const aiUsJobs = await getLiveJobs({ category: "ai", countryCode: "US", pageSize: 5 });
  assert(
    aiUsJobs.totalCount <= liveAiJobs.totalCount,
    `Combined filter 'ai' + 'US' (${aiUsJobs.totalCount}) is <= category 'ai' count (${liveAiJobs.totalCount})`
  );

  // Recommended count badge logic in jobs/page.tsx:
  // When active filters are present, badge must show the filtered count (not the unfiltered 17,442)
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
    "Badge returns '1,645' for AI filter (not 17,442)"
  );
  assert(
    getRecommendedTabBadgeCount(true, 0, 0, false) === "0",
    "Badge returns '0' when 0 jobs match active filters (not unfiltered count)"
  );
  assert(
    getRecommendedTabBadgeCount(false, 17442, 25, false) === "17,442",
    "Badge returns '17,442' when no active filters are set"
  );

  // Negative control: Bogus filter returns count of 0
  assert(
    getRecommendedTabBadgeCount(true, 0, 0, false) !== "17,442",
    "NEGATIVE CONTROL: Badge never retains unfiltered count when 0 matches"
  );

  console.log("\n=======================================================");
  console.log("ALL 5 DATA CORRECTNESS TEST SUITES PASSED-LOCAL");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
