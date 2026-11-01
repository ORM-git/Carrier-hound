import { createClient } from "../supabase/client";
import { CandidateProfile } from "../resume/types";
import { computeFitDiagnostics, FitDiagnosticsResult } from "../matcher/scoring";
import { formatSalary } from "@/lib/salary/parser";
import type { UserPreferences } from "@/lib/auth/types";
import { sanitizeExternalUrl, stripHtmlAndExecutableMarkup } from "@/lib/security/xss";
import { COUNTRY_CODE_TO_NAME, getCountryFilterClause } from "@/lib/countries";
import { decodeCursor, encodeCursor } from "@/lib/pagination/cursor";

export interface LiveJob {
  id: string;
  isExpired?: boolean;
  status?: string;
  title: string;
  company: string;
  location: string;
  date: string;
  salary: string;
  category: string;
  remote: boolean;
  remoteScope?: string;
  remoteEligibility?: string;
  country: string;
  type: string;
  directSource: boolean;
  applyUrl: string;
  description?: string;
  skills?: string[];
  postedAt?: string;
  trackerNotes?: string;
  proUnlockError?: ProUnlockError;
  applicantCount?: number;
  company_id?: string | null;
  companyId?: string | null;
  logoUrl?: string | null;
  logo_url?: string | null;
  salary_display?: string | null;
  salary_original?: string | null;
}

export interface ProUnlockError {
  status?: number;
  message?: string;
  isNetworkError?: boolean;
}

export interface GetJobsOptions {
  page?: number;
  pageSize?: number;
  category?: string;
  search?: string;
  remoteOnly?: boolean;
  isPro?: boolean;
  sortBy?: "newest" | "match";
  candidate?: CandidateProfile | null;
  preferences?: UserPreferences | null;
  location?: string;
  level?: string;
  jobType?: string;
  workModel?: string;
  datePosted?: string;
  countryCode?: string;
  experience?: string;
  salaryMin?: number | string | null;
  sourceType?: string | null;
  company?: string | null;
  cursor?: string | null;
  eligibility?: "on" | "off" | string;
  currency?: string;
}

export interface GetJobsResult {
  jobs: LiveJob[];
  totalCount: number;
  nextCursor?: string | null;
  hasNextPage?: boolean;
  isDegraded?: boolean;
  error?: string | null;
  appliedEligibility?: { countries: string[]; filteredOut: number } | null;
}

/**
 * Accurately determines remote eligibility scope without false Worldwide assumptions.
 */
export function getJobRemoteEligibility(job: {
  remote?: boolean;
  remoteScope?: string;
  remoteEligibility?: string;
  remote_scope?: string;
  remote_eligibility?: string;
  location?: string;
}): "worldwide" | "country_restricted" | "unknown" | "onsite" {
  const loc = (job.location || "").toLowerCase();
  const scope = (job.remoteScope || job.remote_scope || "").toLowerCase();
  const elig = (job.remoteEligibility || job.remote_eligibility || "").toLowerCase();

  if (elig === "worldwide" || scope === "worldwide") return "worldwide";
  if (elig === "country_restricted" || scope === "country_restricted") return "country_restricted";

  if (!job.remote && !loc.includes("remote")) return "onsite";

  // Check if location has explicit country/city restriction
  if (
    /\b(united states|u\.s\.|usa|remote - us|remote \(us\)|remote, us|uk|canada|india|germany|france|europe|emea|apac)\b/i.test(
      loc
    )
  ) {
    return "country_restricted";
  }

  // Check if location explicitly confirms global worldwide eligibility
  if (/\b(worldwide|anywhere|global|work from anywhere|all timezones)\b/i.test(loc)) {
    return "worldwide";
  }

  // If remote is true but no geography is specified
  if (job.remote) {
    return "unknown";
  }

  return "unknown";
}


/**
 * Calculates the post age in hours from an ISO string, relative string, or date string.
 */
export function getJobAgeInHours(dateStr?: string): number | null {
  if (!dateStr) return null;
  const s = dateStr.trim().toLowerCase();
  if (s === "just now" || s.includes("minute") || s.includes("sec")) {
    return 0.1;
  }
  const hourMatch = s.match(/^(\d+)\s*(?:h|hour|hours)(?:\s*ago)?$/);
  if (hourMatch) {
    return parseInt(hourMatch[1], 10);
  }
  const dayMatch = s.match(/^(\d+)\s*(?:d|day|days)(?:\s*ago)?$/);
  if (dayMatch) {
    return parseInt(dayMatch[1], 10) * 24;
  }
  const timestamp = Date.parse(dateStr);
  if (!isNaN(timestamp)) {
    const diffMs = Date.now() - timestamp;
    if (diffMs >= 0) {
      return diffMs / (1000 * 60 * 60);
    }
    return 0;
  }
  if (s === "today") {
    return 12;
  }
  return null;
}

/**
 * Evaluates whether a job qualifies for the "Early applicant" badge.
 * Criteria:
 * - When applicant count is known: posted within the last 24 hours AND applicant count is low (<= 25).
 * - When no applicant-count data exists: posted under 6 hours old.
 */
