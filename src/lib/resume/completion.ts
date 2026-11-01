import type { CandidateProfile } from "./types";

export interface ProfileCompletionPreferences {
  onboardingCompleted?: boolean;
  roles?: string[];
}

export interface ProfileCompletionInput {
  candidate?: CandidateProfile | null;
  preferences?: ProfileCompletionPreferences | null;
  savedJobIds?: string[] | null;
}

export interface ProfileCompletionResult {
  hasResume: boolean;
  hasPreferences: boolean;
  hasTracked: boolean;
  completedSteps: number;
  totalSteps: number;
  completionPercentage: number;
}

/**
 * Derives candidate profile and onboarding completion strictly from verified user data.
 * - Step 1 (Resume): Requires candidate.confirmedAt AND non-empty skills, experience, or rawText.
 * - Step 2 (Preferences): Requires preferences.onboardingCompleted OR non-empty roles.
 * - Step 3 (Tracked Jobs): Requires at least one saved/tracked job ID.
 *
 * Completion percentage is strictly integer Math.round((completedSteps / 3) * 100).
 * Fresh accounts with no resume never report 100% or tick Step 1.
 */
export function calculateProfileCompletion(input: ProfileCompletionInput): ProfileCompletionResult {
  const candidate = input.candidate;
  const preferences = input.preferences;
  const savedJobIds = input.savedJobIds;

  const hasResume = Boolean(
    candidate?.confirmedAt &&
      ((candidate.skills && candidate.skills.length > 0) ||
        (candidate.experience && candidate.experience.length > 0) ||
        (candidate.rawText && candidate.rawText.trim().length > 0))
  );

  const hasPreferences = Boolean(
    preferences?.onboardingCompleted ||
      (preferences?.roles && preferences.roles.length > 0)
  );

  const hasTracked = Boolean(savedJobIds && savedJobIds.length > 0);

  const completedSteps = [hasResume, hasPreferences, hasTracked].filter(Boolean).length;
  const totalSteps = 3;
  const completionPercentage = Math.round((completedSteps / totalSteps) * 100);

  return {
    hasResume,
    hasPreferences,
    hasTracked,
    completedSteps,
    totalSteps,
    completionPercentage,
  };
}
