import { createClient } from "../supabase/client";
import { UserPreferences, DEFAULT_USER_PREFERENCES } from "./types";
import { clearCandidateProfileMemoryCache } from "../resume/storage";
import { clearTrackerMemoryState } from "../tracker/storage";
import type { User } from "@supabase/supabase-js";

const PREFS_STORAGE_KEY = "careermonke_preferences";
const USER_EMAIL_KEY = "careermonke_user_email";
const USER_PRO_KEY = "careermonke_pro_active";
const CANDIDATE_PROFILE_KEY = "careermonke_candidate_profile";

/**
 * Validates a return URL to ensure it is a safe relative same-site path.
 * Disallows absolute URLs, protocol-relative '//', or external schemes.
 */
export function getValidReturnUrl(targetUrl: string | null | undefined, fallback: string = "/dashboard"): string {
  if (!targetUrl) return fallback;
  const trimmed = targetUrl.trim();
  // Must start with '/' but not '//'
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.includes("\\")) {
    return trimmed;
  }
  return fallback;
}

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
    console.warn("Supabase auth check failed:", err);
  }

  // Clear stale local storage if Supabase says no authenticated session
  if (typeof window !== "undefined") {
    localStorage.removeItem(USER_EMAIL_KEY);
  }

  return null;
}

/**
 * Retrieves user preferences from Supabase with fallback to local storage.
 * Handles missing row by creating defaults, not by erroring.
 */
export async function getUserPreferences(userId?: string): Promise<UserPreferences> {
  const supabase = createClient();
  if (userId && userId !== "local-user") {
    try {
      const { data, error } = await supabase
        .from("user_preferences")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (data && !error) {
        const prefs: UserPreferences = {
          roles: data.roles || [],
          categories: data.categories || [],
          experienceLevel: data.experience_level || "mid",
          employmentTypes: data.employment_types || ["full-time"],
          locations: data.locations || ["Remote / Global"],
          remotePreference: data.remote_preference || "remote",
          workAuth: data.work_auth,
          minSalary: data.min_salary,
          salaryCurrency: data.salary_currency || "USD",
          dailyDigestOptIn: data.daily_digest_opt_in ?? true,
          onboardingCompleted: data.onboarding_completed ?? false,
          updatedAt: data.updated_at || new Date().toISOString(),
        };
        if (typeof window !== "undefined") {
          localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
        }
        return prefs;
      }

      // Handle missing row by saving and returning defaults
      if (!error && !data) {
        try {
          await saveUserPreferences(DEFAULT_USER_PREFERENCES, userId);
        } catch (_) {}
        return DEFAULT_USER_PREFERENCES;
      }
    } catch (_) {
      // Graceful fallback to local storage / defaults
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

  return DEFAULT_USER_PREFERENCES;
}

/**
 * Saves user preferences to Supabase and syncs with local storage.
 */
export async function saveUserPreferences(prefs: UserPreferences, userId?: string): Promise<void> {
  const updatedPrefs: UserPreferences = {
    ...prefs,
    updatedAt: new Date().toISOString(),
  };

  if (typeof window !== "undefined") {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(updatedPrefs));
    window.dispatchEvent(new Event("careermonke_preferences_updated"));
  }

  const supabase = createClient();
  if (userId && userId !== "local-user") {
    try {
      await supabase.from("user_preferences").upsert({
        user_id: userId,
        roles: updatedPrefs.roles || [],
        categories: updatedPrefs.categories || [],
        experience_level: updatedPrefs.experienceLevel || "mid",
        employment_types: updatedPrefs.employmentTypes || ["full-time"],
        locations: updatedPrefs.locations || ["Remote / Global"],
        remote_preference: updatedPrefs.remotePreference || "remote",
        work_auth: updatedPrefs.workAuth || null,
        min_salary: updatedPrefs.minSalary ?? null,
        salary_currency: updatedPrefs.salaryCurrency || "USD",
        daily_digest_opt_in: updatedPrefs.dailyDigestOptIn ?? true,
        onboarding_completed: updatedPrefs.onboardingCompleted ?? false,
        updated_at: updatedPrefs.updatedAt,
      });
    } catch (_) {
      // Graceful offline/missing table handling
    }
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
    console.warn("Supabase sign out error:", e);
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
          k.startsWith("careermonke_preferences"))
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
