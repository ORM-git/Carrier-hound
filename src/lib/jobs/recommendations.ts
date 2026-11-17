/**
 * src/lib/jobs/recommendations.ts
 *
 * Deterministic recommendation scoring engine for CareerMonke.
 * Ranks active jobs against user onboarding answers:
 * 1. Target Role / Category match (up to 40 pts)
 * 2. Location / Work Model (Remote) match (up to 30 pts)
 * 3. Experience / Seniority level match (up to 20 pts)
 * 4. Employment / Job Type match (up to 10 pts)
 * 5. Freshness recency tie-breaker (up to 5 pts)
 *
 * Fallback when user has no answers: latest jobs (ordered by posted_at DESC).
 * Strictly non-AI, zero external calls, pure TypeScript scoring.
 */

export interface OnboardingAnswers {
  roles?: string[];
  experienceLevel?: "entry" | "mid" | "senior" | "lead" | "intern" | string | null;
  remotePreference?: "remote" | "hybrid" | "onsite" | "any" | string | null;
  locations?: string[];
  employmentTypes?: string[];
  categories?: string[];
}

export interface JobScoreBreakdown {
  roleScore: number;
  locationScore: number;
  experienceScore: number;
  jobTypeScore: number;
  recencyScore: number;
}

export interface ScoredJobResult<T = any> {
  job: T;
  score: number;
  breakdown: JobScoreBreakdown;
  reasons: string[];
}

const GENERIC_ROLE_STOPWORDS = new Set([
  "and",
  "or",
  "the",
  "for",
  "with",
  "in",
  "at",
  "of",
  "to",
  "developer",
  "engineer",
  "specialist",
  "manager",
]);

/**
 * Checks if the user provided substantive onboarding answers.
 */
export function hasOnboardingAnswers(answers?: OnboardingAnswers | null): boolean {
  if (!answers) return false;

  const hasRoles = Array.isArray(answers.roles) && answers.roles.some((r) => r && r.trim().length > 0);
  const hasExp = Boolean(answers.experienceLevel && answers.experienceLevel.trim().length > 0);
  const hasRemote = Boolean(answers.remotePreference && answers.remotePreference.trim().length > 0);
  const hasLocs = Array.isArray(answers.locations) && answers.locations.some((l) => l && l.trim().length > 0);
  const hasTypes = Array.isArray(answers.employmentTypes) && answers.employmentTypes.some((t) => t && t.trim().length > 0);
  const hasCats = Array.isArray(answers.categories) && answers.categories.some((c) => c && c.trim().length > 0);

  return hasRoles || hasExp || hasRemote || hasLocs || hasTypes || hasCats;
}

/**
 * Extracts normalized tokens from role strings.
 */
