/**
 * Maps raw auth errors (such as Supabase GoTrue rate limits) into friendly,
 * actionable user-facing error messages without altering form layout.
 */

export const FRIENDLY_AUTH_RATE_LIMIT_SIGNUP =
  "Too many sign-up attempts. Please wait a few minutes before trying again, or continue with Google.";

export const FRIENDLY_AUTH_RATE_LIMIT_LOGIN =
  "Too many sign-in attempts. Please wait a few minutes before trying again, or continue with Google.";

export function formatAuthError(
  rawError: string | null | undefined,
  isSignup = false
): string {
  if (!rawError || typeof rawError !== "string") return "";

  const trimmed = rawError.trim();
  const lower = trimmed.toLowerCase();

  // Supabase GoTrue raw rate limit error messages & status codes
  if (
    lower.includes("email rate limit exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("over_email_send_rate_limit") ||
    lower.includes("over_request_rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return isSignup
      ? FRIENDLY_AUTH_RATE_LIMIT_SIGNUP
      : FRIENDLY_AUTH_RATE_LIMIT_LOGIN;
  }

  return trimmed;
}
