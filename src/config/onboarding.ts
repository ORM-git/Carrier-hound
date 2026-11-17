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