export function isEarlyApplicant(job: {
  postedAt?: string;
  date?: string;
  applicantCount?: number | null;
  applicant_count?: number | null;
  applicantsCount?: number | null;
  applicants_count?: number | null;
  applicants?: number | null;
  [key: string]: any;
}): boolean {
  if (!job) return false;
  const dateStr = job.postedAt || job.date;
  const ageHours = getJobAgeInHours(dateStr);
  if (ageHours === null || ageHours < 0) return false;

  const rawCount =
    job.applicantCount ??
    job.applicant_count ??
    job.applicantsCount ??
    job.applicants_count ??
    job.applicants;

  const hasApplicantData =
    rawCount !== undefined && rawCount !== null && (rawCount as any) !== "";

  if (hasApplicantData) {
    const num = typeof rawCount === "number" ? rawCount : parseInt(String(rawCount), 10);
    const isLow = !isNaN(num)
      ? num <= 25 && num >= 0
      : String(rawCount).toLowerCase() === "low" || String(rawCount).toLowerCase() === "few";

    return ageHours < 24 && isLow;
  }

  // If no applicant-count data exists, show it only for posts under 6 hours old
  return ageHours < 6;
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return "Recently";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffHours = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "Recently";
  }
}

export function isGenuineInternshipJob(title: string, jobType?: string): boolean {
  if (!title) return false;
  const clean = title.replace(/\b(international|internal|internals)\b/gi, "");
  const internWordRegex = /\b(intern|interns|internship|internships|co-op|coop)\b/i;
  if (internWordRegex.test(clean)) return true;
  if (jobType?.toLowerCase() === "internship") {
    const isSeniorOrNonIntern = /\b(senior|sr\b|principal|lead|staff|director|vp|head|manager|analyst|international|internal|internals)\b/i.test(title);
    return !isSeniorOrNonIntern;
  }
  return false;
}

const GENERIC_JOB_STOPWORDS = new Set([
  "engineer", "developer", "specialist", "manager", "lead", "senior", "junior",
  "associate", "staff", "principal", "intern", "consultant", "director", "head",
  "and", "the", "for", "with", "experienced", "entry", "level", "full", "stack",
  "tech", "general", "global", "member", "officer", "team"
]);

export function extractCandidateRelevanceTerms(
  candidate?: CandidateProfile | null,
  preferences?: UserPreferences | null
): string[] {
  const terms = new Set<string>();

  const rawRoles: string[] = [
    ...(preferences?.roles || []),
  ];
  if (candidate?.headline) rawRoles.push(candidate.headline);
  if (candidate?.experience && candidate.experience.length > 0) {
    candidate.experience.forEach((e) => {
      if (e.role) rawRoles.push(e.role);
    });
  }

  for (const r of rawRoles) {
    if (!r || typeof r !== "string") continue;
    const clean = r.replace(/[\(\)\[\],\-\/]/g, " ").trim();
    if (clean.length >= 4) {
      terms.add(clean);
    }
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      for (let i = 0; i < words.length - 1; i++) {
        const pair = `${words[i]} ${words[i + 1]}`;
        const lowerPair = pair.toLowerCase();
        if (!lowerPair.includes("senior") && !lowerPair.includes("junior")) {
          terms.add(pair);
        }
      }
    }
    words.forEach((w) => {
      const lower = w.toLowerCase().trim();
      if (lower.length >= 3 && !GENERIC_JOB_STOPWORDS.has(lower)) {
        terms.add(w);
      }
    });
  }

  const rawSkills: string[] = [
    ...(candidate?.skills || []),
  ];
  for (const sk of rawSkills) {
    if (!sk || typeof sk !== "string") continue;
    const lower = sk.toLowerCase().trim();
    if (lower.length >= 3 && !["css", "html", "git"].includes(lower)) {
      terms.add(sk.trim());
    }
  }

  return Array.from(terms)
    .map((t) => t.replace(/[%_,()]/g, "").trim())
    .filter((t) => t.length >= 3)
    .slice(0, 10);
}

const PUBLIC_SELECT_COLUMNS =
  "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at";

import { capJobsPerCompany } from "./capping";
export { capJobsPerCompany };

const DEGRADED_JOBS_RESULT: GetJobsResult = {
  jobs: [],
  totalCount: 0,
  nextCursor: null,
  hasNextPage: false,
  isDegraded: true,
  error: "degraded",
};

/**
 * Fetches live active jobs from Supabase with strict server/payload-level Pro gating.
 * When isPro is false, gated fields (company, salary, apply_url, description, skills)
 * are NEVER queried or included in the network response.
 * When sortBy is "match", computes fit across the full corpus on the server/DB.
 */
