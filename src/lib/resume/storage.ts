import { CandidateProfile } from "./types";
import { createClient } from "../supabase/client";
import type { TailoredJobResumeResult } from "./atsScorer";
import {
  type TailoredCoverLetterResult,
  computeCandidateFactsHash,
  computeJobHash,
} from "./tailor";

const PROFILE_STORAGE_KEY = "careermonke_candidate_profile";

/**
 * Default sample profile when a candidate hasn't uploaded a resume yet.
 */
export const DEFAULT_CANDIDATE_PROFILE: CandidateProfile = {
  name: "Software Engineer",
  email: "",
  phone: "",
  location: "Remote / Global",
  headline: "Full-Stack Software Engineer",
  summary: "Results-driven Software Engineer experienced in building resilient web applications, designing backend APIs, and deploying modern cloud systems. Passionate about clean code, high performance, and rapid product delivery.",
  skills: [
    "JavaScript", "TypeScript", "React", "Next.js", "Node.js", "PostgreSQL", "SQL", "Git", "REST API", "Docker", "Tailwind CSS"
  ],
  experience: [
    {
      id: "exp-sample-1",
      company: "Tech Systems",
      role: "Full-Stack Developer",
      startDate: "2022",
      endDate: "Present",
      bullets: [
        "Architected scalable web applications using React, TypeScript, and Node.js microservices.",
        "Optimized database queries and API response times, improving page performance by 35%.",
        "Collaborated with cross-functional product and design teams to deliver weekly releases."
      ],
      needsReview: false
    }
  ],
  education: [
    {
      id: "edu-sample-1",
      degree: "Bachelor of Science in Computer Science",
      institution: "State University",
      year: "2022",
      needsReview: false
    }
  ],
  certifications: ["AWS Certified Cloud Practitioner"],
  updatedAt: new Date().toISOString()
};

export function getCandidateProfileStorageKey(userId?: string | null): string {
  if (userId && userId.trim()) {
    return `careermonke_candidate_profile_${userId.trim()}`;
  }
  return PROFILE_STORAGE_KEY;
}

let memoizedProfile: CandidateProfile | null = null;
let memoizedUserId: string | null = null;
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
  memoizedUserId = null;
  profileInFlightPromise = null;
}

/**
 * Gets the confirmed candidate profile from local storage and Supabase.
 * Reads are strictly side-effect free: NEVER dispatches careermonke_profile_updated.
 * In-flight calls are deduplicated and in-memory results are memoized by user ID.
 * Returns null if the user has not uploaded and confirmed a resume.
 */
export async function getCandidateProfile(userId?: string, clientOverride?: any): Promise<CandidateProfile | null> {
  // 1. Return in-memory memoized profile immediately if available for this specific user
  if (userId && memoizedUserId === userId && memoizedProfile && memoizedProfile.confirmedAt) {
    return memoizedProfile;
  }

  // 2. If a fetch is already in-flight, reuse it so concurrent calls coalesce into 1 request
  if (profileInFlightPromise) {
    return profileInFlightPromise;
  }

  profileInFlightPromise = (async () => {
    let resolvedUserId = userId;
    let userEmail: string | undefined = undefined;

    const getSupabase = () => clientOverride || createClient();

    // Resolve active session user if userId was not provided
    try {
      if (!resolvedUserId) {
        const supabase = getSupabase();
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
    } catch {
      // Unauthenticated or test context
    }

    // 3. Check in-memory memoized profile for the resolved user
    if (resolvedUserId && memoizedUserId === resolvedUserId && memoizedProfile?.confirmedAt) {
      return memoizedProfile;
    }

    // Guest / unauthenticated users have no confirmed candidate profile
    if (!resolvedUserId) {
      memoizedProfile = null;
      memoizedUserId = null;
      return null;
    }

    const scopedKey = getCandidateProfileStorageKey(resolvedUserId);

    // 4. Try fetching from Supabase for this specific user
    try {
      const supabase = getSupabase();
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
          name: data.name || "",
          email: data.email || userEmail || "",
          phone: data.phone || "",
          location: data.location || "",
          headline: data.headline || "",
          summary: data.summary || "",
          skills: data.skills || [],
          experience: data.experience_json || [],
          education: data.education_json || [],
          certifications: data.certifications || [],
          rawText: data.raw_resume_text || "",
          confirmedAt: data.confirmed_at,
          updatedAt: data.updated_at,
        };
        // CRITICAL: Silent local write only (reads are side-effect free, NEVER dispatch profile_updated)
        saveCandidateProfileLocally(remoteProfile, false, resolvedUserId);
        memoizedProfile = remoteProfile;
        memoizedUserId = resolvedUserId;
        return remoteProfile;
      }
    } catch (err) {
      console.warn("Could not fetch remote candidate profile from Supabase:", err);
    }

    // 5. If Supabase has no confirmed row, check strictly user-scoped localStorage
    if (typeof window !== "undefined") {
      try {
        // Clean up legacy un-scoped key if present to prevent cross-account leak
        if (localStorage.getItem(PROFILE_STORAGE_KEY)) {
          localStorage.removeItem(PROFILE_STORAGE_KEY);
        }

        const stored = localStorage.getItem(scopedKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.confirmedAt) {
            memoizedProfile = parsed;
            memoizedUserId = resolvedUserId;
            return parsed;
          }
        }
      } catch (e) {
        console.warn("Could not read local candidate profile", e);
      }
    }

    // Fresh accounts start completely empty
    memoizedProfile = null;
    memoizedUserId = resolvedUserId;
    return null;
  })().finally(() => {
    profileInFlightPromise = null;
  });

  return profileInFlightPromise;
}

