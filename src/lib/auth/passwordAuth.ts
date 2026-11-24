/**
 * Email/password auth helpers shared by /login, /signup and /auth/reset-password.
 * Messages never reveal whether an account exists or how it was created.
 */

export const MIN_PASSWORD_LENGTH = 8;

export function validateEmail(email: string): string | null {
  const clean = email.trim();
  return clean && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? null : "Please enter a valid email address.";
}

/** Client-side check only; Supabase's own password policy still applies server-side. */
export function validateNewPassword(password: string): string | null {
  return password.length >= MIN_PASSWORD_LENGTH
    ? null
    : `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
}

type AuthErrorLike = { code?: string; status?: number; message?: string } | null | undefined;

export function friendlyAuthError(error: AuthErrorLike, flow: "signin" | "signup" | "reset" | "update"): string {
  const code = error?.code || "";
  const message = (error?.message || "").toLowerCase();

  if (error?.status === 429 || code.startsWith("over_") || message.includes("rate limit")) {
    return "Too many attempts. Please wait a few minutes and try again.";
  }
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Please verify your email first. Check your inbox for the verification link.";
  }
  if (code === "weak_password" || message.includes("password should")) {
    return `Choose a stronger password (at least ${MIN_PASSWORD_LENGTH} characters, not a common one).`;
  }
  if (code === "same_password") {
    return "Your new password must be different from your current one.";
  }
  if (code === "email_provider_disabled" || code === "signup_disabled") {
    return "Email sign-in is not available right now. Please continue with Google.";
  }
  if (flow === "signup" && (code === "user_already_exists" || code === "email_exists")) {
    return "We couldn't create an account with this email. If you already have one, sign in instead.";
  }
  if (flow === "signin") {
    // Same message for wrong password, unknown email and Google-only accounts (no account enumeration).
    return "Incorrect email or password. If you joined with Google, use Continue with Google.";
  }
  if (flow === "update") {
    return "Could not update your password. Your reset link may have expired, so please request a new one.";
  }
  return "Something went wrong. Please try again.";
}
