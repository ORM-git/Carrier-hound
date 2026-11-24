import { hasOnboardingAnswers, hasResumeSignals, scoreJobRecommendation, type OnboardingAnswers } from "./recommendations";
import { normalizeUserCountries } from "@/lib/countries";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { loadResumeProfileForRanking } from "@/lib/onboarding/resumeParse";
import { clampMatchScore } from "@/lib/matcher/scoring";

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
    return hasOnboardingAnswers(answers) || hasResumeSignals(answers.resumeProfile) ? answers : null;
  } catch { return null; }
}

/** Display score is separate from list ordering. Detail reloads must not switch to a different scoring algorithm. */
export function sharedDisplayScore(row: any, answers: OnboardingAnswers | null, includePaidInputs = true): number | null {
  if (!answers) return null;
  const input = includePaidInputs ? row : { ...row, description: undefined, skills: undefined, salary_text: undefined, salary_min: undefined, salary_max: undefined, currency: undefined };
  return clampMatchScore(scoreJobRecommendation(input, answers).score);
}