export async function getLiveJobs(options: GetJobsOptions = {}): Promise<GetJobsResult> {
  const isLegacyBehavior =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_JOBS_SERVICE === "true";
  const {
    page = 1,
    pageSize = 25,
    category,
    search,
    remoteOnly,
    isPro = false,
    sortBy = "newest",
    candidate,
    preferences,
    location,
    level,
    jobType,
    workModel,
    datePosted,
    countryCode,
    experience,
    salaryMin,
    sourceType,
    company,
    cursor,
  } = options;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const isMatchSort = sortBy === "match";
  const relevanceTerms = isMatchSort
    ? extractCandidateRelevanceTerms(candidate, preferences)
    : [];

  // 1. Route text search and default list through safe server endpoint so company capping can use service-key company_id
  // without exposing raw database tables or leaking paid fields to guests
  const hasServerFilter = Boolean((search && search.trim()) || (company && company.trim()) || salaryMin || (sourceType && sourceType !== "all") || cursor);
  const shouldUseServer = typeof window !== "undefined" && (hasServerFilter || !candidate || relevanceTerms.length === 0);
  if (shouldUseServer) {
    try {
      let token: string | undefined;
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        token = session?.access_token;
      } catch {
        // Unauthenticated guest or testing environment
      }
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const params = new URLSearchParams({
        q: (search || '').trim(),
        page: String(page),
        pageSize: String(pageSize),
      });
      if (category && category !== "all") params.set("category", category);
      if (remoteOnly) params.set("remoteOnly", "true");
      if (location && location !== "all") params.set("location", location);
      if (level && level !== "all") params.set("level", level);
      if (jobType && jobType !== "all") params.set("jobType", jobType);
      if (workModel && workModel !== "all") params.set("workModel", workModel);
      if (datePosted && datePosted !== "all") params.set("datePosted", datePosted);
      if (countryCode && countryCode !== "all") params.set("country_code", countryCode);
      if (experience && experience !== "all" && experience !== "All Experience") params.set("experience", experience);
      if (salaryMin) params.set("salaryMin", String(salaryMin));
      if (sourceType && sourceType !== "all") params.set("sourceType", sourceType);
      if (company && company !== "all") params.set("company", company);
      if (cursor) params.set("cursor", cursor);
      if (sortBy) params.set("sortBy", sortBy);
      if (options.eligibility) params.set("eligibility", options.eligibility);
      if (options.currency) params.set("currency", options.currency);

      const res = await fetch(`/api/jobs/search?${params.toString()}`, { headers });
      if (res.status === 503) {
        const json = await res.json().catch(() => ({}));
        return {
          jobs: [],
          totalCount: 0,
          nextCursor: null,
          hasNextPage: false,
          isDegraded: true,
          error: "degraded",
        };
      }
      if (res.ok) {
        const json = await res.json();
        return {
          jobs: json.jobs || [],
          totalCount: json.totalCount ?? (json.jobs?.length || 0),
          nextCursor: json.nextCursor ?? null,
          hasNextPage: Boolean(json.hasNextPage),
          isDegraded: Boolean(json.degraded),
          appliedEligibility: json.appliedEligibility || null,
          ...(json.degraded ? { error: "degraded" } : {}),
        };
      } else {
        console.warn(`Server search responded with status ${res.status}, falling back to public preview query.`);
      }
    } catch (searchErr) {
      console.warn("Server search failed, falling back to public preview query:", searchErr);
    }
  }

  try {
    const supabase = createClient();
    const isMatchSort = sortBy === "match";
    const relevanceTerms = isMatchSort
      ? extractCandidateRelevanceTerms(candidate, preferences)
      : [];

    let query = supabase
      .from("jobs_public")
      .select(PUBLIC_SELECT_COLUMNS, { count: "exact" })
      .eq("is_active", true)
      .eq("status", "active");

    if (category && category !== "all") {
      const c = category.toLowerCase().trim();
      if (c === "trending") {
        query = query.in("category", ["ai", "engineering", "devops"]);
      } else if (c === "tech") {
        query = query.in("category", ["engineering", "devops", "ai", "software"]);
      } else if (c === "ai" || c === "ai-ml" || c === "ai-machine-learning" || c === "machine-learning") {
        query = query.or("category.eq.ai,category.eq.ai-ml,title.ilike.%machine learning%,title.ilike.%deep learning%,title.ilike.%llm%,title.ilike.%nlp%,title.imatch.\\yAI\\y,title.ilike.ai %,title.ilike.% ai %,title.ilike.% ai,title.ilike.ai");
      } else if (c === "data" || c === "data-analytics" || c === "data-science") {
        query = query.or("category.eq.data,category.eq.data-analytics,title.ilike.%data %,title.ilike.%analytics%,title.ilike.%database%");
      } else if (c === "engineering" || c === "software") {
        query = query.in("category", ["engineering", "software"]);
      } else if (c === "internships") {
        query = query.or("job_type.eq.internship,title.ilike.%internship%,title.ilike.%internships%,title.ilike.% intern %,title.ilike.intern %,title.ilike.% intern,title.ilike.%-intern%,title.ilike.%(intern)%,title.ilike.%co-op%,title.ilike.%coop%");
      } else if (c === "remote") {
        query = query.eq("remote", true);
      } else if (c === "fresher") {
        query = query.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%,title.ilike.%internship%,title.ilike.% intern %,job_type.eq.internship");
      } else if (c === "operations") {
        query = query.or("category.eq.operations,title.ilike.%operation%,title.ilike.%ops%");
      } else if (c === "cyber-security") {
        query = query.or("category.eq.cyber-security,title.ilike.%security%,title.ilike.%cyber%");
      } else if (c === "customer-support") {
        query = query.or("category.eq.customer-support,title.ilike.%support%,title.ilike.%customer%,title.ilike.%success%");
      } else if (c === "legal") {
        query = query.or("category.eq.legal,title.ilike.%legal%,title.ilike.%compliance%");
      } else if (c === "healthcare") {
        query = query.or("category.eq.healthcare,title.ilike.%health%,title.ilike.%clinical%");
      } else {
        query = query.or(`category.ilike.%${c}%,title.ilike.%${c}%`);
      }
    }

    if (remoteOnly) {
      query = query.eq("remote", true);
    }

    if (countryCode && countryCode.trim() && countryCode.toLowerCase() !== "all") {
      const code = countryCode.trim().replace(/[%_(),"'`;\\$*]/g, " ").toUpperCase().trim();
      if (code) {
        const orClause = getCountryFilterClause(code);
        if (orClause) {
          query = query.or(orClause);
        } else {
          query = query.eq("country_code", code);
        }
      }
    }

    if (location && location.trim() && location.toLowerCase() !== "all") {
      const loc = location.trim().replace(/[%_(),\"'`;\\$*]/g, " ").trim();
      if (loc.toLowerCase() === "remote") {
        query = query.or("remote.eq.true,location.ilike.%remote%");
      } else if (loc) {
        query = query.ilike("location", "%" + loc + "%");
      }
    }

    if (jobType && jobType.trim() && jobType.toLowerCase() !== "all") {
      const jt = jobType.trim().toLowerCase();
      if (jt.includes("full")) {
        query = query.or("job_type.ilike.%full%,job_type.eq.full-time,job_type.eq.full_time");
      } else if (jt.includes("contract")) {
        query = query.or("job_type.ilike.%contract%,job_type.eq.contractor");
      } else if (jt.includes("part")) {
        query = query.ilike("job_type", "%part%");
      } else if (jt.includes("intern")) {
        query = query.or("job_type.ilike.%intern%,job_type.eq.internship");
      } else {
        query = query.ilike("job_type", "%" + jt + "%");
      }
    }

    if (level && level.trim() && level.toLowerCase() !== "all") {
      const lvl = level.trim().toLowerCase();
      if (lvl.includes("lead") || lvl.includes("staff")) {
        query = query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
      } else if (lvl.includes("senior")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      } else if (lvl.includes("entry") || lvl.includes("junior")) {
        query = query.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%");
      } else if (lvl.includes("mid")) {
        query = query
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%")
          .not("title", "ilike", "%junior%")
          .not("title", "ilike", "%entry%");
      }
    }

    if (experience && experience.trim() && experience.toLowerCase() !== "all" && experience.toLowerCase() !== "all experience") {
      const exp = experience.trim().toLowerCase();
      if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) {
        query = query.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
      } else if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) {
        query = query
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%")
          .not("title", "ilike", "%junior%")
          .not("title", "ilike", "%entry%");
      } else if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
        query = query
          .or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%")
          .not("title", "ilike", "%senior%")
          .not("title", "ilike", "%sr.%")
          .not("title", "ilike", "%staff%")
          .not("title", "ilike", "%principal%")
          .not("title", "ilike", "%lead%");
      } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
        query = query.or("title.ilike.%senior%,title.ilike.%sr.%");
      }
    }

    if (workModel && workModel.trim() && workModel.toLowerCase() !== "all") {
      const wmTokens = workModel.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const orParts: string[] = [];
      for (const wm of wmTokens) {
        if (wm === "remote") orParts.push("remote.eq.true", "location.ilike.%remote%");
        else if (wm === "hybrid") orParts.push("location.ilike.%hybrid%", "remote_scope.eq.hybrid");
        else if (wm === "onsite") orParts.push("remote.eq.false", "location.ilike.%onsite%");
      }
      if (orParts.length > 0) {
        query = query.or(orParts.join(","));
      }
    }

    if (datePosted && datePosted.trim() && datePosted.toLowerCase() !== "all") {
      const dp = datePosted.trim().toLowerCase();
      const ms =
        dp === "24h" || dp.includes("24")
          ? 24 * 60 * 60 * 1000
          : dp === "7d" || dp.includes("week")
          ? 7 * 24 * 60 * 60 * 1000
          : dp === "30d" || dp.includes("month")
          ? 30 * 24 * 60 * 60 * 1000
          : 0;
      if (ms > 0) {
        const cutoff = new Date(Date.now() - ms).toISOString();
        query = query.gte("posted_at", cutoff);
      }
    }

    // Note: company, salaryMin, and sourceType columns are not present in jobs_public view.
    // They are guarded here and safely resolved via server search (/api/jobs/search).

    if (search && search.trim()) {
      const q = search.trim().replace(/[%_(),"'`;\\$*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      const parts = q.split(" ").filter((p) => p.length >= 2);
      if (parts.length > 1) {
        for (const p of parts) {
          query = query.or(`title.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%`);
        }
      } else {
        query = query.or(`title.ilike.%${q}%,location.ilike.%${q}%,category.ilike.%${q}%`);
      }
    }

    let data: any[] | null = null;
    let count: number | null = null;

    if (isMatchSort && candidate && relevanceTerms.length > 0) {
      // 1. Corpus-wide matching for candidate profile
      const matchClause = relevanceTerms.map((t) => `title.ilike.%${t}%`).join(",");
      const matchQuery = query
        .or(matchClause)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(0, 249);

      const res = await matchQuery;
      if (res.error && !isLegacyBehavior) {
        return DEGRADED_JOBS_RESULT;
      }
      let candidatePool = res.data || [];
      count = res.count;

      if (candidatePool.length === 0 && preferences?.categories?.length) {
        let catQuery = supabase
          .from("jobs_public")
          .select(PUBLIC_SELECT_COLUMNS, { count: "exact" })
          .eq("is_active", true)
          .eq("status", "active")
          .in("category", preferences.categories);

        if (remoteOnly) {
          catQuery = catQuery.eq("remote", true);
        }
        if (countryCode && countryCode.trim() && countryCode.toLowerCase() !== "all") {
          const code = countryCode.trim().replace(/[%_(),"'`;\\$*]/g, " ").toUpperCase().trim();
          if (code) {
            const orClause = getCountryFilterClause(code);
            if (orClause) {
              catQuery = catQuery.or(orClause);
            } else {
              catQuery = catQuery.eq("country_code", code);
            }
          }
        }
        if (location && location.trim() && location.toLowerCase() !== "all") {
          const loc = location.trim().replace(/[%_(),\"'`;\\$*]/g, " ").trim();
          if (loc.toLowerCase() === "remote") {
            catQuery = catQuery.or("remote.eq.true,location.ilike.%remote%");
          } else if (loc) {
            catQuery = catQuery.ilike("location", "%" + loc + "%");
          }
        }
        if (jobType && jobType.trim() && jobType.toLowerCase() !== "all") {
          const jt = jobType.trim().toLowerCase();
          if (jt.includes("full")) {
            catQuery = catQuery.or("job_type.ilike.%full%,job_type.eq.full-time,job_type.eq.full_time");
          } else if (jt.includes("contract")) {
            catQuery = catQuery.or("job_type.ilike.%contract%,job_type.eq.contractor");
          } else if (jt.includes("part")) {
            catQuery = catQuery.ilike("job_type", "%part%");
          } else if (jt.includes("intern")) {
            catQuery = catQuery.or("job_type.ilike.%intern%,job_type.eq.internship");
          } else {
            catQuery = catQuery.ilike("job_type", "%" + jt + "%");
          }
        }
        if (level && level.trim() && level.toLowerCase() !== "all") {
          const lvl = level.trim().toLowerCase();
          if (lvl.includes("lead") || lvl.includes("staff")) {
            catQuery = catQuery.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
          } else if (lvl.includes("senior")) {
            catQuery = catQuery.or("title.ilike.%senior%,title.ilike.%sr.%");
          } else if (lvl.includes("entry") || lvl.includes("junior")) {
            catQuery = catQuery.or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%");
          } else if (lvl.includes("mid")) {
            catQuery = catQuery
              .not("title", "ilike", "%senior%")
              .not("title", "ilike", "%sr.%")
              .not("title", "ilike", "%staff%")
              .not("title", "ilike", "%principal%")
              .not("title", "ilike", "%lead%")
              .not("title", "ilike", "%junior%")
              .not("title", "ilike", "%entry%");
          }
        }

        if (experience && experience.trim() && experience.toLowerCase() !== "all" && experience.toLowerCase() !== "all experience") {
          const exp = experience.trim().toLowerCase();
          if (exp.includes("8") || exp.includes("lead") || exp.includes("staff") || exp.includes("principal")) {
            catQuery = catQuery.or("title.ilike.%staff%,title.ilike.%principal%,title.ilike.%lead%");
          } else if (exp.includes("3-5") || exp.includes("3 to 5") || exp.includes("mid")) {
            catQuery = catQuery
              .not("title", "ilike", "%senior%")
              .not("title", "ilike", "%sr.%")
              .not("title", "ilike", "%staff%")
              .not("title", "ilike", "%principal%")
              .not("title", "ilike", "%lead%")
              .not("title", "ilike", "%junior%")
              .not("title", "ilike", "%entry%");
          } else if (exp.includes("1-3") || exp.includes("1 to 3") || exp.includes("entry") || exp.includes("junior") || exp.includes("intern")) {
            catQuery = catQuery
              .or("title.ilike.%junior%,title.ilike.%entry%,title.ilike.%associate%")
              .not("title", "ilike", "%senior%")
              .not("title", "ilike", "%sr.%")
              .not("title", "ilike", "%staff%")
              .not("title", "ilike", "%principal%")
              .not("title", "ilike", "%lead%");
          } else if (exp.includes("5") || exp.includes("senior") || exp.includes("sr")) {
            catQuery = catQuery.or("title.ilike.%senior%,title.ilike.%sr.%");
          }
        }

        catQuery = catQuery
          .order("posted_at", { ascending: false, nullsFirst: false })
          .range(0, 249);
        const catRes = await catQuery;
        if (catRes.error && !isLegacyBehavior) {
          return DEGRADED_JOBS_RESULT;
        }
        candidatePool = catRes.data || [];
        count = catRes.count;
      }

      if (candidatePool.length === 0) {
        const fallbackRes = await query
          .order("posted_at", { ascending: false, nullsFirst: false })
          .range(from, to);
        if (fallbackRes.error && !isLegacyBehavior) {
          return DEGRADED_JOBS_RESULT;
        }
        data = fallbackRes.data;
        count = fallbackRes.count;
      } else {
        // Score each candidate against the candidate profile using unified attributes
        const scoredPool: { row: any; score: number }[] = candidatePool.map((row: any) => {
          const teaserJob = {
            id: row.id,
            title: row.title || "Untitled Position",
            company: "Verified Employer",
            location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
            category: row.category,
            remote_scope: row.remote_scope || (row.remote ? "worldwide" : undefined),
            skills: row.skills,
            description: row.description,
          };
          const diagnostics = computeFitDiagnostics(candidate, teaserJob);
          return { row, score: diagnostics.score };
        });

        // Sort by match score descending, then recency descending
        scoredPool.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const timeA = new Date(a.row.posted_at || a.row.created_at || 0).getTime();
          const timeB = new Date(b.row.posted_at || b.row.created_at || 0).getTime();
          return timeB - timeA;
        });

        // Cap jobs per company: max 3 per company in visible top-30
        const cappedPool = capJobsPerCompany(scoredPool.map((item) => item.row), 3, 30);
        data = cappedPool.slice(from, to + 1);
      }
    } else if (isMatchSort && (!candidate || relevanceTerms.length === 0)) {
      // Guest or profile without confirmed resume: sensible global relevance (verified roles first, then newest)
      const res = await query
        .order("verified", { ascending: false })
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(from, to);
      if (res.error && !isLegacyBehavior) {
        return DEGRADED_JOBS_RESULT;
      }
      data = capJobsPerCompany(res.data || [], 3, 30);
      count = res.count;
    } else {
      // Default newest first
      const res = await query
        .order("posted_at", { ascending: false, nullsFirst: false })
        .range(from, to);
      if (res.error && !isLegacyBehavior) {
        return DEGRADED_JOBS_RESULT;
      }
      data = res.data;
      count = res.count;
    }

    if (!data && !isLegacyBehavior) {
      return DEGRADED_JOBS_RESULT;
    }

    if (data) {
      if (data.length === 0) {
        return {
          jobs: [],
          totalCount: count ?? 0,
        };
      }
      const mappedJobs: LiveJob[] = data.map((row: any) => {
        const resolvedLogo = (isPro && row.company && row.company !== "Verified Employer")
          ? (row.logo_url || row.logoUrl || row.companies?.logo_url || null)
          : null;
        return {
          id: row.id,
          title: row.title || "Untitled Position",
          company: (isPro && row.company && row.company !== "Verified Employer")
            ? row.company
            : "Verified Employer",
          companyId: row.company_id || row.companyId || null,
          company_id: row.company_id || row.companyId || null,
          location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
          date: formatDate(row.posted_at || row.created_at),
          salary: "",
          category: row.category || "engineering",
          remote: Boolean(row.remote),
          remoteScope: row.remote_scope || undefined,
          remoteEligibility: row.remote_eligibility || undefined,
          country: row.country_code || row.country || "",
          type: row.job_type === "internship" ? "Internship" : "Full-time",
          directSource: Boolean(row.verified),
          applyUrl: "",
          description: "",
          skills: [],
          postedAt: row.posted_at || row.created_at,
          logoUrl: resolvedLogo,
          logo_url: resolvedLogo,
        };
      });

      // If user is verified as Pro on the client, fetch unlocked details from server endpoint
      if (isPro && mappedJobs.length > 0) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;
          if (token) {
            let proRes: Response | null = null;
            try {
              proRes = await fetch("/api/jobs/pro", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ ids: mappedJobs.map((j) => j.id) }),
              });
            } catch (netErr: any) {
              console.error(`[API /jobs/pro error]: Network failure during batch Pro unlock (${netErr?.message || "fetch failed"})`);
              mappedJobs.forEach((j) => {
                j.proUnlockError = { isNetworkError: true, message: "Network connection error while unlocking Pro job details." };
              });
            }

            if (proRes) {
              if (proRes.ok) {
                const proData = await proRes.json();
                if (Array.isArray(proData.jobs)) {
                  const unlockedMap = new Map<string, any>(
                    proData.jobs.map((pj: any) => [pj.id, pj])
                  );
                  mappedJobs.forEach((job) => {
                    const u = unlockedMap.get(job.id);
                    if (u) {
                      if (u.company) job.company = stripHtmlAndExecutableMarkup(u.company);
                      if (u.salary_text || u.salary_min != null) {
                        job.salary = stripHtmlAndExecutableMarkup(u.salary_display || formatSalary(u.salary_min, u.salary_max, u.currency, u.salary_period) || u.salary_text || "");
                        job.salary_display = u.salary_display || null;
                        job.salary_original = u.salary_original || null;
                      }
                      if (u.apply_url) job.applyUrl = sanitizeExternalUrl(u.apply_url) || "";
                      if (u.description) job.description = stripHtmlAndExecutableMarkup(u.description);
                      if (u.skills) job.skills = u.skills;
                      if (u.logo_url || u.logoUrl) {
                        job.logoUrl = u.logo_url || u.logoUrl;
                        job.logo_url = u.logo_url || u.logoUrl;
                      }
                    }
                  });
                }
              } else {
                console.error(`[API /jobs/pro error]: Pro batch unlock failed with status ${proRes.status}`);
                if (proRes.status === 401) {
                  // Only redirect if getSession shows no session (prevents redirect loop)
                  const { data: { session: currentSession } } = await supabase.auth.getSession();
                  if (!currentSession && typeof window !== "undefined") {
                    const returnTo = window.location.pathname + window.location.search;
                    window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
                  }
                }
                mappedJobs.forEach((j) => {
                  j.proUnlockError = {
                    status: proRes.status,
                    message: `Pro unlock request failed with status ${proRes.status}`,
                  };
                });
              }
            }
          }
        } catch (proErr: any) {
          console.error(`[API /jobs/pro error]: Unexpected batch Pro unlock error (${proErr?.message || "error"})`);
        }
      }

      const isInternCat = category && category.toLowerCase().trim() === "internships";
      const filteredJobs = isInternCat
        ? mappedJobs.filter((j) => isGenuineInternshipJob(j.title, j.type))
        : mappedJobs;

      return {
        jobs: filteredJobs,
        totalCount: count ?? 0,
      };
    }
  } catch (err) {
    console.warn("Supabase live jobs fetch error, falling back:", err);
    if (!isLegacyBehavior) {
      return DEGRADED_JOBS_RESULT;
    }
  }


  // Fallback: If database query or API fails, return the empty state (never fake or sample jobs)
  return {
    jobs: [],
    totalCount: 0,
  };
}

