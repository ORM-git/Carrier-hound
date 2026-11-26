import { formatSalary } from "@/lib/salary/parser";
import { sharedDisplayScore } from "@/lib/jobs/displayScore";
import { scoreInputRevision } from "@/lib/matcher/scoring";
import type { OnboardingAnswers } from "@/lib/jobs/recommendations";
import { normalizeUserCountries } from "@/lib/countries";

/** Entitlement inputs for one response. `unmasked` is true ONLY for a Pro viewer on the full jobs table. */
export interface RecommendedFormatContext {
  unmasked: boolean;
  isPro: boolean;
  listGroupIds: Map<string, string>;
  scoreAnswers: OnboardingAnswers | null;
  scoredAt: number;
}

export function formatDate(dateStr?: string | null): string {
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

/**
 * The /api/jobs/recommended card format (moved verbatim from the route): unmasked for Pro, masked for
 * Free/guest with ZERO paid data. Every recommended-style response must format rows through this.
 */
export function formatRecommendedRow(row: any, ctx: RecommendedFormatContext) {
  const originalSalary = formatSalary(row.salary_min, row.salary_max, row.currency, row.salary_period) || row.salary_text || null;
  const displaySalary = originalSalary;

  if (ctx.unmasked) {
    return {
      id: row.id,
      title: row.title || "Untitled Position",
      company: row.company || "Verified Employer",
      companyId: row.company_id || null,
      company_id: row.company_id || null,
      location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
      date: formatDate(row.posted_at || row.created_at || row.first_seen_at),
      salary: displaySalary || "",
      salary_display: displaySalary,
      salary_original: originalSalary,
      category: row.category || "engineering",
      remote: Boolean(row.remote),
      remoteScope: row.remote_scope || undefined,
      remoteEligibility: row.remote_eligibility || undefined,
      country: row.country_code || row.country || "",
      type: row.job_type === "internship" ? "Internship" : (row.job_type || "Full-time"),
      directSource: Boolean(row.verified ?? true),
      applyUrl: row.apply_url || "",
      description: row.description || "",
      skills: row.skills || [],
      postedAt: row.posted_at || row.created_at,
      companyDomain: row.companies?.domain || null,
      companyLogoUrl: row.companies?.logo_url || null,
      logoUrl: row.logo_url || row.companies?.logo_url || null,
      logo_url: row.logo_url || row.companies?.logo_url || null,
      matchScore: sharedDisplayScore(row, ctx.scoreAnswers, ctx.isPro, ctx.scoredAt),
      scoreRevision: scoreInputRevision(row, true, ctx.scoredAt),
    };
  }

  // Guest / Free masked format — ZERO paid data leakage
  return {
    id: row.id,
    title: row.title || "Untitled Position",
    company: "Verified Employer",
    companyGroupId: row.company_id ? ctx.listGroupIds.get(row.company_id) ?? null : null,
    location: row.location || (row.remote ? "Remote (Worldwide)" : "Remote"),
    date: formatDate(row.posted_at || row.created_at || row.first_seen_at),
    salary: "",
    salary_display: null,
    salary_original: null,
    category: row.category || "engineering",
    remote: Boolean(row.remote),
    remoteScope: row.remote_scope || undefined,
    remoteEligibility: row.remote_eligibility || undefined,
    country: row.country_code || row.country || "",
    type: row.job_type === "internship" ? "Internship" : (row.job_type || "Full-time"),
    directSource: Boolean(row.verified ?? true),
    applyUrl: "",
    description: "",
    skills: [],
    postedAt: row.posted_at || row.created_at,
    logoUrl: null,
    logo_url: null,
    matchScore: sharedDisplayScore(row, ctx.scoreAnswers, ctx.isPro, ctx.scoredAt),
    scoreRevision: scoreInputRevision(row, false, ctx.scoredAt),
  };
}

export const PREFERENCE_ANSWER_COLUMNS = "roles, experience_level, remote_preference, locations, employment_types, categories, min_salary, salary_currency";

/** user_preferences row -> scoring answers (moved verbatim from /api/jobs/recommended). */
export function answersFromPreferencesRow(prefs: any): OnboardingAnswers {
  return {
    roles: Array.isArray(prefs.roles) ? prefs.roles : [],
    experienceLevel: prefs.experience_level || null,
    remotePreference: prefs.remote_preference || null,
    locations: Array.isArray(prefs.locations) ? prefs.locations : [],
    employmentTypes: Array.isArray(prefs.employment_types) ? prefs.employment_types : [],
    categories: Array.isArray(prefs.categories) ? prefs.categories : [],
    minSalary: prefs.min_salary != null ? Number(prefs.min_salary) : null,
    salaryCurrency: prefs.salary_currency || null,
    country: (prefs as any).country || (Array.isArray(prefs.locations) && prefs.locations.length > 0 ? normalizeUserCountries(prefs.locations).names[0] : null) || null,
    countryCode: (prefs as any).country_code || (Array.isArray(prefs.locations) && prefs.locations.length > 0 ? normalizeUserCountries(prefs.locations).codes[0] : null) || null,
  };
}
