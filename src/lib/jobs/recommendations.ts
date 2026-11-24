/**
 * src/lib/jobs/recommendations.ts
 *
 * Deterministic recommendation scoring engine for CareerMonke: the ONE scoring path for every recommendation
 * surface (/api/jobs/recommended, the jobs service, Top 10, the daily digest). Jobs that fail the relevance gate
 * (isRelevantToProfile: no overlap with the user's target role, field or skills) are never recommended.
 * Ranks active jobs against user onboarding answers:
 * 1. Target Role / Category match (up to 40 pts)
 * 2. Location / Work Model (Remote) match (up to 30 pts)
 * 3. Experience / Seniority level match (up to 20 pts)
 * 4. Employment / Job Type match (up to 10 pts)
 * 5. Freshness recency tie-breaker (up to 5 pts)
 * 6. Parsed resume / LinkedIn PDF boost (up to 15 pts, soft only; never a hard filter)
 *
 * Fallback when user has no answers: latest jobs (ordered by posted_at DESC).
 * Strictly non-AI, zero external calls, pure TypeScript scoring.
 */


import { isJobEligible } from "./eligibility";
import { isEarlyCareerJob } from "./experienceLevels";
import { detectPayPeriod, parseSalary } from "../salary/parser";
import { convertCurrency } from "../salary/fx";
import type { CandidateProfile } from "../resume/types";

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
  /**
   * Signals parsed from the user's onboarding resume / LinkedIn PDF
   * (public.onboarding_resume_profiles). Soft ranking boost only: never a hard filter.
   */
  resumeProfile?: ResumeRankingSignals | null;
}

export interface ResumeRankingSignals {
  jobTitles?: string[];
  skills?: string[];
  preferredRoles?: string[];
  yearsOfExperience?: number | null;
}

export interface JobScoreBreakdown {
  roleScore: number;
  locationScore: number;
  experienceScore: number;
  jobTypeScore: number;
  recencyScore: number;
  /** 0 - 15 pts from the parsed resume (absent when the user has none). */
  resumeScore?: number;
}

export const RESUME_TITLE_MAX = 8;
export const RESUME_SKILL_MAX = 7;
const RESUME_DESCRIPTION_SCAN_CHARS = 4000;

