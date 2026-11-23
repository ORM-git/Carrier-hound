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
import { getValidReturnUrl } from "./returnTo";

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

  // A deletion attempt is a durable recovery marker. Keep the surviving identity out of the
  // ordinary completed-account flow until its owner resolves the interrupted deletion.
  try {
    const { data: tombstone, error } = await supabase
      .from("deleted_account_tombstones")
      .select("user_id")
      .eq("user_id", userId)
      .is("purged_at", null)
      .maybeSingle();
    if (error) {
      if (error.code === "42501") {
        // Unprivileged client lacks direct SELECT grant (REVOKE ALL in migration 20261106h).
        // Proceed to profile check; server status endpoint & middleware enforce tombstones under server authority.
        log.warn("Client lacks direct SELECT grant on tombstones (42501); proceeding to profile check");
      } else if (!isMissingTombstoneTable(error)) {
        log.warn("Unable to verify account deletion state", { code: error.code });
        return false;
      }
    } else if (tombstone) {
      return false;
    }
  } catch (err) {
    log.warn("Unable to verify account deletion state", { error: err });
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

function isMissingTombstoneTable(error: any): boolean {
  const message = String(error?.message || "").toLowerCase();
  return (error?.code === "42P01" || error?.code === "PGRST205") && message.includes("deleted_account_tombstones");
}

/** Onboarding URL that carries an already-validated destination for afterwards. */
export function onboardingRedirectFor(destination: string): string {
  const safeDestination = getValidReturnUrl(destination);
  if (safeDestination === "/onboarding" || safeDestination.startsWith("/onboarding?")) return safeDestination;
  return `/onboarding?next=${encodeURIComponent(safeDestination)}`;
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
  const safeDestination = getValidReturnUrl(destination);
  if (!userId) return onboardingRedirectFor(safeDestination);

  // In browser, use authenticated server-side status contract to inspect deletion markers
  // under server authority and respect tombstone table RLS permissions (42501).
  if (typeof window !== "undefined" && typeof fetch === "function") {
    try {
      const sessionRes = await supabase?.auth?.getSession?.();
      const token = sessionRes?.data?.session?.access_token;
      if (sessionRes && (!sessionRes.data || !sessionRes.data.session?.access_token)) {
        // getSession completed and returned no active session/token.
        // Fail closed to onboarding rather than falling back to an RLS-blind direct check.
        log.warn("No session token available for browser status lookup; failing closed to onboarding");
        return onboardingRedirectFor(safeDestination);
      }
      if (token) {
        const res = await fetch("/api/account/status", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const status = await res.json();
          if (status.deletionPending) {
            return "/settings?tab=privacy&state=deletion_pending";
          }
          return status.onboardingCompleted ? safeDestination : onboardingRedirectFor(safeDestination);
        } else {
          // If status endpoint returns an error (e.g. 500/503), fail closed to onboarding.
          // Never fall back to unprivileged client-side check which is blinded by RLS 42501 on tombstones.
          log.warn("Server status check returned non-200 in browser; failing closed to onboarding", { status: res.status });
          return onboardingRedirectFor(safeDestination);
        }
      }
    } catch (err) {
      log.warn("Failed to query /api/account/status in browser, falling back to direct check", { error: err });
    }
  }

  const completed = await checkAccountOnboardingCompleted(supabase, userId);
  return completed ? safeDestination : onboardingRedirectFor(safeDestination);
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
