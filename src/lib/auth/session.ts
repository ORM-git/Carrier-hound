import { createClient } from "../supabase/client";
import { UserPreferences, emptyUserPreferences } from "./types";
import { COUNTRY_MIGRATION, isMissingCountryColumnError } from "./countryColumns";
import {
  legacyRemotePreference,
  normalizeFeedConstraints,
  normalizeTextList,
  normalizeWorkModels,
  parseDatePosted,
  workModelsFromLegacy,
} from "@/lib/preferences/feedConstraints";
export { getValidReturnUrl } from "./returnTo";
import { markAccountOnboardingCompleted } from "./onboarding";
import { clearCandidateProfileMemoryCache } from "../resume/storage";
import { clearTrackerMemoryState } from "../tracker/storage";
import type { User } from "@supabase/supabase-js";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "auth/session" } });

const PREFS_STORAGE_KEY = "careermonke_preferences";
const USER_EMAIL_KEY = "careermonke_user_email";
const USER_PRO_KEY = "careermonke_pro_active";
const CANDIDATE_PROFILE_KEY = "careermonke_candidate_profile";

/**
 * Retrieves the current authenticated user session strictly from Supabase.
 */
export async function getAuthUser(): Promise<User | null> {
  const supabase = createClient();
  try {
    // Check local session first for instantaneous response
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const now = new Date();
      const isBanned = Boolean(session.user.banned_until && new Date(session.user.banned_until) > now);
      const isBlocked = session.user.user_metadata?.is_blocked === true;
      if (isBanned || isBlocked) {
        if (typeof window !== "undefined") {
          localStorage.setItem("careermonke_blocked_notice", "true");
        }
        await signOutUser();
        return null;
      }

      if (typeof window !== "undefined" && session.user.email) {
        localStorage.setItem(USER_EMAIL_KEY, session.user.email);
      }
      return session.user;
    }

    // Network validation with timeout
    const userPromise = supabase.auth.getUser();
    const timeoutPromise = new Promise<{ data: { user: null }; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: { user: null }, error: new Error("Auth timeout") }), 5000)
    );

    const { data: { user }, error } = await Promise.race([userPromise, timeoutPromise]);
    if (user && !error) {
      const now = new Date();
      const isBanned = Boolean(user.banned_until && new Date(user.banned_until) > now);
      const isBlocked = user.user_metadata?.is_blocked === true;
      if (isBanned || isBlocked) {
        if (typeof window !== "undefined") {
          localStorage.setItem("careermonke_blocked_notice", "true");
        }
        await signOutUser();
        return null;
      }

      if (typeof window !== "undefined" && user.email) {
        localStorage.setItem(USER_EMAIL_KEY, user.email);
      }
      return user;
    }
  } catch (err) {
    log.warn("Supabase auth check failed:", { error: err });
  }

  // Clear stale local storage if Supabase says no authenticated session
  if (typeof window !== "undefined") {
    localStorage.removeItem(USER_EMAIL_KEY);
  }

  return null;
}

/** Columns that exist before migration 20261117 (country columns excluded). */
const PREFS_COLUMNS_WITHOUT_COUNTRY =
  "roles, categories, experience_level, employment_types, locations, remote_preference, work_auth, min_salary, salary_currency, daily_digest_opt_in, onboarding_completed, eligibility_filter, updated_at";
const PREFS_COLUMNS_WITH_COUNTRY = `${PREFS_COLUMNS_WITHOUT_COUNTRY}, country, country_code`;

/**
 * Retrieves user preferences from Supabase with fallback to local storage.
 * A missing row means the user has saved nothing yet: return blank preferences
 * and write NOTHING (no seeded roles, experience level, salary or work auth).
 */
