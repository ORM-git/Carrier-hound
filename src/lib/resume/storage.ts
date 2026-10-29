import { CandidateProfile } from "./types";
import { createClient } from "../supabase/client";
import type { TailoredJobResumeResult } from "./atsScorer";
import type { TailoredCoverLetterResult } from "./tailor";

const PROFILE_STORAGE_KEY = "careermonke_candidate_profile";


let memoizedProfile: CandidateProfile | null = null;
let profileInFlightPromise: Promise<CandidateProfile | null> | null = null;

type ProfileListener = (profile: CandidateProfile | null) => void;
const profileListeners = new Set<ProfileListener>();

export function subscribeCandidateProfile(listener: ProfileListener): () => void {
  profileListeners.add(listener);
  return () => {
    profileListeners.delete(listener);
  };
}

function emitProfileUpdate(profile: CandidateProfile | null) {
  profileListeners.forEach((fn) => {
    try {
      fn(profile);
    } catch (e) {
      console.warn("Profile listener error", e);
    }
  });
}

export function clearCandidateProfileMemoryCache() {
  memoizedProfile = null;
  profileInFlightPromise = null;
}

/**
 * Gets the confirmed candidate profile from local storage and Supabase.
 * Reads are strictly side-effect free: NEVER dispatches careermonke_profile_updated.
 * In-flight calls are deduplicated and in-memory results are memoized.
 * Returns null if the user has not uploaded and confirmed a resume.
 */
export async function getCandidateProfile(userId?: string): Promise<CandidateProfile | null> {
  // If a fetch is already in-flight, reuse it so concurrent calls coalesce into 1 request
  if (profileInFlightPromise) {
    return profileInFlightPromise;
  }

  profileInFlightPromise = (async () => {
    let profile: CandidateProfile | null = null;
    let resolvedUserId = userId;
    let userEmail: string | undefined = undefined;

    // Resolve authenticated Supabase user first to verify storage ownership
    try {
      const supabase = createClient();
      if (!resolvedUserId) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          resolvedUserId = session.user.id;
          userEmail = session.user.email;
        } else {
          const { data: { user } } = await supabase.auth.getUser();
          resolvedUserId = user?.id;
          userEmail = user?.email;
        }
      }
    } catch (err) {}

    // Check memoized profile against resolved user id
    if (memoizedProfile) {
      const cachedOwner = memoizedProfile.ownerUserId || memoizedProfile.userId;
      if (resolvedUserId && cachedOwner && cachedOwner !== resolvedUserId) {
        memoizedProfile = null;
      } else if (resolvedUserId && !cachedOwner) {
        memoizedProfile = null;
      } else if (!resolvedUserId && cachedOwner) {
        memoizedProfile = null;
      } else if (memoizedProfile.confirmedAt) {
        return memoizedProfile;
      }
    }

    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          const storedOwnerId = parsed?.ownerUserId || parsed?.userId || null;

          if (resolvedUserId && storedOwnerId && storedOwnerId !== resolvedUserId) {
            // Mismatch: profile belongs to a different user! Ignore and purge from storage
            localStorage.removeItem(PROFILE_STORAGE_KEY);
            memoizedProfile = null;
            profile = null;
          } else if (resolvedUserId && !storedOwnerId) {
            // Legacy / unowned cache when logged in: clear to prevent account contamination
            localStorage.removeItem(PROFILE_STORAGE_KEY);
            memoizedProfile = null;
            profile = null;
          } else if (!resolvedUserId && storedOwnerId) {
            // User profile stored, but current viewer is unauthenticated guest: ignore
            profile = null;
          } else if (parsed && parsed.confirmedAt) {
            profile = parsed;
            memoizedProfile = parsed;
          }
        }
      } catch (e) {
        console.warn("Could not read local candidate profile", e);
      }
    }

    // Try fetching from Supabase if logged in
    try {
      if (resolvedUserId) {
        const supabase = createClient();
        const queryPromise = supabase
          .from("candidate_profiles")
          .select("*")
          .eq("user_id", resolvedUserId)
          .maybeSingle();

        const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error("Profile query timeout") }), 4000)
        );

        const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

        if (!error && data && data.confirmed_at) {
          const remoteProfile: CandidateProfile = {
            name: data.name || profile?.name || "",
            email: data.email || userEmail || profile?.email || "",
            phone: data.phone || profile?.phone || "",
            location: data.location || profile?.location || "",
            headline: data.headline || profile?.headline || "",
            summary: data.summary || profile?.summary || "",
            skills: data.skills || profile?.skills || [],
            experience: data.experience_json || profile?.experience || [],
            education: data.education_json || profile?.education || [],
            certifications: data.certifications || profile?.certifications || [],
            rawText: data.raw_resume_text || profile?.rawText || "",
            confirmedAt: data.confirmed_at,
            updatedAt: data.updated_at,
            ownerUserId: resolvedUserId,
            userId: resolvedUserId,
          };
          // CRITICAL: Silent local write only (reads are side-effect free, NEVER dispatch profile_updated)
          saveCandidateProfileLocally(remoteProfile, false, resolvedUserId);
          memoizedProfile = remoteProfile;
          return remoteProfile;
        }
      }
    } catch (err) {}

    memoizedProfile = profile;
    return profile;
  })().finally(() => {
    profileInFlightPromise = null;
  });

  return profileInFlightPromise;
}

