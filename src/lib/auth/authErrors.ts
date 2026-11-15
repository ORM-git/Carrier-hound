/**
 * Maps raw auth errors (such as Supabase GoTrue rate limits) into friendly,
 * actionable user-facing error messages without altering form layout.
 */

export const FRIENDLY_AUTH_RATE_LIMIT_SIGNUP =
  "Too many sign-up attempts. Please try again later, or continue with Google.";

export const FRIENDLY_AUTH_RATE_LIMIT_LOGIN =
  "Too many sign-in attempts. Please try again later, or continue with Google.";

export const FRIENDLY_AUTH_RATE_LIMIT_SIGNUP_GOOGLE =
  "Too many sign-up attempts. Please try again later.";

export const FRIENDLY_AUTH_RATE_LIMIT_LOGIN_GOOGLE =
  "Too many sign-in attempts. Please try again later.";

export function formatAuthError(
  rawError: string | null | undefined,
  isSignup = false,
  isGoogle = false
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
    const isGoogleFlow = isGoogle || lower.includes("google") || lower.includes("oauth");
    if (isGoogleFlow) {
      return isSignup
        ? FRIENDLY_AUTH_RATE_LIMIT_SIGNUP_GOOGLE
        : FRIENDLY_AUTH_RATE_LIMIT_LOGIN_GOOGLE;
    }
    return isSignup
      ? FRIENDLY_AUTH_RATE_LIMIT_SIGNUP
      : FRIENDLY_AUTH_RATE_LIMIT_LOGIN;
  }

  return trimmed;
}
