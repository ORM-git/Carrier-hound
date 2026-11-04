/**
 * src/lib/billing/mode.ts
 *
 * Server-authoritative Razorpay payment mode detection and configuration validation.
 * Strictly prevents test-mode payments from granting real Pro access or add-on credits (Audit F01).
 *
 * Rules:
 * 1. Key ID prefix determines mode:
 *    - 'rzp_test_' -> 'test'
 *    - 'rzp_live_' -> 'live'
 *    - Anything else -> 'unknown'
 * 2. Client-supplied flags (e.g. testMode) are NEVER trusted.
 * 3. Environment configuration must be complete and non-conflicting.
 */

export type RazorpayPaymentMode = "test" | "live";

/**
 * Resolves the payment mode strictly from the Razorpay Key ID prefix.
 */
export function getRazorpayKeyMode(keyId?: string | null): RazorpayPaymentMode | "unknown" {
  if (!keyId || typeof keyId !== "string") return "unknown";
  const trimmed = keyId.trim();
  if (trimmed.startsWith("rzp_test_")) return "test";
  if (trimmed.startsWith("rzp_live_")) return "live";
  return "unknown";
}

/**
 * Validates server gateway credentials and resolves server payment mode.
 * Fails closed if keys are missing or invalid.
 */
export function resolveServerPaymentMode(
  keyId?: string | null,
  keySecret?: string | null
): { valid: boolean; mode?: RazorpayPaymentMode; error?: string; code?: string } {
  if (!keyId || !keySecret) {
    return {
      valid: false,
      error: "Razorpay credentials not configured",
      code: "RAZORPAY_CONFIG_MISSING",
    };
  }

  const mode = getRazorpayKeyMode(keyId);
  if (mode === "unknown") {
    return {
      valid: false,
      error: "Razorpay key configuration invalid: must start with rzp_test_ or rzp_live_",
      code: "RAZORPAY_CONFIG_INVALID",
    };
  }

  return { valid: true, mode };
}

/**
 * Validates webhook credentials and resolves expected server payment mode.
 * Fails closed if webhook secret or key configuration is missing/invalid.
 */
export function resolveWebhookPaymentMode(
  webhookSecret?: string | null,
  keyId?: string | null
): { valid: boolean; mode?: RazorpayPaymentMode; error?: string; code?: string } {
  if (!webhookSecret) {
    return {
      valid: false,
      error: "Razorpay webhook secret not configured",
      code: "WEBHOOK_SECRET_MISSING",
    };
  }

  const mode = getRazorpayKeyMode(keyId);
  if (mode === "unknown") {
    return {
      valid: false,
      error: "Server Razorpay key configuration invalid: must start with rzp_test_ or rzp_live_",
      code: "RAZORPAY_CONFIG_INVALID",
    };
  }

  return { valid: true, mode };
}