function extractRoleTokens(roles: string[]): string[] {
  const tokens = new Set<string>();
  for (const r of roles) {
    if (!r || typeof r !== "string") continue;
    const clean = r.toLowerCase().replace(/[^a-z0-9+#\s-]/g, " ").trim();
    if (!clean) continue;
    tokens.add(clean); // Full role phrase
    const words = clean.split(/[\s-]+/).filter((w) => w.length >= 2);
    for (const w of words) {
      if (!GENERIC_ROLE_STOPWORDS.has(w)) {
        tokens.add(w);
      }
    }
  }
  return Array.from(tokens);
}

export type JobScoringCandidate = {
  title?: string | null;
  category?: string | null;
  location?: string | null;
  country?: string | null;
  country_code?: string | null;
  remote?: boolean | null;
  remote_scope?: string | null;
  remote_eligibility?: string | null;
  job_type?: string | null;
  posted_at?: string | null;
  created_at?: string | null;
  first_seen_at?: string | null;
  company?: string | null;
  company_id?: string | null;
  companyId?: string | null;
  companyGroupId?: string | null;
  [key: string]: any;
};

/**
 * Scores a single job against onboarding answers.
 * Returns score (0 - 100) and breakdown.
 */
export function scoreJobRecommendation(
  job: JobScoringCandidate,
  answers: OnboardingAnswers
): ScoredJobResult {
  const reasons: string[] = [];
  const title = (job.title || "").toLowerCase();
  const category = (job.category || "").toLowerCase();
  const location = (job.location || "").toLowerCase();
  const country = (job.country || "").toLowerCase();
  const countryCode = (job.country_code || "").toLowerCase();
  const isRemote = job.remote === true || (job.remote_scope || "").toLowerCase() === "remote" || location.includes("remote");
  const remoteScope = (job.remote_scope || "").toLowerCase();
  const jobType = (job.job_type || "").toLowerCase();

  // 1. ROLE & CATEGORY MATCHING (0 - 40 pts)
  let roleScore = 0;
  const userRoles = (answers.roles || []).filter((r) => r && r.trim().length > 0);
  const userCategories = (answers.categories || []).filter((c) => c && c.trim().length > 0);

  if (userRoles.length > 0) {
    let exactPhraseMatch = false;
    for (const r of userRoles) {
      const cleanR = r.toLowerCase().trim();
      if (cleanR.length >= 3 && title.includes(cleanR)) {
        exactPhraseMatch = true;
        reasons.push(`Target role match: "${r}"`);
        break;
      }
    }

    if (exactPhraseMatch) {
      roleScore = 40;
    } else {
      const tokens = extractRoleTokens(userRoles);
      let matchedTokens = 0;
      for (const t of tokens) {
        if (t.length >= 3 && title.includes(t)) {
          matchedTokens++;
        }
      }
      if (matchedTokens >= 2) {
        roleScore = 32;
        reasons.push("Strong title keyword match");
      } else if (matchedTokens === 1) {
        roleScore = 20;
        reasons.push("Title keyword match");
      }
    }
  }

  // Category match bonus if role didn't hit max 40
  if (roleScore < 40 && userCategories.length > 0 && category) {
    if (userCategories.some((c) => c.toLowerCase() === category || category.includes(c.toLowerCase()))) {
      roleScore = Math.min(40, roleScore + 15);
      reasons.push(`Category match: ${category}`);
    }
  }

  // 2. LOCATION & REMOTE WORK MODEL MATCHING (0 - 30 pts)
  let locationScore = 0;
  const userRemote = (answers.remotePreference || "").toLowerCase().trim();
  const userLocations = (answers.locations || []).filter((l) => l && l.trim().length > 0);

  // Work model component (up to 20 pts)
  if (userRemote === "remote" || userRemote === "any") {
    if (isRemote) {
      locationScore += 20;
      reasons.push("Remote match");
      if (remoteScope === "worldwide" || location.includes("worldwide") || location.includes("global")) {
        locationScore += 5; // Worldwide bonus
      }
    } else if (userRemote === "any") {
      locationScore += 10;
    }
  } else if (userRemote === "hybrid") {
    if (remoteScope === "hybrid" || location.includes("hybrid")) {
      locationScore += 20;
      reasons.push("Hybrid match");
    } else if (isRemote) {
      locationScore += 10;
    }
  } else if (userRemote === "onsite") {
    if (!isRemote && (remoteScope === "onsite" || location.includes("onsite") || (!location.includes("remote") && location.length > 0))) {
      locationScore += 20;
      reasons.push("On-site match");
    }
  }

  // Region / Country component (up to 10 pts)
  if (userLocations.length > 0) {
    let countryMatched = false;
    for (const loc of userLocations) {
      const cleanLoc = loc.toLowerCase().trim();
      if (cleanLoc.includes("worldwide") || cleanLoc.includes("remote")) {
        if (isRemote) {
          countryMatched = true;
          break;
        }
      } else if (
        (country && (country.includes(cleanLoc) || cleanLoc.includes(country))) ||
        (countryCode && (countryCode === cleanLoc || cleanLoc.includes(countryCode))) ||
        location.includes(cleanLoc)
      ) {
        countryMatched = true;
        reasons.push(`Location match: ${loc}`);
        break;
      }
    }
    if (countryMatched) {
      locationScore = Math.min(30, locationScore + 10);
    }
  } else if (userRemote && isRemote) {
    locationScore = Math.min(30, locationScore + 5);
  }

  // 3. EXPERIENCE / SENIORITY LEVEL MATCHING (0 - 20 pts)
  let experienceScore = 0;
  const userExp = (answers.experienceLevel || "").toLowerCase().trim();

  if (userExp) {
    const isLeadOrPrincipal = /\b(lead|staff|principal|head|director|architect|manager)\b/i.test(title);
    const isSenior = /\b(senior|sr\.?)\b/i.test(title);
    const isJuniorOrEntry = /\b(junior|entry|associate|graduate|fresher|intern|internship)\b/i.test(title);

    if (userExp === "entry" || userExp === "intern") {
      if (isJuniorOrEntry) {
        experienceScore = 20;
        reasons.push("Entry/Junior seniority match");
      } else if (!isSenior && !isLeadOrPrincipal) {
        experienceScore = 14;
      } else {
        experienceScore = 0; // Senior/lead penalty for entry seeker
      }
    } else if (userExp === "mid") {
      if (!isJuniorOrEntry && !isLeadOrPrincipal) {
        experienceScore = isSenior ? 8 : 20;
        if (!isSenior) reasons.push("Mid-level seniority match");
      } else if (isJuniorOrEntry) {
        experienceScore = 4;
      } else {
        experienceScore = 2;
      }
    } else if (userExp === "senior") {
      if (isSenior && !isLeadOrPrincipal) {
        experienceScore = 20;
        reasons.push("Senior role match");
      } else if (isLeadOrPrincipal) {
        experienceScore = 14;
      } else if (!isJuniorOrEntry) {
        experienceScore = 10;
      } else {
        experienceScore = 0;
      }
    } else if (userExp === "lead") {
      if (isLeadOrPrincipal) {
        experienceScore = 20;
        reasons.push("Lead/Principal role match");
      } else if (isSenior) {
        experienceScore = 14;
      } else if (!isJuniorOrEntry) {
        experienceScore = 8;
      } else {
        experienceScore = 0;
      }
    }
  }

  // 4. JOB TYPE / EMPLOYMENT TYPE MATCHING (0 - 10 pts)
  let jobTypeScore = 0;
  const userJobTypes = (answers.employmentTypes || []).map((t) => t.toLowerCase().trim()).filter(Boolean);

  if (userJobTypes.length > 0) {
    if (userJobTypes.some((t) => jobType.includes(t) || t.includes(jobType))) {
      jobTypeScore = 10;
      reasons.push("Employment type match");
    } else if (userJobTypes.includes("full-time") && (jobType.includes("full") || !jobType || jobType === "job")) {
      jobTypeScore = 8;
    }
  }

  // 5. FRESHNESS RECENCY TIE-BREAKER (0 - 5 pts)
  let recencyScore = 0;
  const dateStr = job.posted_at || job.created_at || job.first_seen_at;
  if (dateStr) {
    const postTime = new Date(dateStr).getTime();
    if (!isNaN(postTime)) {
      const ageHours = (Date.now() - postTime) / (1000 * 60 * 60);
      if (ageHours <= 24) recencyScore = 5;
      else if (ageHours <= 24 * 7) recencyScore = 3;
      else if (ageHours <= 24 * 30) recencyScore = 1;
    }
  }

  const totalScore = Math.min(100, roleScore + locationScore + experienceScore + jobTypeScore + recencyScore);

  return {
    job,
    score: totalScore,
    breakdown: {
      roleScore,
      locationScore,
      experienceScore,
      jobTypeScore,
      recencyScore,
    },
    reasons,
  };
}

/**
 * Ranks an array of jobs according to onboarding answers.
 * If answers are empty or null, falls back cleanly to latest jobs (posted_at DESC).
 */
export function rankJobsByRecommendation<T extends JobScoringCandidate = JobScoringCandidate>(
  jobs: T[],
  answers?: OnboardingAnswers | null
): (T & { _matchScore?: number; matchScore?: number })[] {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }

  // Fallback when a user has no answers: latest jobs
  if (!hasOnboardingAnswers(answers)) {
    return [...jobs].sort((a, b) => {
      const timeA = new Date(a.posted_at || a.created_at || a.first_seen_at || 0).getTime();
      const timeB = new Date(b.posted_at || b.created_at || b.first_seen_at || 0).getTime();
      return timeB - timeA;
    });
  }

  const scored = jobs.map((job) => scoreJobRecommendation(job, answers!));

  scored.sort((a, b) => {
    // 1. Primary sort: recommendation score DESC
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // 2. Secondary sort: recency DESC
    const timeA = new Date(a.job.posted_at || a.job.created_at || a.job.first_seen_at || 0).getTime();
    const timeB = new Date(b.job.posted_at || b.job.created_at || b.job.first_seen_at || 0).getTime();
    return timeB - timeA;
  });

  return scored.map((s) => ({
    ...s.job,
    _matchScore: s.score,
    matchScore: s.score,
  }));
}
