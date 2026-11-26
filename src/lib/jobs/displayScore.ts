import { hasOnboardingAnswers, hasResumeSignals, scoreJobRecommendation, type OnboardingAnswers } from "./recommendations";
import { normalizeUserCountries } from "@/lib/countries";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { loadResumeProfileForRanking } from "@/lib/onboarding/resumeParse";
import { clampMatchScore } from "@/lib/matcher/scoring";
import { normalizeSkillList } from "./skillKey";
import { savedFeedConstraintsEnforcedFor } from "@/lib/preferences/feedConstraints";

/**
 * Saved preferred skills for ranking. Server flag CM_PREFERRED_SKILLS_RANKING=1 (owner decision) AND the column must
 * exist: a separate read, so a missing column (migration not applied) or any error is just "no preferred skills".
 * Free accounts never see a boost: skills are a paid scoring input and sharedDisplayScore strips them.
 */
export async function loadPreferredSkills(db: any, userId: string | null, env?: Record<string, any>): Promise<string[]> {
  if (!userId) return [];
  // Same contract as the capability: owner gate (saved constraints applied) AND the ranking flag.
  const bound = typeof env?.CM_PREFERRED_SKILLS_RANKING === "string" && env.CM_PREFERRED_SKILLS_RANKING.trim() ? env.CM_PREFERRED_SKILLS_RANKING.trim() : undefined;
  const flag = bound ?? process.env.CM_PREFERRED_SKILLS_RANKING;
  if (flag !== "1" || !savedFeedConstraintsEnforcedFor(env)) return [];
  try {
    const { data, error } = await db.from("user_preferences").select("preferred_skills").eq("user_id", userId).maybeSingle();
    if (error) return [];
    return normalizeSkillList(data?.preferred_skills);
  } catch {
    return [];
  }
}

/** Same saved profile for every list, single-job and unlock response. Never accepts another user's id from a request. */
export async function loadDisplayScoreAnswers(db: any, userId: string | null, env?: Record<string, any>): Promise<OnboardingAnswers | null> {
  if (!userId) return null;
  try {
    const { data: p, error } = await db.from("user_preferences")
      .select("roles, experience_level, remote_preference, locations, employment_types, categories, min_salary, salary_currency")
      .eq("user_id", userId).maybeSingle();
    if (error) return null;
    const locations = Array.isArray(p?.locations) ? p.locations : [];
    const countries = normalizeUserCountries(locations);
    const answers: OnboardingAnswers = {
      roles: Array.isArray(p?.roles) ? p.roles : [], experienceLevel: p?.experience_level || null,
      remotePreference: p?.remote_preference || null, locations,
      employmentTypes: Array.isArray(p?.employment_types) ? p.employment_types : [],
      categories: Array.isArray(p?.categories) ? p.categories : [],
      minSalary: p?.min_salary == null ? null : Number(p.min_salary), salaryCurrency: p?.salary_currency || null,
      country: countries.names[0] || null, countryCode: countries.codes[0] || null,
      resumeProfile: isOnboardingStep2EnabledServer(env) ? await loadResumeProfileForRanking(db, userId) : null,
    };
    const preferredSkills = await loadPreferredSkills(db, userId, env);
    if (preferredSkills.length) answers.preferredSkills = preferredSkills;
    return hasOnboardingAnswers(answers) || hasResumeSignals(answers.resumeProfile) ? answers : null;
  } catch { return null; }
}

/** Display score is separate from list ordering. Detail reloads must not switch to a different scoring algorithm. */
/** `now`: the response's reference instant, also passed to scoreInputRevision for the same row. */
export function sharedDisplayScore(row: any, answers: OnboardingAnswers | null, includePaidInputs = true, now: number = Date.now()): number | null {
  if (!answers) return null;
  const input = includePaidInputs ? row : { ...row, description: undefined, skills: undefined, salary_text: undefined, salary_min: undefined, salary_max: undefined, currency: undefined };
  return clampMatchScore(scoreJobRecommendation(input, answers, now).score);
}
