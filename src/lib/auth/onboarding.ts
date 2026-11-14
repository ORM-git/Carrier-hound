/**
 * src/lib/auth/onboarding.ts
 *
 * Core logic for evaluating and persisting account onboarding completion.
 *
 * Rules:
 * 1. profiles.onboarding_completed_at IS NOT NULL -> completed.
 * 2. Existing users with saved profile:
 *    - profiles: full_name IS NOT NULL or target_roles non-empty -> completed.
 *    - candidate_profiles: confirmed_at IS NOT NULL, skills non-empty, or raw_resume_text non-empty -> completed.
 * 3. Existing users with saved preferences:
 *    - user_preferences: onboarding_completed = true or roles non-empty -> completed.
 * 4. Brand new accounts (no profile, no resume, no preferences) -> false (shows onboarding).
 *
 * When an existing user is detected via rule 2 or 3 but lacks profiles.onboarding_completed_at,
 * self-heals by stamping profiles.onboarding_completed_at so subsequent checks are single-table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
      const hasLegacyProfile = Boolean(
        (profile.full_name && String(profile.full_name).trim().length > 0) ||
          (Array.isArray(profile.target_roles) && profile.target_roles.length > 0)
      );
      if (hasLegacyProfile) {
        await markAccountOnboardingCompleted(supabase, userId).catch(() => {});
        return true;
      }
    }
  } catch {}

  // 2. Check public.candidate_profiles (existing users who confirmed a resume)
  try {
    const { data: candidate, error } = await supabase
      .from("candidate_profiles")
      .select("user_id, confirmed_at, skills, raw_resume_text")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && candidate) {
      const hasSavedCandidate = Boolean(
        candidate.confirmed_at ||
          (Array.isArray(candidate.skills) && candidate.skills.length > 0) ||
          (candidate.raw_resume_text && String(candidate.raw_resume_text).trim().length > 0)
      );
      if (hasSavedCandidate) {
        await markAccountOnboardingCompleted(supabase, userId).catch(() => {});
        return true;
      }
    }
  } catch {}

  // 3. Check public.user_preferences (existing users who configured job target roles/preferences)
  try {
    const { data: prefs, error } = await supabase
      .from("user_preferences")
      .select("user_id, onboarding_completed, roles")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && prefs) {
      const hasSavedPrefs = Boolean(
        prefs.onboarding_completed === true ||
          (Array.isArray(prefs.roles) && prefs.roles.length > 0)
      );
      if (hasSavedPrefs) {
        await markAccountOnboardingCompleted(supabase, userId).catch(() => {});
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Persists onboarding completion for an account.
 * Writes to public.profiles.onboarding_completed_at and public.user_preferences.onboarding_completed.
 */
export async function markAccountOnboardingCompleted(
  supabase: SupabaseClient | any,
  userId: string,
  completedAt: string = new Date().toISOString()
): Promise<void> {
  if (!supabase || !userId || typeof userId !== "string") {
    return;
  }

  // 1. Persist to profiles
  try {
    await supabase.from("profiles").upsert(
      {
        user_id: userId,
        onboarding_completed_at: completedAt,
      },
      { onConflict: "user_id" }
    );
  } catch {}

  // 2. Persist to user_preferences
  try {
    await supabase.from("user_preferences").upsert(
      {
        user_id: userId,
        onboarding_completed: true,
        updated_at: completedAt,
      },
      { onConflict: "user_id" }
    );
  } catch {}
}
