"use client";

import { useState, useEffect } from "react";
import { CandidateProfile } from "./types";
import {
  getCandidateProfile,
  subscribeCandidateProfile,
} from "./storage";

/**
 * Shared memoized candidate profile hook for React components.
 * Reads from memory/localStorage first. Ensures at most one fetch per page load.
 * Only re-renders when a genuine user-initiated save or delete occurs.
 */
export function useSharedCandidateProfile(
  overrideProfile?: CandidateProfile | null
): CandidateProfile | null {
  const [profile, setProfile] = useState<CandidateProfile | null>(() => {
    if (overrideProfile !== undefined) {
      return overrideProfile;
    }
    return null;
  });

  useEffect(() => {
    // If the parent explicitly provided a profile (e.g. /jobs page passing candidate),
    // we use that directly and never fetch or attach redundant listeners.
    if (overrideProfile !== undefined) {
      setProfile(overrideProfile);
      return;
    }

    let active = true;

    // Fetch once via memoized storage (coalesces into single fetch across all badges)
    getCandidateProfile().then((p) => {
      if (active) {
        setProfile(p);
      }
    });

    // Subscribe to genuine profile mutations (profile confirmed / profile deleted)
    const unsubscribe = subscribeCandidateProfile((updated) => {
      if (active) {
        setProfile(updated);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [overrideProfile]);

  return profile;
}
