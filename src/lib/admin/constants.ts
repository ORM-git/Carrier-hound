export const ADMIN_EMAIL = "xbsuryakant@gmail.com";

export const ADMIN_EMAIL_LIST: readonly string[] = [ADMIN_EMAIL];

/**
 * Returns the normalized (lowercase) set of allowed admin emails.
 * Always includes ADMIN_EMAIL and any comma-separated addresses in ADMIN_EMAILS.
 */
export function getAdminEmailSet(): Set<string> {
  const emails = new Set<string>(
    ADMIN_EMAIL_LIST.map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  const rawEnv =
    typeof process !== "undefined" && process?.env?.ADMIN_EMAILS
      ? process.env.ADMIN_EMAILS
      : "";
  if (rawEnv) {
    for (const part of rawEnv.split(",")) {
      const normalized = part.trim().toLowerCase();
      if (normalized) {
        emails.add(normalized);
      }
    }
  }
  return emails;
}

export function isEmailInAdminList(email?: string | null): boolean {
  if (!email || typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return getAdminEmailSet().has(normalized);
}

/**
 * Checks whether a Supabase Auth user has a verified email address via server-owned
 * `email_confirmed_at` or `confirmed_at` timestamps only (never user_metadata).
 */
export function isUserEmailVerified(user: any): boolean {
  if (!user || typeof user !== "object") return false;
  if (typeof user.email_confirmed_at === "string" && user.email_confirmed_at.trim().length > 0) {
    return true;
  }
  if (typeof user.confirmed_at === "string" && user.confirmed_at.trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * Validates whether the authenticated Supabase user authenticated with Google.
 * Allows when the user has a linked Google identity (identities[].provider === "google",
 * app_metadata.providers includes "google", or app_metadata.provider === "google").
 * Confirmed email is still required by isVerifiedAdminUser.
 * Email-only accounts stay blocked.
 */
export function hasAdminGoogleProvider(user: any): boolean {
  if (!user || typeof user !== "object") return false;
  const provider = user.app_metadata?.provider;
  if (provider === "google") return true;

  if (Array.isArray(user.app_metadata?.providers)) {
    if (user.app_metadata.providers.includes("google")) return true;
  }

  if (Array.isArray(user.identities) && user.identities.length > 0) {
    const hasGoogle = user.identities.some((id: any) => id?.provider === "google");
    if (hasGoogle) return true;
  }

  return false;
}

/**
 * Server-side admin check:
 * - user's email must be in the admin list
 * - email_confirmed_at / confirmed_at must be set (never user_metadata)
 * - app_metadata provider/providers (or identities) must include google
 */
export function isVerifiedAdminUser(user: any): boolean {
  if (!user) return false;
  return (
    isEmailInAdminList(user.email) &&
    isUserEmailVerified(user) &&
    hasAdminGoogleProvider(user)
  );
}
