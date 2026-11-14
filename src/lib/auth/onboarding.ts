/**
 * src/lib/auth/onboarding.ts
 *
 * Single Canonical Evaluator for Account Onboarding Completion across:
 * - Middleware (src/middleware.ts)
 * - Dashboard (src/app/dashboard/page.tsx)
 * - Onboarding page (src/app/onboarding/page.tsx)
 *
 * Rules (matching migration 20261114b_profiles_onboarding_completed_at.sql exactly):
 * 1. public.profiles:
 *    - profiles.onboarding_completed_at IS NOT NULL -> completed.
 *    - Substantive legacy profile: trimmed non-empty full_name OR non-empty target_roles array -> completed.
 * 2. public.candidate_profiles:
 *    - confirmed_at IS NOT NULL -> completed.
 *    - Non-empty skills array -> completed.
 *    - Trimmed non-empty raw_resume_text -> completed.
 *    - Non-empty experience_json array (length > 0) -> completed.
 * 3. public.user_preferences:
 *    - STRICT: onboarding_completed === true -> completed.
 *    - A partial answer (roles saved with onboardingCompleted=false) must NOT count as completed.
 * 4. Brand new accounts (no profile, no resume, no preferences) -> false (shows onboarding).
 *
 * Error Handling:
 * - Supabase errors in markAccountOnboardingCompleted are handled and surfaced (thrown)
 *   so callers only treat completion as persisted when the write actually succeeded.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "@/lib/observability/logger";
import { updateSwr, invalidateSwr } from "@/lib/cache/swr";

const log = createLogger({ context: { module: "auth/onboarding" } });

export async function checkAccountOnboardingCompleted(
  supabase: SupabaseClient | any,
  userId: string
): Promise<boolean> {
  if (!supabase || !userId || typeof userId !== "string") {
    return false;
  }

  // 1. Check public.profiles
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("user_id, onboarding_completed_at, full_name, target_roles")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && profile) {
      if (profile.onboarding_completed_at) {
        return true;
      }
      const hasSubstantiveProfile = Boolean(
        (profile.full_name && String(profile.full_name).trim().length > 0) ||
          (Array.isArray(profile.target_roles) && profile.target_roles.length > 0)
      );
      if (hasSubstantiveProfile) {
        await markAccountOnboardingCompleted(supabase, userId).catch((err) => {
          log.warn("Self-healing onboarding_completed_at on profiles failed", { error: err });
        });
        return true;
      }
    }
  } catch (err) {
    log.warn("Error querying profiles for onboarding check", { error: err });
  }

  // 2. Check public.candidate_profiles (existing users who confirmed a resume or have substantive parsed data)
  try {
    const { data: candidate, error } = await supabase
      .from("candidate_profiles")
      .select("user_id, confirmed_at, skills, raw_resume_text, experience_json")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && candidate) {
      const hasSubstantiveCandidate = Boolean(
        candidate.confirmed_at ||
          (Array.isArray(candidate.skills) && candidate.skills.length > 0) ||
          (candidate.raw_resume_text && String(candidate.raw_resume_text).trim().length > 0) ||
          (Array.isArray(candidate.experience_json) && candidate.experience_json.length > 0)
      );
      if (hasSubstantiveCandidate) {
        await markAccountOnboardingCompleted(supabase, userId).catch((err) => {
          log.warn("Self-healing onboarding_completed_at on candidate profile failed", { error: err });
        });
        return true;
      }
    }
  } catch (err) {
    log.warn("Error querying candidate_profiles for onboarding check", { error: err });
  }

  // 3. Check public.user_preferences:
  // STRICT: onboarding_completed === true only. Partial answers (roles saved with onboardingCompleted=false) do NOT count!
  try {
    const { data: prefs, error } = await supabase
      .from("user_preferences")
      .select("user_id, onboarding_completed")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && prefs && prefs.onboarding_completed === true) {
      await markAccountOnboardingCompleted(supabase, userId).catch((err) => {
        log.warn("Self-healing onboarding_completed_at on user_preferences failed", { error: err });
      });
      return true;
    }
  } catch (err) {
    log.warn("Error querying user_preferences for onboarding check", { error: err });
  }

  return false;
}

/**
 * Persists onboarding completion for an account.
 * Writes to public.profiles.onboarding_completed_at and public.user_preferences.onboarding_completed.
 * Surfaces Supabase write errors instead of swallowing them.
 */
export async function markAccountOnboardingCompleted(
  supabase: SupabaseClient | any,
  userId: string,
  completedAt: string = new Date().toISOString()
): Promise<void> {
  if (!supabase || !userId || typeof userId !== "string") {
    throw new Error("Invalid supabase client or userId for markAccountOnboardingCompleted");
  }

  // 1. Persist to profiles
  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      user_id: userId,
      onboarding_completed_at: completedAt,
    },
    { onConflict: "user_id" }
  );

  if (profileError) {
    log.error("Failed to persist onboarding_completed_at to profiles", { error: profileError });
    throw new Error(`Failed to persist onboarding completion to profiles: ${profileError.message || profileError}`);
  }

  // 2. Persist to user_preferences
  const { error: prefsError } = await supabase.from("user_preferences").upsert(
    {
      user_id: userId,
      onboarding_completed: true,
      updated_at: completedAt,
    },
    { onConflict: "user_id" }
  );

  if (prefsError) {
    log.warn("Warning syncing onboarding_completed to user_preferences", { error: prefsError });
  }

  // 3. Immediately update and invalidate the dashboard SWR cache so route remount within 60s
  // does not show onboarding questions again.
  try {
    updateSwr<any>(`dashboard:${userId}`, (current) =>
      current ? { ...current, onboardingCompleted: true } : current
    );
  } catch {
    // SWR is in-memory client-side cache
  }
}
