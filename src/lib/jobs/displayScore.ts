import { hasOnboardingAnswers, hasResumeSignals, scoreJobRecommendation, type OnboardingAnswers } from "./recommendations";
import { normalizeUserCountries } from "@/lib/countries";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { readResumeProfileForRanking, type ResumeProfileRead } from "@/lib/onboarding/resumeParse";
import { clampMatchScore } from "@/lib/matcher/scoring";

export const PREFERENCES_COLS = "roles, experience_level, remote_preference, locations, employment_types, categories, min_salary, salary_currency";

/** `thrown` is set when the query threw rather than returned an error. */
export type PreferencesRead = { status: "found"; row: any } | { status: "missing" } | { status: "error"; thrown?: unknown };

export interface SavedProfileReads {
  preferences(): Promise<PreferencesRead>;
  resumeProfile(): Promise<ResumeProfileRead>;
}

/** Per source and request: a found/missing result is reused; an error is retried by the next caller, up to this many reads in total. */
export const MAX_READ_ATTEMPTS = 2;

function reuseUnlessError<T extends { status: string }>(read: () => Promise<T>): () => Promise<T> {
  let attempts = 0;
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    attempts++;
    // then() runs after `pending = p`, so an error clears the slot only once it has settled.
    const p = read().then((r) => {
      if (r.status === "error" && attempts < MAX_READ_ATTEMPTS) pending = undefined;
      return r;
    });
    pending = p;
    return p;
  };
}

/**
 * Request-local reads of ONE user's saved preferences and parsed resume. Create one per request for the
 * authenticated user and pass it to every consumer in that request; never keep it across requests or users.
 */
export function createSavedProfileReads(db: any, userId: string): SavedProfileReads {
  return {
    preferences: reuseUnlessError(async (): Promise<PreferencesRead> => {
      try {
        const { data, error } = await db.from("user_preferences").select(PREFERENCES_COLS).eq("user_id", userId).maybeSingle();
        if (error) return { status: "error" };
        return data ? { status: "found", row: data } : { status: "missing" };
      } catch (thrown) {
        return { status: "error", thrown };
      }
    }),
    resumeProfile: reuseUnlessError(() => readResumeProfileForRanking(db, userId)),
  };
}

/**
 * Same saved profile for every list, single-job and unlock response. Never accepts another user's id from a request.
 * `reads`, when given, must be the same request's reads for `userId`.
 */
export async function loadDisplayScoreAnswers(db: any, userId: string | null, env?: Record<string, any>, reads?: SavedProfileReads): Promise<OnboardingAnswers | null> {
  if (!userId) return null;
  try {
    const r = reads ?? createSavedProfileReads(db, userId);
    const pref = await r.preferences();
    if (pref.status === "error") return null;
    const p = pref.status === "found" ? pref.row : null;
    const locations = Array.isArray(p?.locations) ? p.locations : [];
    const countries = normalizeUserCountries(locations);
    const resume = isOnboardingStep2EnabledServer(env) ? await r.resumeProfile() : null;
    const answers: OnboardingAnswers = {
      roles: Array.isArray(p?.roles) ? p.roles : [], experienceLevel: p?.experience_level || null,
      remotePreference: p?.remote_preference || null, locations,
      employmentTypes: Array.isArray(p?.employment_types) ? p.employment_types : [],
      categories: Array.isArray(p?.categories) ? p.categories : [],
      minSalary: p?.min_salary == null ? null : Number(p.min_salary), salaryCurrency: p?.salary_currency || null,
      country: countries.names[0] || null, countryCode: countries.codes[0] || null,
      resumeProfile: resume?.status === "found" ? resume.profile : null,
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
