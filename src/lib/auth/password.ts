/**
 * Password validation rules for CareerMonke authentication.
 * Minimum 8 characters, maximum 128 characters, matching confirmation.
 */

export interface PasswordValidationResult {
  valid: boolean;
  error?: string;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Validates a single password against complexity requirements.
 */
export function validatePassword(password: string): PasswordValidationResult {
  if (!password || typeof password !== "string") {
    return { valid: false, error: "Password is required." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must not exceed ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return { valid: true };
}

/**
 * Validates a new password and confirmation pair for password reset or signup.
 */
export function validatePasswordReset(
  password: string,
  confirmPassword: string
): PasswordValidationResult {
  const pwCheck = validatePassword(password);
  if (!pwCheck.valid) {
    return pwCheck;
  }
  if (!confirmPassword || typeof confirmPassword !== "string") {
    return { valid: false, error: "Please confirm your password." };
  }
  if (password !== confirmPassword) {
    return { valid: false, error: "Passwords do not match." };
  }
  return { valid: true };
}

/**
 * Checks whether an error from Supabase auth indicates rate limiting.
 */
export function isAuthRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { status?: number; message?: string; code?: string };
  if (anyErr.status === 429) return true;
  const msg = (anyErr.message || "").toLowerCase();
  const code = (anyErr.code || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("over_email_send_rate_limit") ||
    msg.includes("security purposes") ||
    code.includes("over_email_send_rate_limit") ||
    code.includes("rate_limit")
  );
}

/**
 * Standard neutral message for forgot-password anti-enumeration.
 */
export const NEUTRAL_RESET_EMAIL_MESSAGE =
  "If an account exists for that email, we sent a reset link.";

/**
 * Friendly rate-limit error message.
 */
export const RATE_LIMIT_RESET_MESSAGE =
  "Too many requests. For security, please wait a few minutes before trying again.";
