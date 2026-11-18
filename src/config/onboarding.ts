/**
 * Single place feature flag and configuration for CareerMonke Onboarding.
 * Can be switched off either by changing ONBOARDING_FLOW_ENABLED to false
 * or via NEXT_PUBLIC_ONBOARDING_FLOW_ENABLED env variable.
 */

export const ONBOARDING_FLOW_ENABLED = true;

export function isOnboardingActive(): boolean {
  if (process.env.NEXT_PUBLIC_ONBOARDING_FLOW_ENABLED === "false") {
    return false;
  }
  if (process.env.NEXT_PUBLIC_ONBOARDING_FLOW_ENABLED === "true") {
    return true;
  }
  return ONBOARDING_FLOW_ENABLED;
}

/**
 * Feature flag for Onboarding Step 2 (LinkedIn URL and resume upload).
 * Rule "strict_true" (see src/lib/flags/flags.ts): ON only when the value is exactly "true".
 * Anything else, including "false", unset or a typo, is OFF. There are no client-side
 * overrides (no query string, no localStorage): a user cannot turn it on.
 */
export const ONBOARDING_STEP2_FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";

/**
 * Client/UI check. The literal process.env access is required so Next.js inlines the
 * build-time value into the browser bundle.
 */
export function isOnboardingStep2EnabledClient(): boolean {
  return process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED === "true";
}

/**
 * Server check for API routes. On Cloudflare Pages the runtime env binding
 * (getRequestContext().env) is authoritative when it defines the variable, so flipping
 * it to "false" in the Pages dashboard disables the endpoints without a rebuild.
 * Falls back to process.env only when the binding does not define it.
 */
export function isOnboardingStep2EnabledServer(cfEnv?: Record<string, unknown>): boolean {
  const bound = cfEnv?.[ONBOARDING_STEP2_FLAG];
  const raw = typeof bound === "string" ? bound : process.env[ONBOARDING_STEP2_FLAG];
  return raw === "true";
}