/**
 * Fetches single job detail by ID with strict server/payload-level Pro gating.
 */
export async function getLiveJobById(jobId: string, isPro: boolean = false): Promise<LiveJob | null> {
  if (!jobId || !jobId.trim()) return null;
  const cleanId = jobId.trim();

  let proUnlockError: ProUnlockError | undefined;

  // 1. If Pro user, fetch full unlocked job from authenticated server endpoint
  if (isPro) {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        let res: Response | null = null;
        try {
          res = await fetch(`/api/jobs/pro?id=${encodeURIComponent(cleanId)}`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });
        } catch (fetchErr: any) {
          console.error(`[API /jobs/pro error]: Network failure unlocking job ${cleanId} (${fetchErr?.message || "fetch failed"})`);
          proUnlockError = { isNetworkError: true, message: "Network connection error while unlocking Pro job details." };
        }

        if (res) {
          if (res.ok) {
            const { job } = await res.json();
            if (job) {
              const isInactive = Boolean(job.isExpired || job.is_expired || job.is_active === false || job.status === "expired" || job.status === "closed");
              return {
                id: job.id,
                title: stripHtmlAndExecutableMarkup(job.title || "Untitled Position"),
                company: stripHtmlAndExecutableMarkup(job.company || "Verified Employer"),
                location: stripHtmlAndExecutableMarkup(job.location || (job.remote ? "Remote (Worldwide)" : "Remote")),
                date: formatDate(job.posted_at || job.first_seen_at || job.created_at),
                salary: stripHtmlAndExecutableMarkup(job.salary_display || formatSalary(job.salary_min, job.salary_max, job.currency, job.salary_period) || job.salary_text || ""),
                salary_display: job.salary_display || null,
                salary_original: job.salary_original || null,
                category: stripHtmlAndExecutableMarkup(job.category || "engineering"),
                remote: Boolean(job.remote),
                remoteScope: job.remote_scope || undefined,
                remoteEligibility: job.remote_eligibility || undefined,
                country: job.country || job.country_code || "",
                type: job.job_type === "internship" ? "Internship" : "Full-time",
                directSource: Boolean(job.verified ?? true),
                applyUrl: isInactive ? "" : (sanitizeExternalUrl(job.apply_url) || ""),
                description: stripHtmlAndExecutableMarkup(job.description || ""),
                skills: job.skills || [],
                postedAt: job.posted_at || job.first_seen_at || job.created_at,
                isExpired: isInactive,
                status: isInactive ? "expired" : (job.status || "active"),
                logoUrl: job.logo_url || job.logoUrl || null,
                logo_url: job.logo_url || job.logoUrl || null,
              };
            }
          } else {
            console.error(`[API /jobs/pro error]: Pro unlock failed with status ${res.status}`);
            proUnlockError = {
              status: res.status,
              message: res.status === 403
                ? "Pro subscription required to access full job details."
                : `Pro unlock request failed with status ${res.status}`,
            };

            if (res.status === 401) {
              // Only redirect if getSession shows no session (prevents redirect loop)
              const { data: { session: currentSession } } = await supabase.auth.getSession();
              if (!currentSession && typeof window !== "undefined") {
                const currentPath = window.location.pathname + window.location.search;
                window.location.assign(`/login?returnTo=${encodeURIComponent(currentPath)}`);
              }
            }
          }
        }
      }
    } catch (proErr: any) {
      console.error(`[API /jobs/pro error]: Unexpected error during Pro unlock (${proErr?.message || "error"})`);
      if (!proUnlockError) {
        proUnlockError = { isNetworkError: true, message: "Network error unlocking Pro job details." };
      }
    }
  }

  // 2. Query server search endpoint for single job (works for both active and inactive/expired roles)
  if (typeof window !== "undefined") {
    try {
      const res = await fetch(`/api/jobs/search?id=${encodeURIComponent(cleanId)}`);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.jobs) && json.jobs.length > 0) {
          const job = json.jobs[0];
          return {
            ...job,
            isExpired: Boolean(job.isExpired || job.status === "expired" || job.status === "closed"),
            proUnlockError,
          };
        }
      }
    } catch (fetchErr) {
      console.warn("Server search single job fetch failed, falling back to direct query:", fetchErr);
    }
  }

  // Fallback / direct Supabase client query:
  try {
    const supabase = createClient();
    const selectColumns =
      "id, title, location, category, remote, remote_scope, remote_eligibility, country_code, job_type, verified, posted_at, created_at, status, is_active";

    let { data, error } = await supabase
      .from("jobs_public")
      .select(selectColumns)
      .eq("id", cleanId)
      .maybeSingle();

    let isInactive = false;
    if (!data) {
      // Direct query fallback for inactive/expired row fixture
      const inactiveRes = await supabase
        .from("jobs")
        .select(selectColumns)
        .eq("id", cleanId)
        .maybeSingle();
      if (!inactiveRes.error && inactiveRes.data) {
        data = inactiveRes.data;
        isInactive = true;
      }
    }

    if (data) {
      const row = data as any;
      const expired = Boolean(isInactive || row.is_active === false || row.status === "expired" || row.status === "closed");
      return {
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.created_at),
        salary: "",
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.verified),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
        isExpired: expired,
        status: expired ? "expired" : (row.status || "active"),
        proUnlockError,
      };
    }
  } catch (err) {
    console.warn("Public job fetch error:", err);
  }



  return null;
}

