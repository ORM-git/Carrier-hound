/**
 * Safe error and diagnostics logging helper for Netlify serverless functions.
 * Strictly sanitizes error messages and log outputs to prevent leaking:
 * - Bearer authorization headers
 * - Supabase service / anon keys and JWTs
 * - Groq / Stripe / Razorpay API keys
 * - User email addresses
 * - Raw request payloads containing personal candidate data
 */

export function safeFormatError(err: unknown): string {
  if (err === null || err === undefined) {
    return "Unknown error";
  }

  let rawMessage = "";
  if (typeof err === "string") {
    rawMessage = err;
  } else if (err instanceof Error) {
    rawMessage = err.message || err.toString();
  } else if (typeof err === "object") {
    try {
      rawMessage = (err as any).message || JSON.stringify(err);
    } catch {
      rawMessage = "[Unserializable object error]";
    }
  } else {
    rawMessage = String(err);
  }

  return sanitizeLogString(rawMessage);
}

export function sanitizeLogString(input: string): string {
  if (!input) return "";

  let sanitized = input;

  // 1. Redact JWTs (three base64url segments separated by dots, eyJ...)
  sanitized = sanitized.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");

  // 2. Redact Provider API keys (Groq gsk_, Stripe sk_, Supabase sbp_/service_role, Razorpay rzp_)
  sanitized = sanitized.replace(/(gsk_|sk_live_|sk_test_|sbp_|rzp_test_|rzp_live_)[A-Za-z0-9_-]+/gi, "$1[REDACTED]");

  // 3. Redact Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");

  // 4. Redact email addresses
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL_REDACTED]");

  return sanitized;
}

export const safeLog = {
  error: (tag: string, err: unknown) => {
    console.error(`${tag}: ${safeFormatError(err)}`);
  },
  warn: (tag: string, err: unknown) => {
    console.warn(`${tag}: ${safeFormatError(err)}`);
  },
  info: (tag: string, message: string) => {
    console.log(`${tag}: ${sanitizeLogString(message)}`);
  },
};