/**
 * Saves candidate profile to local storage. Only user-initiated actions dispatch profile_updated.
 */
export function saveCandidateProfileLocally(
  profile: CandidateProfile,
  dispatchEvent = true,
  userId?: string
) {
  if (typeof window !== "undefined") {
    try {
      const targetUserId = userId || memoizedUserId;
      const storageKey = getCandidateProfileStorageKey(targetUserId);
      localStorage.setItem(storageKey, JSON.stringify(profile));
      if (targetUserId && storageKey !== PROFILE_STORAGE_KEY) {
        localStorage.removeItem(PROFILE_STORAGE_KEY);
      }
      memoizedProfile = profile;
      if (targetUserId) {
        memoizedUserId = targetUserId;
      }
      if (dispatchEvent) {
        window.dispatchEvent(new Event("careermonke_profile_updated"));
        emitProfileUpdate(profile);
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
  const updatedProfile: CandidateProfile = {
    ...profile,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || (await supabase.auth.getUser()).data.user;

  saveCandidateProfileLocally(updatedProfile, true, user?.id);

  if (user) {
    const payload: any = {
      user_id: user.id,
      name: updatedProfile.name,
      email: updatedProfile.email || user.email,
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
      throw new Error(`Failed to save candidate profile to database: ${error.message}`);
    }
  }
}

export const saveCandidateProfileToSupabase = saveConfirmedCandidateProfile;

/**
 * Deletes candidate profile from local storage and Supabase
 */
export async function deleteCandidateProfile(): Promise<void> {
  const currentUserId = memoizedUserId;
  clearCandidateProfileMemoryCache();
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(PROFILE_STORAGE_KEY);
      if (currentUserId) {
        localStorage.removeItem(getCandidateProfileStorageKey(currentUserId));
      }
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
export const COVER_LETTER_CACHE_VERSION = 2;

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

export interface CoverLetterCacheValidationContext {
  candidateFactsHash?: string;
  jobHash?: string;
  candidate?: CandidateProfile | null;
  job?: { id?: string; title?: string; company?: string; description?: string } | null;
}

/**
 * Gets cached job-specific cover letter from localStorage (synchronous).
 * Scoped by verified authenticated Supabase user ID.
 *
 * Enforces Audit F03 invalidation:
 * - Rejects and purges unversioned legacy entries (cacheVersion missing or != COVER_LETTER_CACHE_VERSION).
 * - Rejects and purges entries missing candidateFactsHash or jobHash.
 * - Rejects and purges entries where candidateFactsHash or jobHash mismatch current candidate/job facts.
 */
export function getCachedTailoredCoverLetter(
  jobId: string,
  ownerId?: string | null,
  validationContext?: CoverLetterCacheValidationContext
): TailoredCoverLetterResult | null {
  if (typeof window === "undefined" || !jobId) return null;
  try {
    const storageKey = getScopedTailoredCoverLetterKey(jobId, ownerId);
    if (!storageKey) return null;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    let parsed: TailoredCoverLetterResult | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.removeItem(storageKey);
      return null;
    }

    // 1. Version check: Every unversioned legacy entry is rejected and purged (F03 fix)
    if (!parsed || parsed.cacheVersion !== COVER_LETTER_CACHE_VERSION) {
      localStorage.removeItem(storageKey);
      return null;
    }

    // 2. Hash presence check
    if (!parsed.candidateFactsHash || !parsed.jobHash) {
      localStorage.removeItem(storageKey);
      return null;
    }

    // 3. Hash mismatch check against current candidate/job facts
    const expectedCandidateHash =
      validationContext?.candidateFactsHash ||
      (validationContext?.candidate ? computeCandidateFactsHash(validationContext.candidate) : undefined);
    const expectedJobHash =
      validationContext?.jobHash ||
      (validationContext?.job ? computeJobHash(validationContext.job) : undefined);

    if (expectedCandidateHash && parsed.candidateFactsHash !== expectedCandidateHash) {
      localStorage.removeItem(storageKey);
      return null;
    }

    if (expectedJobHash && parsed.jobHash !== expectedJobHash) {
      localStorage.removeItem(storageKey);
      return null;
    }

    return parsed;
  } catch (e) {
    console.warn(`Could not read cached tailored cover letter for ${jobId}`, e);
  }
  return null;
}

/**
 * Purges tailored cover letter from localStorage and Supabase.
 */
export function purgeTailoredCoverLetter(jobId: string, ownerId?: string | null): void {
  if (typeof window === "undefined" || !jobId) return;
  const resolvedOwner = ownerId?.trim() || null;
  const storageKey = getScopedTailoredCoverLetterKey(jobId, resolvedOwner);
  if (storageKey) {
    try {
      localStorage.removeItem(storageKey);
    } catch (e) {
      console.warn(`Could not purge local cover letter cache for ${jobId}`, e);
    }
  }
  if (resolvedOwner && resolvedOwner !== "guest") {
    try {
      const supabase = createClient();
      supabase.auth.getUser().then((res: any) => {
        const user = res?.data?.user;
        if (user && user.id === resolvedOwner) {
          supabase
            .from("tailored_resumes")
            .update({ cover_letter_data: null, updated_at: new Date().toISOString() })
            .eq("user_id", user.id)
            .eq("job_id", jobId)
            .then(() => {})
            .catch(() => {});
        }
      }).catch(() => {});
    } catch (err) {}
  }
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

  // Ensure current cacheVersion and generatorId are always written
  const versionedData: TailoredCoverLetterResult = {
    ...data,
    cacheVersion: data.cacheVersion ?? COVER_LETTER_CACHE_VERSION,
    generatorId: data.generatorId ?? "rules-v2",
  };

  try {
    localStorage.setItem(storageKey, JSON.stringify(versionedData));
  } catch (e) {
    console.warn(`Could not save cached tailored cover letter for ${jobId}`, e);
  }

  // Asynchronously persist to Supabase for multi-device / multi-user persistence if authenticated
  if (resolvedOwner && resolvedOwner !== "guest") {
    saveTailoredCoverLetterToSupabase(jobId, versionedData, resolvedOwner).catch((err) => {
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
 *
 * Enforces Audit F03 invalidation:
 * - Skips unversioned legacy remote rows without writing them back to localStorage.
 * - Skips remote rows missing candidateFactsHash or jobHash without writing to localStorage.
 * - Skips remote rows with mismatched hashes without writing to localStorage.
 */
export async function getTailoredCoverLetterAsync(
  jobId: string,
  ownerId?: string | null,
  validationContext?: CoverLetterCacheValidationContext
): Promise<TailoredCoverLetterResult | null> {
  const resolvedOwner = ownerId?.trim() || null;
  const local = getCachedTailoredCoverLetter(jobId, resolvedOwner, validationContext);
  if (local) return local;

  if (!resolvedOwner || resolvedOwner === "guest") return null;

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

      // 1. Version check: Unversioned legacy remote entries are skipped and NOT written back to localStorage
      if (!parsed || parsed.cacheVersion !== COVER_LETTER_CACHE_VERSION) {
        return null;
      }

      // 2. Hash presence check
      if (!parsed.candidateFactsHash || !parsed.jobHash) {
        return null;
      }

      // 3. Hash mismatch check against current candidate/job facts
      const expectedCandidateHash =
        validationContext?.candidateFactsHash ||
        (validationContext?.candidate ? computeCandidateFactsHash(validationContext.candidate) : undefined);
      const expectedJobHash =
        validationContext?.jobHash ||
        (validationContext?.job ? computeJobHash(validationContext.job) : undefined);

      if (expectedCandidateHash && parsed.candidateFactsHash !== expectedCandidateHash) {
        return null;
      }

      if (expectedJobHash && parsed.jobHash !== expectedJobHash) {
        return null;
      }

      // Valid and version-current: sync to localStorage
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

export const RESUME_STORAGE_BUCKET = "resumes";
export const RESUME_BUCKET_CONFIG = {
  id: RESUME_STORAGE_BUCKET,
  public: false,
} as const;

export function isOwnerScopedResumePath(objectPath: string, userId: string): boolean {
  if (!objectPath || !userId) return false;
  const trimmedPath = objectPath.trim();
  const trimmedUserId = userId.trim();
  if (!trimmedPath || !trimmedUserId) return false;
  if (trimmedPath.includes("..") || trimmedPath.startsWith("/")) return false;
  return trimmedPath.startsWith(`${trimmedUserId}/`) && trimmedPath.length > trimmedUserId.length + 1;
}

/**
 * Uploads a resume file to the private `resumes` storage bucket under `${user.id}/${sanitizedFileName}`.
 * Never creates or returns a public URL.
 */
export async function uploadResumeFile(
  file: Blob | File | ArrayBuffer | Uint8Array,
  fileName: string,
  clientOverride?: any
): Promise<{ path: string; signedUrl: string }> {
  const supabase = clientOverride || createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user?.id) {
    throw new Error("Unauthorized: signed-in user required to upload resume file.");
  }

  const safeName = (fileName || "resume.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectPath = `${user.id}/${Date.now()}_${safeName}`;
  if (!isOwnerScopedResumePath(objectPath, user.id)) {
    throw new Error("Forbidden: invalid resume storage path.");
  }

  const bucket = supabase.storage.from(RESUME_STORAGE_BUCKET);
  const { error: uploadError } = await bucket.upload(objectPath, file, {
    upsert: true,
  });
  if (uploadError) {
    throw new Error(`Failed to upload resume file: ${uploadError.message}`);
  }

  const signedUrl = await getResumeSignedUrl(objectPath, 300, supabase);
  return { path: objectPath, signedUrl };
}

/**
 * Generates a short-lived signed URL for a resume file in the private `resumes` bucket.
 * Strictly enforces owner-only access (`${user.id}/...`) and never uses public URLs.
 */
export async function getResumeSignedUrl(
  objectPath: string,
  expiresInSeconds = 300,
  clientOverride?: any
): Promise<string> {
  const supabase = clientOverride || createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user?.id) {
    throw new Error("Unauthorized: signed-in user required to access resume file.");
  }

  if (!isOwnerScopedResumePath(objectPath, user.id)) {
    throw new Error("Forbidden: resume file access is restricted to its owner.");
  }

  const boundedExpiry = Math.max(30, Math.min(3600, Math.floor(expiresInSeconds)));
  const bucket = supabase.storage.from(RESUME_STORAGE_BUCKET);
  const { data, error } = await bucket.createSignedUrl(objectPath, boundedExpiry);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create signed URL for resume file.");
  }

  return data.signedUrl;
}

export {
  calculateProfileCompletion,
  type ProfileCompletionInput,
  type ProfileCompletionResult,
  type ProfileCompletionPreferences,
} from "./completion";