let cachedAllActiveJobs: LiveJob[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Loads the full active live dataset across all pages in parallel chunks.
 */
export async function getAllActiveJobs(): Promise<LiveJob[]> {
  const now = Date.now();
  if (cachedAllActiveJobs && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAllActiveJobs;
  }

  try {
    const supabase = createClient();
    const { count } = await supabase
      .from("jobs_public")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("status", "active");

    const total = count || 1000;
    const CHUNK_SIZE = 1000;
    const numChunks = Math.min(Math.ceil(total / CHUNK_SIZE), 3); // Load up to 3000 rows max for active pool

    const chunkPromises = [];
    for (let i = 0; i < numChunks; i++) {
      const from = i * CHUNK_SIZE;
      const to = from + CHUNK_SIZE - 1;
      chunkPromises.push(
        supabase
          .from("jobs_public")
          .select(PUBLIC_SELECT_COLUMNS)
          .eq("is_active", true)
          .eq("status", "active")
          .range(from, to)
      );
    }

    const results = await Promise.all(chunkPromises);
    const allRows: any[] = [];
    for (const res of results) {
      if (res.data) {
        allRows.push(...res.data);
      }
    }

    if (allRows.length > 0) {
      const mapped: LiveJob[] = allRows.map((row: any) => ({
        id: row.id,
        title: row.title || "Untitled Position",
        company: "Verified Employer",
        location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
        date: formatDate(row.posted_at || row.created_at),
        salary: "",
        category: row.category || "engineering",
        remote: Boolean(row.remote),
        remoteScope: row.remote_scope || undefined,
        remoteEligibility: row.remote_eligibility || undefined,
        country: row.country_code || row.country || "",
        type: row.job_type === "internship" ? "Internship" : "Full-time",
        directSource: Boolean(row.verified),
        applyUrl: "",
        description: "",
        skills: [],
        postedAt: row.posted_at || row.created_at,
      }));

      cachedAllActiveJobs = mapped;
      cacheTimestamp = now;
      return mapped;
    }
  } catch (err) {
    console.warn("getAllActiveJobs error:", err);
  }

  return [];
}

/**
 * Computes fit diagnostics across the corpus and returns the top ranked jobs for the given candidate profile.
 * Delegates to the server-side /api/jobs/top10 endpoint to avoid heavy client-side downloads.
 */
export async function getTopRankedJobsForCandidate(
  candidate: CandidateProfile,
  limit = 10,
  isPro = false
): Promise<{ job: LiveJob; diagnostics: FitDiagnosticsResult }[]> {
  if (!isPro) {
    // Pro-only feature: strictly return empty array for non-Pro to prevent unentitled data exposure
    return [];
  }
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (token && isPro) {
      const res = await fetch("/api/jobs/top10", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ candidate, limit }),
      });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.jobs) && data.jobs.length > 0) {
          return data.jobs;
        }
      }
    }
  } catch (err) {
    console.warn("[getTopRankedJobsForCandidate] Server top10 fetch failed, using fallback:", err);
  }

  // Graceful client fallback using unified scoring and identical inputs
  const result = await getLiveJobs({
    sortBy: "match",
    candidate,
    pageSize: Math.max(limit, 25),
    isPro,
  });

  const scored = result.jobs.map((job) => {
    const diagnostics = computeFitDiagnostics(candidate, {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      remote_scope: job.remoteScope || (job.remote ? "worldwide" : undefined),
      category: job.category,
      skills: job.skills,
      salary_text: job.salary,
      description: job.description,
    });

    return { job, diagnostics };
  });

  scored.sort((a, b) => b.diagnostics.score - a.diagnostics.score);
  return scored.slice(0, limit);
}

