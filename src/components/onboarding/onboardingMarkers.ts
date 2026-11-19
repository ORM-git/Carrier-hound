/**
 * Account-scoped first-Jobs marker helpers
 *
 * Tracks whether a user has successfully finished their first-run onboarding.
 * Strictly account-scoped by userId; never set in edit mode or when save fails.
 */

export const FIRST_JOBS_MARKER_PREFIX = "cm_first_jobs_";

export function getFirstJobsMarkerKey(userId: string): string {
  return `${FIRST_JOBS_MARKER_PREFIX}${userId}`;
}

export function setFirstJobsMarker(userId: string): void {
  try {
    const key = getFirstJobsMarkerKey(userId);
    localStorage.setItem(key, "true");
    sessionStorage.setItem(key, "true");
  } catch {}
}

export function hasFirstJobsMarker(userId: string): boolean {
  try {
    const key = getFirstJobsMarkerKey(userId);
    return (
      localStorage.getItem(key) === "true" ||
      sessionStorage.getItem(key) === "true"
    );
  } catch {
    return false;
  }
}

export function clearFirstJobsMarker(userId: string): void {
  try {
    const key = getFirstJobsMarkerKey(userId);
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch {}
}
