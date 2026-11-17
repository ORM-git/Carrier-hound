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
 * Feature flag for Onboarding Step 2 (LinkedIn URL and Resume Upload).
 * When false, the Step 2 screen displays both cards as "Coming soon" with "Skip for now".
 * Controlled via ONBOARDING_STEP2_ENABLED code toggle or NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED env var.
 */
export const ONBOARDING_STEP2_ENABLED = true;

export function isOnboardingStep2Active(): boolean {
  if (typeof window !== "undefined") {
    try {
      const urlOverride = new URLSearchParams(window.location.search).get("step2_enabled");
      if (urlOverride === "false") return false;
      if (urlOverride === "true") return true;
      const storageOverride = localStorage.getItem("careermonke_flag_step2");
      if (storageOverride === "false") return false;
      if (storageOverride === "true") return true;
    } catch {
      // Ignore URL / localStorage errors
    }
  }

  if (process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED === "false") {
    return false;
  }
  if (process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED === "true") {
    return true;
  }
  return ONBOARDING_STEP2_ENABLED;
}

