/**
 * src/lib/onboarding/firstJobsExperience.ts
 *
 * Account-scoped first-Jobs experience state management:
 * - Validates A's first-run marker
 * - Manages account+version dismissal for welcome modal and guided tour
 * - Safely degrades on storage denial / SSR
 */

import {
  hasFirstJobsMarker,
  clearFirstJobsMarker,
  setFirstJobsMarker,
} from "@/components/onboarding/onboardingMarkers";

export { setFirstJobsMarker, hasFirstJobsMarker, clearFirstJobsMarker };

export const FIRST_JOBS_EXPERIENCE_VERSION = "v1";

const WELCOME_DISMISSED_KEY_PREFIX = "cm_jobs_welcome_dismissed_";
const TOUR_DISMISSED_KEY_PREFIX = "cm_jobs_tour_dismissed_";

export function getWelcomeDismissedKey(userId: string): string {
  return `${WELCOME_DISMISSED_KEY_PREFIX}${userId}_${FIRST_JOBS_EXPERIENCE_VERSION}`;
}

export function getTourDismissedKey(userId: string): string {
  return `${TOUR_DISMISSED_KEY_PREFIX}${userId}_${FIRST_JOBS_EXPERIENCE_VERSION}`;
}

export function isWelcomeDismissed(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    const key = getWelcomeDismissedKey(userId);
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function markWelcomeDismissed(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const key = getWelcomeDismissedKey(userId);
    localStorage.setItem(key, "true");
  } catch {}
}

export function isTourDismissed(userId: string): boolean {
  if (typeof window === "undefined" || !userId) return false;
  try {
    const key = getTourDismissedKey(userId);
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function markTourDismissed(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const key = getTourDismissedKey(userId);
    localStorage.setItem(key, "true");
  } catch {}
}

/**
 * Validates whether the first-run welcome modal should trigger:
 * - Window must be defined (no SSR execution)
 * - userId must be present and verified
 * - Tab must be recommended tab
 * - Must NOT be edit mode
 * - A's first-run marker must be present
 * - Welcome modal must not have been previously dismissed
 */
export function shouldShowFirstJobsWelcome({
  userId,
  isVerifiedUser,
  isRecommendedTab,
  isEditMode,
}: {
  userId?: string | null;
  isVerifiedUser: boolean;
  isRecommendedTab: boolean;
  isEditMode?: boolean;
}): boolean {
  if (typeof window === "undefined" || !userId || !isVerifiedUser) {
    return false;
  }
  if (!isRecommendedTab || isEditMode) {
    return false;
  }
  if (!hasFirstJobsMarker(userId)) {
    return false;
  }
  if (isWelcomeDismissed(userId)) {
    return false;
  }
  return true;
}

/**
 * Consumes the first-run marker once the welcome flow completes or is dismissed,
 * ensuring returning visits or ordinary logins never re-trigger welcome.
 */
export function consumeFirstRunMarker(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  clearFirstJobsMarker(userId);
  markWelcomeDismissed(userId);
}