export async function getUserPreferences(userId?: string, clientOverride?: any): Promise<UserPreferences> {
  const supabase = clientOverride || createClient();
  if (userId && userId !== "local-user") {
    try {
      let { data, error } = await supabase
        .from("user_preferences")
        .select("roles, categories, experience_level, employment_types, locations, remote_preference, work_auth, min_salary, salary_currency, daily_digest_opt_in, onboarding_completed, eligibility_filter, updated_at, country, country_code, deleted_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();

      if (error && (isMissingCountryColumnError(error) || isMissingDeletedAtColumnError(error))) {
        const missingCountry = isMissingCountryColumnError(error);
        const missingDeletedAt = isMissingDeletedAtColumnError(error);

        if (missingCountry && missingDeletedAt) {
          // Neither column exists (legacy schema before both migrations)
          ({ data, error } = await supabase
            .from("user_preferences")
            .select(PREFS_COLUMNS_WITHOUT_COUNTRY)
            .eq("user_id", userId)
            .maybeSingle());
        } else if (missingDeletedAt) {
          // Country columns present, deleted_at absent: preserve country!
          ({ data, error } = await supabase
            .from("user_preferences")
            .select(PREFS_COLUMNS_WITH_COUNTRY)
            .eq("user_id", userId)
            .maybeSingle());
        } else if (missingCountry) {
          // Country absent, deleted_at present: filter deleted_at
          log.warn("user_preferences country columns missing; reading without them", { migration: COUNTRY_MIGRATION });
          ({ data, error } = await supabase
            .from("user_preferences")
            .select(`${PREFS_COLUMNS_WITHOUT_COUNTRY}, deleted_at`)
            .eq("user_id", userId)
            .is("deleted_at", null)
            .maybeSingle());
        }
      }

      if (data && !error) {
        if (data.deleted_at) return emptyUserPreferences();
        const prefs: UserPreferences = {
          roles: data.roles || [],
          categories: data.categories || [],
          experienceLevel: data.experience_level || undefined,
          employmentTypes: data.employment_types || [],
          locations: data.locations || [],
          remotePreference: data.remote_preference || "any",
          workAuth: data.work_auth || undefined,
          country: data.country || undefined,
          countryCode: data.country_code || undefined,
          minSalary: data.min_salary ?? undefined,
          salaryCurrency: data.salary_currency || undefined,
          dailyDigestOptIn: data.daily_digest_opt_in ?? false,
          onboardingCompleted: Boolean(data.onboarding_completed),
          eligibilityFilter: data.eligibility_filter ?? true,
          updatedAt: data.updated_at || new Date().toISOString(),
        };
        Object.assign(prefs, await readFeedConstraintColumns(supabase, userId, prefs.remotePreference));
        if (typeof window !== "undefined") {
          localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
        }
        return prefs;
      }

      // No row yet or a failed read: do not let the shared local cache restore another identity.
      if (!error && !data) {
        return emptyUserPreferences();
      }
      if (error) return emptyUserPreferences();
    } catch (_) {
      // Authenticated reads never use the shared, unscoped cache as an error fallback.
      return emptyUserPreferences();
    }
  }

  if (typeof window !== "undefined") {
    const saved = localStorage.getItem(PREFS_STORAGE_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (_) {
        // ignore parse error
      }
    }
  }

  return emptyUserPreferences();
}

const FEED_CONSTRAINT_COLUMNS = "work_models, date_posted, excluded_titles, included_companies, excluded_companies";
export const FEED_CONSTRAINTS_MIGRATION = "20261125a_user_preferences_feed_constraints.sql";

function isMissingFeedConstraintColumnError(error: any): boolean {
  const message = String(error?.message || "");
  return (error?.code === "42703" || error?.code === "PGRST204") &&
    /work_models|date_posted|excluded_titles|included_companies|excluded_companies/.test(message);
}

/**
 * Separate read so an unmigrated schema degrades to "constraints unavailable" instead of
 * blanking every other preference. NULL columns (legacy rows) read as never saved; work models
 * then come from the legacy single remote_preference.
 */
async function readFeedConstraintColumns(supabase: any, userId: string, remotePreference: string): Promise<Partial<UserPreferences>> {
  const legacy: Partial<UserPreferences> = { workModels: workModelsFromLegacy(remotePreference) };
  try {
    const { data: row, error } = await supabase
      .from("user_preferences")
      .select(FEED_CONSTRAINT_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      if (isMissingFeedConstraintColumnError(error)) {
        log.warn("user_preferences feed constraint columns missing", { migration: FEED_CONSTRAINTS_MIGRATION });
      }
      return { ...legacy, feedConstraintsAvailable: false };
    }
    const c = normalizeFeedConstraints({
      excludedTitles: row?.excluded_titles,
      includedCompanies: row?.included_companies,
      excludedCompanies: row?.excluded_companies,
      datePosted: row?.date_posted,
    });
    return {
      workModels: Array.isArray(row?.work_models) ? normalizeWorkModels(row.work_models) : legacy.workModels,
      datePosted: c.datePosted,
      excludedTitles: c.excludedTitles,
      includedCompanies: normalizeTextList(row?.included_companies), // stored as saved; conflict settled at query time
      excludedCompanies: c.excludedCompanies,
      feedConstraintsAvailable: true,
    };
  } catch {
    return { ...legacy, feedConstraintsAvailable: false };
  }
}

/** Columns for the constraint fields the caller set (undefined leaves the saved value alone). */
function feedConstraintColumns(p: UserPreferences): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Read from a schema without the columns: write none of them, so other preferences still save.
  if (p.feedConstraintsAvailable === false) return out;
  if (p.workModels !== undefined) out.work_models = normalizeWorkModels(p.workModels);
  if (p.datePosted !== undefined) out.date_posted = parseDatePosted(p.datePosted);
  if (p.excludedTitles !== undefined) out.excluded_titles = normalizeTextList(p.excludedTitles);
  if (p.includedCompanies !== undefined) out.included_companies = normalizeTextList(p.includedCompanies);
  if (p.excludedCompanies !== undefined) out.excluded_companies = normalizeTextList(p.excludedCompanies);
  return out;
}