/**
 * Saves candidate profile to local storage.
 */
export function saveCandidateProfileLocally(
  profile: CandidateProfile,
  dispatchEvent = true,
  ownerId?: string | null
) {
  if (typeof window !== "undefined") {
    try {
      const resolvedOwnerId =
        ownerId !== undefined ? ownerId : (profile.ownerUserId || profile.userId || null);

      const profileToSave: CandidateProfile = {
        ...profile,
        ownerUserId: resolvedOwnerId,
        userId: resolvedOwnerId,
      };

      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileToSave));
      memoizedProfile = profileToSave;
      if (dispatchEvent) {
        window.dispatchEvent(new Event("careermonke_profile_updated"));
        emitProfileUpdate(profileToSave);
      }
    } catch (e) {
      console.warn("Could not save candidate profile locally", e);
    }
  }
}

/**
 * Saves confirmed candidate profile to both local storage and Supabase
 */
export async function saveConfirmedCandidateProfile(profile: CandidateProfile): Promise<void> {
  const supabase = createClient();
  let sessionUser = null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    sessionUser = session?.user || (await supabase.auth.getUser()).data.user;
  } catch (e) {
    // ignore
  }

  const ownerUserId = sessionUser?.id || profile.ownerUserId || profile.userId || null;

  const updatedProfile: CandidateProfile = {
    ...profile,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerUserId,
    userId: ownerUserId,
  };

  saveCandidateProfileLocally(updatedProfile, true, ownerUserId);

  if (sessionUser) {
    const payload: any = {
      user_id: sessionUser.id,
      name: updatedProfile.name,
      email: updatedProfile.email || sessionUser.email,
      phone: updatedProfile.phone,
      headline: updatedProfile.headline,
      summary: updatedProfile.summary,
      skills: updatedProfile.skills,
      experience_json: updatedProfile.experience,
      education_json: updatedProfile.education,
      certifications: updatedProfile.certifications,
      raw_resume_text: updatedProfile.rawText,
      confirmed_at: updatedProfile.confirmedAt,
      updated_at: updatedProfile.updatedAt,
    };

    if (updatedProfile.location) {
      payload.location = updatedProfile.location;
    }

    let { error } = await supabase.from("candidate_profiles").upsert(payload);

    // If live table doesn't have location column yet, retry without location
    if (error && (error.message?.includes("location") || error.code === "42703")) {
      delete payload.location;
      const retry = await supabase.from("candidate_profiles").upsert(payload);
      error = retry.error;
    }

    if (error) {
      console.error("Failed to sync candidate profile to Supabase:", error);
      throw new Error("Failed to save candidate profile to database: " + error.message);
    }
  }
}

export const saveCandidateProfileToSupabase = saveConfirmedCandidateProfile;

/**
 * Deletes candidate profile from local storage and Supabase
 */
export async function deleteCandidateProfile(): Promise<void> {
  clearCandidateProfileMemoryCache();
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(PROFILE_STORAGE_KEY);
      window.dispatchEvent(new Event("careermonke_profile_updated"));
      emitProfileUpdate(null);
    } catch (e) {
      console.warn("Could not remove local candidate profile", e);
    }
  }

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("candidate_profiles").delete().eq("user_id", user.id);
    }
  } catch (err) {
    console.warn("Could not delete candidate profile from Supabase", err);
  }
}