export function hasResumeSignals(r?: ResumeRankingSignals | null): boolean {
  if (!r) return false;
  const any = (a?: string[]) => Array.isArray(a) && a.some((x) => typeof x === "string" && x.trim().length > 0);
  return any(r.jobTitles) || any(r.skills) || any(r.preferredRoles);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-term, case-insensitive match that also works for terms like "C++", "Node.js", ".NET". */
function containsTerm(haystack: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (t.length < 2) return false;
  return new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(t)}($|[^a-z0-9+#])`, "i").test(haystack);
}

/**
 * Resume boost (0 - 15): title / preferred-role match (0 - 8) + skills found in the job's
 * title, skills list or description (0 - 7). Pure and deterministic.
 */
export function scoreResumeMatch(
  job: JobScoringCandidate,
  resume?: ResumeRankingSignals | null
): { score: number; reasons: string[] } {
  if (!hasResumeSignals(resume)) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  const title = (job.title || "").toLowerCase();

  const roleTerms = [...(resume!.preferredRoles || []), ...(resume!.jobTitles || [])]
    .filter((r): r is string => typeof r === "string" && r.trim().length >= 3)
    .slice(0, 15);
  let titleScore = 0;
  const phrase = roleTerms.find((r) => title.includes(r.toLowerCase().trim()));
  if (phrase) {
    titleScore = RESUME_TITLE_MAX;
    reasons.push(`Matches your resume title: "${phrase}"`);
  } else {
    const tokens = extractRoleTokens(roleTerms).filter((t) => t.length >= 3 && !t.includes(" "));
    const hits = tokens.filter((t) => containsTerm(title, t)).length;
    if (hits >= 2) titleScore = 6;
    else if (hits === 1) titleScore = 3;
    if (titleScore > 0) reasons.push("Similar to roles on your resume");
  }

  const jobSkills = Array.isArray(job.skills) ? job.skills.filter((s: unknown) => typeof s === "string").join(" | ") : "";
  const description = typeof job.description === "string" ? job.description.slice(0, RESUME_DESCRIPTION_SCAN_CHARS) : "";
  const haystack = `${title} | ${jobSkills} | ${description}`.toLowerCase();
  const matched: string[] = [];
  for (const s of (resume!.skills || []).slice(0, 40)) {
    if (typeof s === "string" && containsTerm(haystack, s)) matched.push(s);
  }
  const skillScore = Math.min(RESUME_SKILL_MAX, matched.length * 2);
  if (matched.length > 0) reasons.push(`Matches your resume skills: ${matched.slice(0, 3).join(", ")}`);

  return { score: Math.min(RESUME_TITLE_MAX + RESUME_SKILL_MAX, titleScore + skillScore), reasons };
}

// =============================================================================
// RELEVANCE GATE
// A job is only recommended when its title or field overlaps the user's target role, field or
// skills, whatever its numeric score (location/seniority/recency alone never qualify a job).
// =============================================================================

/** Title keywords per field. Used to classify job titles and user roles, and as SQL pre-filter terms. */
export const FIELD_TITLE_KEYWORDS: Record<string, string[]> = {
  engineering: [
    "software", "developer", "backend", "back-end", "back end", "frontend", "front-end", "front end",
    "full stack", "full-stack", "fullstack", "programmer", "sde", "swe", "devops", "sre", "site reliability",
    "platform engineer", "infrastructure engineer", "cloud engineer", "mobile engineer", "ios", "android",
    "qa engineer", "sdet", "test engineer", "automation engineer", "web developer", "firmware", "embedded",
    "security engineer", "application engineer", "software architect",
    "engineering manager", "member of technical staff",
  ],
  data: [
    "data scientist", "data analyst", "data engineer", "analytics", "business intelligence", "bi analyst",
    "bi developer", "machine learning", "ml engineer", "ai engineer", "data science", "statistician",
  ],
  design: ["designer", "ux", "user experience", "product design", "graphic design", "visual design", "interaction design"],
  product: ["product manager", "product owner", "product lead", "program manager", "project manager", "technical program"],
  marketing: [
    "marketing", "marketer", "growth", "seo", "sem", "content", "brand", "social media", "communications", "copywriter",
    "demand generation", "campaign", "public relations", "community manager",
  ],
  sales: ["sales", "account executive", "business development", "sdr", "bdr", "account manager", "partnerships"],
  // Role nouns only: "financial" / "finance" alone are domain words ("Account Executive - Financial Services")
  finance: [
    "financial analyst", "finance analyst", "finance manager", "finance director", "head of finance", "finance business partner",
    "strategic finance", "financial planning", "financial controller", "financial reporting", "corporate finance",
    "accountant", "accounting", "controller", "fp&a", "auditor", "audit", "tax", "treasury", "bookkeeper", "payroll",
    "credit analyst", "risk analyst", "investment analyst", "actuary", "actuarial", "accounts payable", "accounts receivable", "cfo",
  ],
  legal: ["legal", "counsel", "attorney", "lawyer", "paralegal", "compliance", "contracts", "solicitor"],
  hr: ["recruiter", "recruiting", "talent acquisition", "human resources", "hr", "people operations", "people partner", "hrbp"],
  operations: ["operations", "logistics", "supply chain", "procurement"],
  support: ["customer support", "customer success", "support specialist", "help desk", "helpdesk", "technical support", "customer service", "support engineer"],
  healthcare: ["nurse", "clinical", "physician", "medical", "healthcare", "pharmacist", "therapist"],
  admin: ["executive assistant", "administrative assistant", "personal assistant", "receptionist", "office manager", "office coordinator"],
};

/**
 * Role nouns that decide the field on their own, whatever domain words follow: "Account Executive -
 * Financial Services" is a sales role, "Executive Assistant, Marketing" an admin role.
 */
const EXCLUSIVE_FIELD_KEYWORDS: Record<string, string[]> = {
  admin: FIELD_TITLE_KEYWORDS.admin,
  sales: [
    "account executive", "sales development", "business development", "sdr", "bdr", "account manager", "sales representative",
    "presales", "pre-sales", "sales engineer", "solution engineer", "solutions engineer",
  ],
  hr: ["recruiter", "talent acquisition"],
  engineering: [
    "software engineer", "software developer", "software development engineer", "backend engineer", "back-end engineer",
    "frontend engineer", "front-end engineer", "full stack engineer", "full-stack engineer", "fullstack engineer",
    "forward deployed engineer", "devops engineer", "site reliability engineer", "platform engineer", "growth engineer",
  ],
};

/** jobs.category slug -> field. "engineering" is the ingest default for many non-tech roles, so it is never trusted alone. */
const CATEGORY_FIELD: Record<string, string> = {
  software: "engineering", devops: "engineering", "qa-testing": "engineering", "cyber-security": "engineering",
  ai: "data", "ai-ml": "data", data: "data", "data-analytics": "data", "data-science": "data",
  design: "design", product: "product", marketing: "marketing", sales: "sales", finance: "finance",
  legal: "legal", hr: "hr", operations: "operations", "customer-support": "support", healthcare: "healthcare",
};
const UNTRUSTED_JOB_CATEGORIES = new Set(["engineering"]);
const GENERIC_ENGINEERING_TITLE = /\b(engineer|engineering|developer|programmer|technical)\b/i;

/** Words that say nothing about the field (seniority, generic job nouns). Never enough to pass the gate. */
const GATE_GENERIC_TOKENS = new Set([
  "and", "or", "the", "for", "with", "in", "at", "of", "to", "developer", "engineer", "specialist", "manager",
  "senior", "sr", "junior", "jr", "lead", "staff", "principal", "head", "director", "chief", "vp", "intern",
  "internship", "associate", "analyst", "consultant", "coordinator", "officer", "executive", "representative",
  "assistant", "administrator", "remote", "contract", "full", "time", "part", "level", "entry", "mid",
]);

const MAX_PROFILE_SKILLS = 40;
const MAX_PREFILTER_SKILLS = 15;

/** Fields a title (or a role the user typed) belongs to, from FIELD_TITLE_KEYWORDS. */
export function fieldsForTitle(text?: string | null): Set<string> {
  const t = (text || "").toLowerCase();
  const out = new Set<string>();
  if (!t) return out;
  for (const [field, keywords] of Object.entries(EXCLUSIVE_FIELD_KEYWORDS)) {
    if (keywords.some((k) => containsTerm(t, k))) return new Set([field]);
  }
  for (const [field, keywords] of Object.entries(FIELD_TITLE_KEYWORDS)) {
    if (keywords.some((k) => containsTerm(t, k))) out.add(field);
  }
  return out;
}

function fieldForCategory(category?: string | null): string | null {
  const c = (category || "").toLowerCase().trim();
  if (!c) return null;
  return CATEGORY_FIELD[c] ?? (FIELD_TITLE_KEYWORDS[c] ? c : null);
}

interface RelevanceProfile {
  roleTexts: string[];
  roleTokens: string[];
  fields: Set<string>;
  skills: string[];
}

/** What the gate compares a job against: target roles, resume titles/roles, user fields, resume skills. */
function relevanceProfile(answers?: OnboardingAnswers | null): RelevanceProfile | null {
  if (!answers) return null;
  const clean = (a?: (string | null | undefined)[] | null) =>
    (Array.isArray(a) ? a : []).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
  const roleTexts = [
    ...clean(answers.roles),
    ...clean(answers.resumeProfile?.preferredRoles).map((s) => s.slice(0, 80)),
    ...clean(answers.resumeProfile?.jobTitles),
  ].slice(0, 20);
  const fields = new Set<string>();
  for (const r of roleTexts) fieldsForTitle(r).forEach((f) => fields.add(f));
  for (const c of clean(answers.categories)) {
    const f = fieldForCategory(c);
    if (f) fields.add(f);
  }
  const skills = clean(answers.resumeProfile?.skills).filter((s) => s.length >= 3).slice(0, MAX_PROFILE_SKILLS);
  const roleTokens = extractRoleTokens(roleTexts).filter((t) => t.length >= 3 && !GATE_GENERIC_TOKENS.has(t));
  if (roleTokens.length === 0 && fields.size === 0 && skills.length === 0) return null;
  return { roleTexts, roleTokens, fields, skills };
}

/**
 * Relevance gate.
 * - User with a known field (from target roles, resume titles or categories): the job must be in one of those
 *   fields. The job's field comes from the role noun in its title ("Commercial Counsel" -> legal,
 *   "Account Executive - Financial Services" -> sales), or from its category when the title names no field
 *   ("engineering", the ingest default for many non-tech roles, is not trusted alone).
 * - User with no classifiable field: the title must share a distinctive role word or a resume skill.
 * Users with no role/field/skill signals have nothing to compare against, so the gate is open for them.
 */
export function isRelevantToProfile(job: JobScoringCandidate, answers?: OnboardingAnswers | null): boolean {
  const profile = relevanceProfile(answers);
  if (!profile) return true;
  const title = (job.title || "").toLowerCase();
  if (!title) return false;

  const sharesRoleWordOrSkill = () =>
    profile.roleTokens.some((t) => containsTerm(title, t)) || profile.skills.some((s) => containsTerm(title, s));

  if (profile.fields.size > 0) {
    // 1. The title's role noun decides when it names a field
    const titleFields = fieldsForTitle(title);
    if (titleFields.size > 0) return Array.from(titleFields).some((f) => profile.fields.has(f));

    // 2. Otherwise a trustworthy category decides
    const category = (job.category || "").toLowerCase().trim();
    const categoryField = UNTRUSTED_JOB_CATEGORIES.has(category) ? null : fieldForCategory(category);
    if (categoryField) return profile.fields.has(categoryField);

    // 3. "engineering" (the ingest default) only counts when the title itself says so ("Founding Engineer")
    if (UNTRUSTED_JOB_CATEGORIES.has(category) && profile.fields.has("engineering") && GENERIC_ENGINEERING_TITLE.test(title)) {
      return true;
    }
  }

  // 4. Nothing reliable in title or category: a distinctive shared role word or resume skill decides
  return sharesRoleWordOrSkill();
}

/**
 * SQL pre-filter for the candidate pool: a superset of the jobs the relevance gate can pass, so the
 * pool is "latest N relevant jobs" instead of "latest N jobs". Null when the gate is open (no signals).
 * Terms are plain words safe for PostgREST ilike (no %_(),"'`;\\$* characters).
 */
export function buildRelevancePrefilter(answers?: OnboardingAnswers | null): { orClause: string; terms: string[]; categories: string[] } | null {
  const profile = relevanceProfile(answers);
  if (!profile) return null;
  const safe = (s: string) => s.toLowerCase().replace(/[%_(),"'`;\\$*]/g, " ").replace(/\s+/g, " ").trim();
  // Superset of every way isRelevantToProfile can pass a job
  const terms = new Set<string>();
  for (const f of Array.from(profile.fields)) {
    for (const k of [...(FIELD_TITLE_KEYWORDS[f] || []), ...(EXCLUSIVE_FIELD_KEYWORDS[f] || [])]) terms.add(safe(k));
  }
  if (profile.fields.has("engineering")) ["engineer", "engineering", "developer", "programmer", "technical"].forEach((t) => terms.add(t));
  for (const t of profile.roleTokens) terms.add(safe(t));
  for (const s of profile.skills.slice(0, MAX_PREFILTER_SKILLS)) terms.add(safe(s));
  const termList = Array.from(terms).filter((t) => t.length >= 2);
  const categories = Object.entries(CATEGORY_FIELD)
    .filter(([, f]) => profile.fields.has(f))
    .map(([c]) => c)
    .concat(Array.from(profile.fields).filter((f) => !UNTRUSTED_JOB_CATEGORIES.has(f)));
  const uniqueCategories = Array.from(new Set(categories));
  const parts = termList.map((t) => `title.ilike.%${t}%`);
  if (uniqueCategories.length > 0) parts.push(`category.in.(${uniqueCategories.join(",")})`);
  return { orClause: parts.join(","), terms: termList, categories: uniqueCategories };
}

/**
 * Shared-scorer inputs for a user with a confirmed resume (CandidateProfile): saved preferences plus the
 * resume's titles, headline and skills. With no saved target roles, the most recent resume title is the role.
 */
export function answersFromCandidate(
  candidate: CandidateProfile | null | undefined,
  preferences?: Partial<OnboardingAnswers> | null
): OnboardingAnswers {
  const jobTitles = (candidate?.experience || [])
    .map((e) => (typeof e?.role === "string" ? e.role.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  const headline = typeof candidate?.headline === "string" ? candidate.headline.trim().slice(0, 80) : "";
  const savedRoles = (preferences?.roles || []).filter((r) => typeof r === "string" && r.trim());
  return {
    ...(preferences || {}),
    roles: savedRoles.length > 0 ? savedRoles : jobTitles.slice(0, 1),
    resumeProfile: {
      jobTitles,
      skills: Array.isArray(candidate?.skills) ? candidate!.skills.filter((s) => typeof s === "string") : [],
      preferredRoles: headline ? [headline] : [],
    },
  };
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
/** 0 = exclude (executive), 0.5 = strong down-weight (Staff/Principal), 1 = no change. Title is lowercased. */
export function seniorityFactorForMid(title: string): number {
  if (/\b(vp|svp|evp|vice president|director|head|chief)\b/.test(title)) return 0;
  // shortcut: "staff accountant/auditor" are entry/mid finance titles; extend this list if other fields misfire.
  if (/\bprincipal\b|\bstaff\b(?!\s+(accountant|auditor))/.test(title)) return 0.5;
  return 1;
}

/**
 * Card and detail show one stored score: the one the feed attached to this job, but only when the feed row and
 * this job carry the same server score-input revision. A different or missing revision means the inputs may have
 * changed, so the feed score is not adopted.
 */
export function withFeedScore<T extends { id: string; matchScore?: number | null; scoreRevision?: string | null }>(
  job: T,
  feed: readonly { id: string; matchScore?: number | null; scoreRevision?: string | null }[]
): T {
  const row = feed.find((j) => j.id === job.id);
  if (!row || typeof row.matchScore !== "number" || !row.scoreRevision || row.scoreRevision !== job.scoreRevision) return job;
  return row.matchScore !== job.matchScore ? { ...job, matchScore: row.matchScore } : job;
}

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

  // 1. Work model: a saved "remote" preference (onboarding "Open to Remote") is additive. Remote roles
  // are boosted below, but eligible preferred-location jobs stay. Only the explicit workModel feed filter
  // restricts to remote.
  const userRemote = (answers.remotePreference || "").toLowerCase().trim();

  // 2. Seniority Level Hard Filter:
  // An entry-level seeker must NEVER match Senior, Staff, Lead, Principal, Director, Manager roles
  const userExp = (answers.experienceLevel || "").toLowerCase().trim();
  const isLeadOrPrincipal = /\b(lead|staff|principal|head|director|architect|manager|vp|chief)\b/i.test(title);
  const isSenior = /\b(senior|sr\.?)\b/i.test(title);
  const isJuniorOrEntry = isEarlyCareerJob(job.title, job.job_type);

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
  // If the job explicitly offers maximum compensation below user minSalary requirement, disqualify
  if (typeof answers.minSalary === "number" && answers.minSalary > 0) {
    const rawMax =
      job.salary_max ??
      job.max_amount ??
      job.salaryMax ??
      job.salary_min ??
      job.min_amount ??
      job.salaryMin;
    if (typeof rawMax === "number" && rawMax > 0) {
      const rawPeriod = (job.salary_period || job.period || (job as any).salaryPeriod || "")
        .toString()
        .trim();
      const normalizedPeriod = rawPeriod ? detectPayPeriod(rawPeriod) : null;
      const isExplicitPeriod = Boolean(rawPeriod);

      let annualMax = rawMax;
      if (normalizedPeriod === "hourly") {
        annualMax = rawMax * 2080;
      } else if (normalizedPeriod === "monthly") {
        annualMax = rawMax * 12;
      } else if (normalizedPeriod === "yearly") {
        annualMax = rawMax;
      } else {
        // Never guess monthly when the period is explicit
        if (!isExplicitPeriod) {
          if (rawMax < 500) {
            annualMax = rawMax * 2080;
          } else if (rawMax < 25000) {
            annualMax = rawMax * 12;
          }
        }
      }

      // Currency comparison:
      // Compare user's salaryCurrency with job currency.
      // Skip the salary filter for a job whose currency can't be compared (don't silently compare across currencies).
      const userCurrency = (answers.salaryCurrency || "USD").toString().toUpperCase().trim();
      let jobCurrency = (
        job.currency ||
        job.salary_currency ||
        (job as any).salaryCurrency ||
        ""
      ).toString().toUpperCase().trim();

      if (!jobCurrency && typeof job.salary_text === "string" && job.salary_text.trim()) {
        const parsed = parseSalary(job.salary_text, {
          location: job.location || undefined,
          countryCode: job.country_code || undefined,
          isExplicitSalaryField: true,
        });
        if (parsed.currency) {
          jobCurrency = parsed.currency.toUpperCase().trim();
        }
      }

      // If job currency is unknown:
      // If user specified a non-USD currency, we cannot compare -> skip filter.
      // If user is USD, default unknown job currency to USD (platform standard).
      if (!jobCurrency) {
        if (answers.salaryCurrency && answers.salaryCurrency.toUpperCase().trim() !== "USD") {
          jobCurrency = "";
        } else {
          jobCurrency = "USD";
        }
      }

      if (jobCurrency) {
        let comparableAnnualMax: number | null = null;
        if (jobCurrency === userCurrency) {
          comparableAnnualMax = annualMax;
        } else {
          comparableAnnualMax = convertCurrency(annualMax, jobCurrency, userCurrency);
        }

        // If currency can be compared and compensation is strictly below minimum requirement, disqualify
        // No 80% tolerance: minimum means minimum
        if (comparableAnnualMax !== null && comparableAnnualMax < answers.minSalary) {
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
  }

  // 5. Relevance gate: no overlap with the user's target role, field or skills means not recommended,
  // however well location, seniority or recency score.
  if (!isRelevantToProfile(job, answers)) {
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
      reasons: ["Not relevant: no overlap with your target role, field or skills"],
    };
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

  // 6. RESUME / LINKEDIN PDF BOOST (0 - 15 pts, only when a parsed profile exists)
  const resume = scoreResumeMatch(job, answers.resumeProfile);
  reasons.push(...resume.reasons);

  // Seniority factor: the 100 cap swallows the small experience penalty, so titles far above a mid
  // seeker are scaled after the cap (entry seekers are already hard-filtered above).
  const seniorityFactor = userExp === "mid" ? seniorityFactorForMid(title) : 1;
  if (seniorityFactor < 1) reasons.push("Seniority well above preferred level");
  const totalScore =
    Math.min(100, roleScore + locationScore + experienceScore + jobTypeScore + recencyScore + resume.score) * seniorityFactor;

  return {
    job,
    score: totalScore,
    breakdown: {
      roleScore,
      locationScore,
      experienceScore,
      jobTypeScore,
      recencyScore,
      ...(hasResumeSignals(answers.resumeProfile) ? { resumeScore: resume.score } : {}),
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

  // Fallback when a user has no answers: return all jobs, optionally boosted by resume
  if (!hasOnboardingAnswers(answers)) {
    const hasResume = hasResumeSignals(answers?.resumeProfile);
    if (!hasResume) {
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

    // With resume but no other onboarding answers: every job relevant to the resume stays eligible
    // (relevance gate only); resume match provides a soft score boost for ranking order.
    const scored = jobs.filter((job) => isRelevantToProfile(job, answers)).map((job) => {
      const resume = scoreResumeMatch(job, answers!.resumeProfile);
      return { job, score: resume.score };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const timeA = new Date(a.job.posted_at || a.job.created_at || a.job.first_seen_at || 0).getTime();
      const timeB = new Date(b.job.posted_at || b.job.created_at || b.job.first_seen_at || 0).getTime();
      if (timeB !== timeA) return timeB - timeA;
      const idA = String(a.job.id ?? "");
      const idB = String(b.job.id ?? "");
      return idB.localeCompare(idA);
    });

    return scored.map((s) => ({
      ...s.job,
      _matchScore: s.score,
      matchScore: s.score,
    }));
  }

  const userRemote = (answers!.remotePreference || "").toLowerCase().trim();
  const userExp = (answers!.experienceLevel || "").toLowerCase().trim();
  const userLocations = [
    ...(answers!.locations || []),
    ...(answers!.country ? [answers!.country] : []),
    ...(answers!.countryCode ? [answers!.countryCode] : []),
  ].filter((l): l is string => Boolean(l && l.trim().length > 0));

  // Determine eligibility solely from base onboarding answers (resume is a soft score boost only)
  const baseAnswers: OnboardingAnswers = { ...answers!, resumeProfile: undefined };

  const qualifyingScored = jobs
    .map((job) => ({
      job,
      base: scoreJobRecommendation(job, baseAnswers),
      full: scoreJobRecommendation(job, answers!),
    }))
    .filter(({ job, base, full }) => {
      // Must have positive score from base onboarding answers (resume never qualifies on its own)
      if (base.score <= 0) return false;
      // The relevance gate also counts resume titles/skills, so it is checked on the full answers
      if (full.score <= 0) return false;

      const title = (job.title || "").toLowerCase();
      const location = (job.location || "").toLowerCase();
      const isRemote =
        job.remote === true ||
        (job.remote_scope || "").toLowerCase() === "remote" ||
        (job.remote_scope || "").toLowerCase() === "worldwide" ||
        (job.remoteScope || "").toLowerCase() === "remote" ||
        (job.remoteScope || "").toLowerCase() === "worldwide" ||
        location.includes("remote");

      // 1. Work model: "remote" is additive (see scoreJobRecommendation); only "onsite" (not open to remote) excludes.
      if (userRemote === "onsite" && isRemote) {
        return false;
      }

      // 2. Experience hard preference
      const isSeniorOrLead = /\b(lead|staff|principal|head|director|architect|manager|vp|chief|senior|sr\.?)\b/i.test(title);
      const isJuniorOrEntry = isEarlyCareerJob(job.title, job.job_type);
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
    })
    .map(({ full }) => full);

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
