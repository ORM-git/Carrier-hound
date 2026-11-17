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


import { isJobEligible } from "./eligibility";

export interface OnboardingAnswers {
  roles?: string[];
  experienceLevel?: "entry" | "mid" | "senior" | "lead" | "intern" | string | null;
  remotePreference?: "remote" | "hybrid" | "onsite" | "any" | string | null;
  locations?: string[];
  employmentTypes?: string[];
  categories?: string[];
  minSalary?: number | null;
  salaryCurrency?: string | null;
  country?: string | null;
  countryCode?: string | null;
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
  const hasMinSalary = typeof answers.minSalary === "number" && answers.minSalary > 0;
  const hasCountry = Boolean(
    (answers.country && answers.country.trim().length > 0) ||
    (answers.countryCode && answers.countryCode.trim().length > 0)
  );

  return hasRoles || hasExp || hasRemote || hasLocs || hasTypes || hasCats || hasMinSalary || hasCountry;
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
  const isRemote =
    job.remote === true ||
    (job.remote_scope || "").toLowerCase() === "remote" ||
    (job.remote_scope || "").toLowerCase() === "worldwide" ||
    (job.remoteScope || "").toLowerCase() === "remote" ||
    (job.remoteScope || "").toLowerCase() === "worldwide" ||
    location.includes("remote");
  const remoteScope = (job.remote_scope || job.remoteScope || "").toLowerCase();
  const jobType = (job.job_type || "").toLowerCase();

  // --- HARD FILTERS & STRONG RANKING SIGNALS ---

  // 1. Work Model Hard Filter: 100% remote seeker must NEVER match on-site jobs
  const userRemote = (answers.remotePreference || "").toLowerCase().trim();
  if (userRemote === "remote" && !isRemote) {
    return {
      job,
      score: 0,
      breakdown: {
        roleScore: 0,
        locationScore: 0,
        experienceScore: 0,
        jobTypeScore: 0,
        recencyScore: 0,
      },
      reasons: ["Work model mismatch: on-site job for 100% remote seeker"],
    };
  }

  // 2. Seniority Level Hard Filter:
  // An entry-level seeker must NEVER match Senior, Staff, Lead, Principal, Director, Manager roles
  const userExp = (answers.experienceLevel || "").toLowerCase().trim();
  const isLeadOrPrincipal = /\b(lead|staff|principal|head|director|architect|manager|vp|chief)\b/i.test(title);
  const isSenior = /\b(senior|sr\.?)\b/i.test(title);
  const isJuniorOrEntry = /\b(junior|entry|associate|graduate|fresher|intern|internship)\b/i.test(title);

  if ((userExp === "entry" || userExp === "intern") && (isSenior || isLeadOrPrincipal)) {
    return {
      job,
      score: 0,
      breakdown: {
        roleScore: 0,
        locationScore: 0,
        experienceScore: 0,
        jobTypeScore: 0,
        recencyScore: 0,
      },
      reasons: ["Seniority mismatch: Senior/Staff/Lead role for entry-level seeker"],
    };
  }

  if ((userExp === "senior" || userExp === "lead") && isJuniorOrEntry) {
    return {
      job,
      score: 0,
      breakdown: {
        roleScore: 0,
        locationScore: 0,
        experienceScore: 0,
        jobTypeScore: 0,
        recencyScore: 0,
      },
      reasons: ["Seniority mismatch: Entry/Junior/Intern role for senior/lead seeker"],
    };
  }

  // 3. Country / Geographic Hard Filter:
  // Jobs restricted outside user country preferences are disqualified (unless worldwide remote)
  const userLocations = [
    ...(answers.locations || []),
    ...(answers.country ? [answers.country] : []),
    ...(answers.countryCode ? [answers.countryCode] : []),
  ].filter((l): l is string => Boolean(l && l.trim().length > 0));

  if (userLocations.length > 0) {
    const eligible = isJobEligible(job, userLocations);
    if (!eligible) {
      return {
        job,
        score: 0,
        breakdown: {
          roleScore: 0,
          locationScore: 0,
          experienceScore: 0,
          jobTypeScore: 0,
          recencyScore: 0,
        },
        reasons: ["Location mismatch: job restricted outside user preferences"],
      };
    }
  }