export const TAILORED_RESUME_PREFIX = "careermonke_tailored_resume_";
export const TAILORED_COVER_LETTER_PREFIX = "careermonke_tailored_cover_letter_";

export function getScopedTailoredResumeKey(jobId: string, ownerId?: string | null): string | null {
  const resolvedOwner = ownerId?.trim() || null;
  if (!resolvedOwner) return null;
  if (resolvedOwner === "guest") {
    return `${TAILORED_RESUME_PREFIX}guest_${jobId}`;
  }
  return `${TAILORED_RESUME_PREFIX}${resolvedOwner}_${jobId}`;
}

export function getScopedTailoredCoverLetterKey(jobId: string, ownerId?: string | null): string | null {
  const resolvedOwner = ownerId?.trim() || null;
  if (!resolvedOwner) return null;
  if (resolvedOwner === "guest") {
    return `${TAILORED_COVER_LETTER_PREFIX}guest_${jobId}`;
  }
  return `${TAILORED_COVER_LETTER_PREFIX}${resolvedOwner}_${jobId}`;
}

/**
 * Gets cached job-specific tailored resume from localStorage (synchronous).
 * Scoped by verified authenticated Supabase user ID to prevent cross-account contamination.
 * Unowned legacy keys are never attached or read by signed-in accounts.
 */
export function getCachedTailoredResume(
  jobId: string,
  expectedHash?: string,
  ownerId?: string | null
): TailoredJobResumeResult | null {
  if (typeof window === "undefined" || !jobId) return null;
  try {
    const storageKey = getScopedTailoredResumeKey(jobId, ownerId);
    if (!storageKey) return null;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as TailoredJobResumeResult;
      if (parsed.tailoringSource === "ai") {
        if (expectedHash && parsed.sourceHash && parsed.sourceHash !== expectedHash) {
          localStorage.removeItem(storageKey);
          return null;
        }
        if (parsed.operationVersion && parsed.operationVersion !== "1.0") {
          localStorage.removeItem(storageKey);
          return null;
        }
      }
      return parsed;
    }
  } catch (e) {
    console.warn(`Could not read cached tailored resume for ${jobId}`, e);
  }
  return null;
}

/**
 * Persists job-specific tailored resume into scoped localStorage and Supabase.
 */
export function saveCachedTailoredResume(
  jobId: string,
  data: TailoredJobResumeResult,
  ownerId?: string | null
): void {
  if (typeof window === "undefined" || !jobId) return;
  const resolvedOwner = ownerId?.trim() || null;
  const storageKey = getScopedTailoredResumeKey(jobId, resolvedOwner);
  if (!storageKey) {
    console.warn(`[TailoredCache] Refusing to persist tailored resume for ${jobId}: explicit verified owner or "guest" required; missing owner will not be saved as guest work.`);
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch (e) {
    console.warn(`Could not save cached tailored resume for ${jobId}`, e);
  }

  // Asynchronously persist to Supabase for multi-device / multi-user persistence if authenticated
  if (resolvedOwner && resolvedOwner !== "guest") {
    saveTailoredResumeToSupabase(jobId, data, resolvedOwner).catch((err) => {
      console.warn(`Could not sync tailored resume to Supabase for ${jobId}:`, err);
    });
  }
}

/**
 * Persists tailored resume directly to Supabase table `tailored_resumes`.
 */
export async function saveTailoredResumeToSupabase(
  jobId: string,
  data: TailoredJobResumeResult,
  ownerId?: string | null
): Promise<void> {
  const resolvedOwner = ownerId?.trim() || null;
  if (!resolvedOwner || resolvedOwner === "guest") return; // Guests never persist to Supabase user tables

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== resolvedOwner) return;

    await supabase.from("tailored_resumes").upsert(
      {
        user_id: user.id,
        job_id: jobId,
        job_title: data.jobTitle,
        company: data.company,
        ats_score: data.atsScore,
        tailored_data: data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id, job_id" }
    );
  } catch (err) {
    // Graceful fallback if table is not yet migrated or user is offline
  }
}

/**
 * Fetches tailored resume from Supabase if not found locally.
 */
