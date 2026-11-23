/**
 * src/lib/auth/onboarding.ts
 *
 * Single Canonical Evaluator for Account Onboarding Completion across:
 * - Middleware (src/middleware.ts)
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
 * 5. Soft-deleted candidate_profiles / user_preferences rows never count, and the check never writes.
 *
 * Error Handling:
 * - Supabase errors in markAccountOnboardingCompleted are handled and surfaced (thrown)
 *   so callers only treat completion as persisted when the write actually succeeded.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "auth/onboarding" } });

/**
 * Missing `deleted_at` (pre-20261106h schema) is the only error that falls back to an unfiltered read.
 * Without that column the deletion handler hard-deletes instead of soft-deleting, so no row can be a
 * soft-deleted one; any other error is not treated as completion.
 */
function isMissingDeletedAtColumn(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  return (error.code === "42703" || error.code === "PGRST204") && msg.includes("deleted_at");
}

/** Reads one live (not soft-deleted) row for a table that has a `deleted_at` column. */
async function selectLiveRow(supabase: any, table: string, columns: string, userId: string): Promise<any | null> {
  const filtered = await supabase
    .from(table)
    .select(`${columns}, deleted_at`)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!filtered.error) {
    return filtered.data && !filtered.data.deleted_at ? filtered.data : null;
  }
  if (!isMissingDeletedAtColumn(filtered.error)) {
    log.warn(`Error querying ${table} for onboarding check`, { code: filtered.error.code });
    return null;
  }
  const legacy = await supabase.from(table).select(columns).eq("user_id", userId).maybeSingle();
  if (legacy.error || !legacy.data || legacy.data.deleted_at) return null;
  return legacy.data;
}

/**
 * Read-only: never writes completion (it runs during sign-in), and soft-deleted rows of a deleted or
 * partially deleted account never count. public.profiles has no deleted_at column (migration 20261114b);
 * the deletion handler removes the profiles row before any soft delete, so a stale marker cannot survive.
 */
export async function checkAccountOnboardingCompleted(
  supabase: SupabaseClient | any,
  userId: string
): Promise<boolean> {
  if (!supabase || !userId || typeof userId !== "string") {
    return false;
  }

  // 1. public.profiles (no deleted_at column)
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
        return true;
      }
    }
  } catch (err) {
    log.warn("Error querying profiles for onboarding check", { error: err });
  }

  // 2. public.candidate_profiles (live rows only)
  try {
    const candidate = await selectLiveRow(
      supabase,
      "candidate_profiles",
      "user_id, confirmed_at, skills, raw_resume_text, experience_json",
      userId
    );
    if (candidate) {
      const hasSubstantiveCandidate = Boolean(
        candidate.confirmed_at ||
          (Array.isArray(candidate.skills) && candidate.skills.length > 0) ||
          (candidate.raw_resume_text && String(candidate.raw_resume_text).trim().length > 0) ||
          (Array.isArray(candidate.experience_json) && candidate.experience_json.length > 0)
      );
      if (hasSubstantiveCandidate) {
        return true;
      }
    }
  } catch (err) {
    log.warn("Error querying candidate_profiles for onboarding check", { error: err });
  }

  // 3. public.user_preferences (live rows only). STRICT: onboarding_completed === true; partial answers do not count.
  try {
    const prefs = await selectLiveRow(supabase, "user_preferences", "user_id, onboarding_completed", userId);
    if (prefs && prefs.onboarding_completed === true) {
      return true;
    }
  } catch (err) {
    log.warn("Error querying user_preferences for onboarding check", { error: err });
  }

  return false;
}

/** Onboarding URL that carries an already-validated destination for afterwards. */
export function onboardingRedirectFor(destination: string): string {
  if (destination === "/onboarding" || destination.startsWith("/onboarding?")) return destination;
  return `/onboarding?next=${encodeURIComponent(destination)}`;
}

/**
 * The one post-sign-in rule for every email and Google path: completed accounts keep their (validated)
 * destination, everyone else goes to onboarding first. Never marks onboarding complete.
 */
export async function resolvePostAuthDestination(
  supabase: SupabaseClient | any,
  userId: string | null | undefined,
  destination: string
): Promise<string> {
  const completed = userId ? await checkAccountOnboardingCompleted(supabase, userId) : false;
  return completed ? destination : onboardingRedirectFor(destination);
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
}