/** remote_preference stays the legacy single value: derived from workModels when the caller set them. */
function remotePreferenceToWrite(p: UserPreferences): string {
  if (p.workModels !== undefined) return legacyRemotePreference(normalizeWorkModels(p.workModels));
  return p.remotePreference || "any";
}

function isMissingDeletedAtColumnError(error: any): boolean {
  const message = String(error?.message || "").toLowerCase();
  return (error?.code === "42703" || error?.code === "PGRST204") && message.includes("deleted_at");
}

/**
 * Saves user preferences to Supabase and syncs with local storage.
 *
 * country / country_code are first-class columns: they are written whenever the
 * caller sets them (undefined means "not touched" and leaves the saved value
 * alone). If the columns do not exist yet (migration 20261117 not applied) the
 * save fails loudly instead of dropping the country and reporting success.
 */
export async function saveUserPreferences(prefs: UserPreferences, userId?: string, clientOverride?: any): Promise<void> {
  const updatedPrefs: UserPreferences = {
    ...prefs,
    updatedAt: new Date().toISOString(),
  };

  const supabase = clientOverride || createClient();
  if (userId && userId !== "local-user") {
    // Explicit column list (object literal). country / country_code are only written when the
    // caller set them, so a save without a country never blanks a stored one.
    // deleted_at: null ensures active preferences writes clear any soft-delete tombstone.
    let { error: upsertError } = await supabase.from("user_preferences").upsert({
      user_id: userId,
      roles: updatedPrefs.roles || [],
      categories: updatedPrefs.categories || [],
      experience_level: updatedPrefs.experienceLevel || null,
      employment_types: updatedPrefs.employmentTypes || [],
      locations: updatedPrefs.locations || [],
      remote_preference: remotePreferenceToWrite(updatedPrefs),
      work_auth: updatedPrefs.workAuth || null,
      min_salary: updatedPrefs.minSalary ?? null,
      salary_currency: updatedPrefs.salaryCurrency || null,
      daily_digest_opt_in: updatedPrefs.dailyDigestOptIn ?? false,
      onboarding_completed: updatedPrefs.onboardingCompleted ?? false,
      eligibility_filter: updatedPrefs.eligibilityFilter ?? true,
      deleted_at: null,
      updated_at: updatedPrefs.updatedAt,
      ...feedConstraintColumns(updatedPrefs),
      ...(updatedPrefs.country !== undefined ? { country: updatedPrefs.country || null } : {}),
      ...(updatedPrefs.countryCode !== undefined
        ? { country_code: updatedPrefs.countryCode ? updatedPrefs.countryCode.toUpperCase() : null }
        : {}),
    });
    if (upsertError && isMissingDeletedAtColumnError(upsertError)) {
      upsertError = (await supabase.from("user_preferences").upsert({
        user_id: userId,
        roles: updatedPrefs.roles || [],
        categories: updatedPrefs.categories || [],
        experience_level: updatedPrefs.experienceLevel || null,
        employment_types: updatedPrefs.employmentTypes || [],
        locations: updatedPrefs.locations || [],
        remote_preference: remotePreferenceToWrite(updatedPrefs),
        work_auth: updatedPrefs.workAuth || null,
        min_salary: updatedPrefs.minSalary ?? null,
        salary_currency: updatedPrefs.salaryCurrency || null,
        daily_digest_opt_in: updatedPrefs.dailyDigestOptIn ?? false,
        onboarding_completed: updatedPrefs.onboardingCompleted ?? false,
        eligibility_filter: updatedPrefs.eligibilityFilter ?? true,
        updated_at: updatedPrefs.updatedAt,
        ...feedConstraintColumns(updatedPrefs),
        ...(updatedPrefs.country !== undefined ? { country: updatedPrefs.country || null } : {}),
        ...(updatedPrefs.countryCode !== undefined
          ? { country_code: updatedPrefs.countryCode ? updatedPrefs.countryCode.toUpperCase() : null }
          : {}),
      })).error;
    }

    if (upsertError) {
      if (isMissingFeedConstraintColumnError(upsertError)) {
        log.error("user_preferences feed constraint columns missing; refusing to save without them", {
          migration: FEED_CONSTRAINTS_MIGRATION,
        });
        throw new Error("Failed to save preferences: this preference storage is not available yet. Please try again later.");
      }
      if (isMissingCountryColumnError(upsertError)) {
        log.error("user_preferences country columns missing; refusing to save without them", {
          migration: COUNTRY_MIGRATION,
        });
        throw new Error("Failed to save preferences: country storage is not available yet. Please try again later.");
      }
      log.error("Failed to save user_preferences", { error: upsertError });
      throw new Error(`Failed to save preferences: ${upsertError.message || upsertError}`);
    }

  }

  // Cache only after the DB accepted the write, so the local cache never runs ahead of the DB.
  if (typeof window !== "undefined") {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(updatedPrefs));
    window.dispatchEvent(new Event("careermonke_preferences_updated"));
  }

  if (userId && userId !== "local-user" && updatedPrefs.onboardingCompleted) {
    await markAccountOnboardingCompleted(supabase, userId);
  }
}