export async function getTailoredResumeAsync(
  jobId: string,
  expectedHash?: string,
  ownerId?: string | null
): Promise<TailoredJobResumeResult | null> {
  const resolvedOwner = ownerId?.trim() || null;
  const local = getCachedTailoredResume(jobId, expectedHash, resolvedOwner);
  if (local) return local;

  if (!resolvedOwner) return null; // Guests do not have Supabase remote storage

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== resolvedOwner) return null;

    const { data, error } = await supabase
      .from("tailored_resumes")
      .select("tailored_data")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .maybeSingle();

    if (!error && data?.tailored_data) {
      const parsed = data.tailored_data as TailoredJobResumeResult;
      if (parsed.tailoringSource === "ai") {
        if (expectedHash && parsed.sourceHash && parsed.sourceHash !== expectedHash) {
          return null;
        }
        if (parsed.operationVersion && parsed.operationVersion !== "1.0") {
          return null;
        }
      }
      if (typeof window !== "undefined") {
        const storageKey = getScopedTailoredResumeKey(jobId, resolvedOwner);
        if (storageKey) {
          localStorage.setItem(storageKey, JSON.stringify(parsed));
        }
      }
      return parsed;
    }
  } catch (err) {}

  return null;
}

/**
 * Gets cached job-specific cover letter from localStorage (synchronous).
 * Scoped by verified authenticated Supabase user ID.
 */
export function getCachedTailoredCoverLetter(
  jobId: string,
  ownerId?: string | null
): TailoredCoverLetterResult | null {
  if (typeof window === "undefined" || !jobId) return null;
  try {
    const storageKey = getScopedTailoredCoverLetterKey(jobId, ownerId);
    if (!storageKey) return null;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`Could not read cached tailored cover letter for ${jobId}`, e);
  }
  return null;
}

/**
 * Persists job-specific cover letter into scoped localStorage and Supabase.
 */
export function saveCachedTailoredCoverLetter(
  jobId: string,
  data: TailoredCoverLetterResult,
  ownerId?: string | null
): void {
  if (typeof window === "undefined" || !jobId) return;
  const resolvedOwner = ownerId?.trim() || null;
  const storageKey = getScopedTailoredCoverLetterKey(jobId, resolvedOwner);
  if (!storageKey) {
    console.warn(`[TailoredCache] Refusing to persist tailored cover letter for ${jobId}: explicit verified owner or "guest" required; missing owner will not be saved as guest work.`);
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch (e) {
    console.warn(`Could not save cached tailored cover letter for ${jobId}`, e);
  }

  // Asynchronously persist to Supabase for multi-device / multi-user persistence if authenticated
  if (resolvedOwner && resolvedOwner !== "guest") {
    saveTailoredCoverLetterToSupabase(jobId, data, resolvedOwner).catch((err) => {
      console.warn(`Could not sync tailored cover letter to Supabase for ${jobId}:`, err);
    });
  }
}

/**
 * Persists tailored cover letter directly to Supabase table `tailored_resumes`.
 */
export async function saveTailoredCoverLetterToSupabase(
  jobId: string,
  data: TailoredCoverLetterResult,
  ownerId?: string | null
): Promise<void> {
  const resolvedOwner = ownerId?.trim() || null;
  if (!resolvedOwner || resolvedOwner === "guest") return;

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== resolvedOwner) return;

    await supabase.from("tailored_resumes").upsert(
      {
        user_id: user.id,
        job_id: jobId,
        job_title: data.jobTitle,
        company: data.company,
        cover_letter_data: data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id, job_id" }
    );
  } catch (err) {
    // Graceful fallback if table is not yet migrated or offline
  }
}

/**
 * Fetches tailored cover letter from Supabase if not found locally.
 */
export async function getTailoredCoverLetterAsync(
  jobId: string,
  ownerId?: string | null
): Promise<TailoredCoverLetterResult | null> {
  const resolvedOwner = ownerId?.trim() || null;
  const local = getCachedTailoredCoverLetter(jobId, resolvedOwner);
  if (local) return local;

  if (!resolvedOwner) return null;

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== resolvedOwner) return null;

    const { data, error } = await supabase
      .from("tailored_resumes")
      .select("cover_letter_data")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .maybeSingle();

    if (!error && data?.cover_letter_data) {
      const parsed = data.cover_letter_data as TailoredCoverLetterResult;
      if (typeof window !== "undefined") {
        const storageKey = getScopedTailoredCoverLetterKey(jobId, resolvedOwner);
        if (storageKey) {
          localStorage.setItem(storageKey, JSON.stringify(parsed));
        }
      }
      return parsed;
    }
  } catch (err) {}

  return null;
}