  // 4. Salary Hard Filter:
  // If the job explicitly offers maximum compensation below 80% of user minSalary requirement, disqualify
  if (typeof answers.minSalary === "number" && answers.minSalary > 0) {
    const rawMax =
      job.salary_max ??
      job.max_amount ??
      job.salaryMax ??
      job.salary_min ??
      job.min_amount ??
      job.salaryMin;
    if (typeof rawMax === "number" && rawMax > 0) {
      const period = (job.salary_period || job.period || "").toLowerCase();
      let annualMax = rawMax;
      if (period === "hourly" || (rawMax < 500 && period !== "yearly")) {
        annualMax = rawMax * 2080;
      } else if (period === "monthly" || (rawMax < 25000 && period !== "yearly")) {
        annualMax = rawMax * 12;
      }
      if (annualMax < answers.minSalary * 0.8) {
        return {
          job,
          score: 0,
          breakdown: {
            roleScore: 0,
            locationScore: 0,
            experienceScore: 0,
            jobTypeScore: 0,
            recencyScore: 0,
          },
          reasons: ["Salary mismatch: compensation below minimum salary requirement"],
        };
      }
    }
  }

  // --- DETERMINISTIC SCORING (For Qualifying Roles) ---

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

  if (userExp) {
    if (userExp === "entry" || userExp === "intern") {
      if (isJuniorOrEntry) {
        experienceScore = 20;
        reasons.push("Entry/Junior seniority match");
      } else if (!isSenior && !isLeadOrPrincipal) {
        experienceScore = 14;
      } else {
        experienceScore = 0;
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

  // Fallback when a user has no answers: latest jobs with deterministic tie-breaks
  if (!hasOnboardingAnswers(answers)) {
    return [...jobs].sort((a, b) => {
      const timeA = new Date(a.posted_at || a.created_at || a.first_seen_at || 0).getTime();
      const timeB = new Date(b.posted_at || b.created_at || b.first_seen_at || 0).getTime();
      if (timeB !== timeA) {
        return timeB - timeA;
      }
      const idA = String(a.id ?? "");
      const idB = String(b.id ?? "");
      return idB.localeCompare(idA);
    });
  }

  const userRemote = (answers!.remotePreference || "").toLowerCase().trim();
  const userExp = (answers!.experienceLevel || "").toLowerCase().trim();
  const userLocations = [
    ...(answers!.locations || []),
    ...(answers!.country ? [answers!.country] : []),
    ...(answers!.countryCode ? [answers!.countryCode] : []),
  ].filter((l): l is string => Boolean(l && l.trim().length > 0));

  // Drop every row that fails the user's hard preferences (remote, experience, country) or scores 0
  const qualifyingScored = jobs
    .map((job) => scoreJobRecommendation(job, answers!))
    .filter((s) => {
      // Must have positive score (not scored 0 / disqualified)
      if (s.score <= 0) return false;

      const job = s.job;
      const title = (job.title || "").toLowerCase();
      const location = (job.location || "").toLowerCase();
      const isRemote =
        job.remote === true ||
        (job.remote_scope || "").toLowerCase() === "remote" ||
        (job.remote_scope || "").toLowerCase() === "worldwide" ||
        (job.remoteScope || "").toLowerCase() === "remote" ||
        (job.remoteScope || "").toLowerCase() === "worldwide" ||
        location.includes("remote");

      // 1. Remote hard preference: if remote, must be remote
      if (userRemote === "remote" && !isRemote) {
        return false;
      }
      if (userRemote === "onsite" && isRemote) {
        return false;
      }

      // 2. Experience hard preference
      const isSeniorOrLead = /\b(lead|staff|principal|head|director|architect|manager|vp|chief|senior|sr\.?)\b/i.test(title);
      const isJuniorOrEntry = /\b(junior|entry|associate|graduate|fresher|intern|internship)\b/i.test(title);
      if ((userExp === "entry" || userExp === "intern") && isSeniorOrLead) {
        return false;
      }
      if ((userExp === "senior" || userExp === "lead") && isJuniorOrEntry) {
        return false;
      }

      // 3. Country / Geographic hard preference
      if (userLocations.length > 0 && !isJobEligible(job, userLocations)) {
        return false;
      }

      return true;
    });

  qualifyingScored.sort((a, b) => {
    // 1. Primary sort: recommendation score DESC
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // 2. Secondary sort: recency DESC (posted_at desc)
    const timeA = new Date(a.job.posted_at || a.job.created_at || a.job.first_seen_at || 0).getTime();
    const timeB = new Date(b.job.posted_at || b.job.created_at || b.job.first_seen_at || 0).getTime();
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    // 3. Deterministic tie-breaker: id DESC
    const idA = String(a.job.id ?? "");
    const idB = String(b.job.id ?? "");
    return idB.localeCompare(idA);
  });

  return qualifyingScored.map((s) => ({
    ...s.job,
    _matchScore: s.score,
    matchScore: s.score,
  }));
}