/**
 * Full Sign-Out with clean private cache purge.
 */
export async function signOutUser(): Promise<void> {
  const supabase = createClient();
  try {
    await supabase.auth.signOut();
  } catch (e) {
    log.warn("Supabase sign out error:", { error: e });
  }

  if (typeof window !== "undefined") {
    localStorage.removeItem(USER_EMAIL_KEY);
    localStorage.removeItem(USER_PRO_KEY);
    localStorage.removeItem(PREFS_STORAGE_KEY);
    localStorage.removeItem(CANDIDATE_PROFILE_KEY);

    // Purge candidate profile and preferences keys; user-scoped offline work (applications, tailored assets)
    // is preserved under its owner-scoped key and strictly isolated from subsequent users.
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith("careermonke_candidate_profile") ||
          k.startsWith("careermonke_preferences") ||
          k.startsWith("careermonke:profile-draft:"))
      ) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));

    document.cookie = `${USER_EMAIL_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    clearCandidateProfileMemoryCache();
    clearTrackerMemoryState();
    window.dispatchEvent(new Event("careermonke_auth_updated"));
    window.dispatchEvent(new Event("careermonke_pro_updated"));
    window.dispatchEvent(new Event("careermonke_profile_updated"));
    window.dispatchEvent(new Event("careermonke_preferences_updated"));
    window.dispatchEvent(new Event("careermonke_tracker_updated"));
  }
}
