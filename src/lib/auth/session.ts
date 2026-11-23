import { createClient } from "../supabase/client";
import { UserPreferences, emptyUserPreferences } from "./types";
import { COUNTRY_MIGRATION, isMissingCountryColumnError } from "./countryColumns";
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

/**
 * Retrieves user preferences from Supabase with fallback to local storage.
 * A missing row means the user has saved nothing yet: return blank preferences
 * and write NOTHING (no seeded roles, experience level, salary or work auth).
 */
export async function getUserPreferences(userId?: string): Promise<UserPreferences> {
  const supabase = createClient();
  if (userId && userId !== "local-user") {
    try {
      let { data, error } = await supabase
        .from("user_preferences")
        .select("roles, categories, experience_level, employment_types, locations, remote_preference, work_auth, min_salary, salary_currency, daily_digest_opt_in, onboarding_completed, eligibility_filter, updated_at, country, country_code, deleted_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle();

      if (error && (isMissingCountryColumnError(error) || isMissingDeletedAtColumnError(error))) {
        // Migration not applied yet: read everything else, the country stays unknown.
        if (isMissingCountryColumnError(error)) {
          log.warn("user_preferences country columns missing; reading without them", { migration: COUNTRY_MIGRATION });
          ({ data, error } = await supabase
            .from("user_preferences")
            .select(`${PREFS_COLUMNS_WITHOUT_COUNTRY}, deleted_at`)
            .eq("user_id", userId)
            .is("deleted_at", null)
            .maybeSingle());
        }
        if (error && isMissingDeletedAtColumnError(error)) {
          ({ data, error } = await supabase
            .from("user_preferences")
            .select(PREFS_COLUMNS_WITHOUT_COUNTRY)
            .eq("user_id", userId)
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
export async function saveUserPreferences(prefs: UserPreferences, userId?: string): Promise<void> {
  const updatedPrefs: UserPreferences = {
    ...prefs,
    updatedAt: new Date().toISOString(),
  };

  const supabase = createClient();
  if (userId && userId !== "local-user") {
    // Explicit column list (object literal). country / country_code are only written when the
    // caller set them, so a save without a country never blanks a stored one.
    const { error: upsertError } = await supabase.from("user_preferences").upsert({
      user_id: userId,
      roles: updatedPrefs.roles || [],
      categories: updatedPrefs.categories || [],
      experience_level: updatedPrefs.experienceLevel || null,
      employment_types: updatedPrefs.employmentTypes || [],
      locations: updatedPrefs.locations || [],
      remote_preference: updatedPrefs.remotePreference || "any",
      work_auth: updatedPrefs.workAuth || null,
      min_salary: updatedPrefs.minSalary ?? null,
      salary_currency: updatedPrefs.salaryCurrency || null,
      // Write back the caller's loaded value so a recorded choice is preserved; absent => false,
      // never the DB default (true). The digest opt-in UI and sending remain disabled.
      daily_digest_opt_in: updatedPrefs.dailyDigestOptIn ?? false,
      onboarding_completed: updatedPrefs.onboardingCompleted ?? false,
      eligibility_filter: updatedPrefs.eligibilityFilter ?? true,
      updated_at: updatedPrefs.updatedAt,
      ...(updatedPrefs.country !== undefined ? { country: updatedPrefs.country || null } : {}),
      ...(updatedPrefs.countryCode !== undefined
        ? { country_code: updatedPrefs.countryCode ? updatedPrefs.countryCode.toUpperCase() : null }
        : {}),
    });

    if (upsertError) {
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
