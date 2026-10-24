import { CandidateProfile } from "./types";
import { createClient } from "../supabase/client";
import type { TailoredJobResumeResult } from "./atsScorer";
import type { TailoredCoverLetterResult } from "./tailor";

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
  // 1. Return in-memory memoized profile immediately if available
  if (memoizedProfile && memoizedProfile.confirmedAt) {
    return memoizedProfile;
  }

  // 2. If a fetch is already in-flight, reuse it so concurrent calls coalesce into 1 request
  if (profileInFlightPromise) {
    return profileInFlightPromise;
  }

  profileInFlightPromise = (async () => {
    let profile: CandidateProfile | null = null;

    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.confirmedAt) {
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
      const supabase = createClient();
      let resolvedUserId = userId;
      let userEmail: string | undefined = undefined;

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

      if (resolvedUserId) {
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
          };
          // CRITICAL: Silent local write only (reads are side-effect free, NEVER dispatch profile_updated)
          saveCandidateProfileLocally(remoteProfile, false);
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
 * Saves candidate profile to local storage. Only user-initiated actions dispatch profile_updated.
 */
export function saveCandidateProfileLocally(profile: CandidateProfile, dispatchEvent = true) {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      memoizedProfile = profile;
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

  saveCandidateProfileLocally(updatedProfile);

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || (await supabase.auth.getUser()).data.user;

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

const TAILORED_RESUME_PREFIX = "careermonke_tailored_resume_";
const TAILORED_COVER_LETTER_PREFIX = "careermonke_tailored_cover_letter_";

/**
 * Gets cached job-specific tailored resume from localStorage (synchronous).
 */
export function getCachedTailoredResume(
  jobId: string,
  expectedHash?: string
): TailoredJobResumeResult | null {
  if (typeof window === "undefined" || !jobId) return null;
  try {
    const raw = localStorage.getItem(`${TAILORED_RESUME_PREFIX}${jobId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as TailoredJobResumeResult;
      if (parsed.tailoringSource === "ai") {
        if (expectedHash && parsed.sourceHash && parsed.sourceHash !== expectedHash) {
          localStorage.removeItem(`${TAILORED_RESUME_PREFIX}${jobId}`);
          return null;
        }
        if (parsed.operationVersion && parsed.operationVersion !== "1.0") {
          localStorage.removeItem(`${TAILORED_RESUME_PREFIX}${jobId}`);
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
 * Persists job-specific tailored resume into localStorage and Supabase.
 */
export function saveCachedTailoredResume(jobId: string, data: TailoredJobResumeResult): void {
  if (typeof window === "undefined" || !jobId) return;
  try {
    localStorage.setItem(`${TAILORED_RESUME_PREFIX}${jobId}`, JSON.stringify(data));
  } catch (e) {
    console.warn(`Could not save cached tailored resume for ${jobId}`, e);
  }

  // Asynchronously persist to Supabase for multi-device / multi-user persistence
  saveTailoredResumeToSupabase(jobId, data).catch((err) => {
    console.warn(`Could not sync tailored resume to Supabase for ${jobId}:`, err);
  });
}

/**
 * Persists tailored resume directly to Supabase table `tailored_resumes`.
 */
export async function saveTailoredResumeToSupabase(
  jobId: string,
  data: TailoredJobResumeResult
): Promise<void> {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

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
  expectedHash?: string
): Promise<TailoredJobResumeResult | null> {
  const local = getCachedTailoredResume(jobId, expectedHash);
  if (local) return local;

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

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
        localStorage.setItem(`${TAILORED_RESUME_PREFIX}${jobId}`, JSON.stringify(parsed));
      }
      return parsed;
    }
  } catch (err) {}

  return null;
}

/**
 * Gets cached job-specific cover letter from localStorage (synchronous).
 */
export function getCachedTailoredCoverLetter(jobId: string): TailoredCoverLetterResult | null {
  if (typeof window === "undefined" || !jobId) return null;
  try {
    const raw = localStorage.getItem(`${TAILORED_COVER_LETTER_PREFIX}${jobId}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`Could not read cached tailored cover letter for ${jobId}`, e);
  }
  return null;
}

/**
 * Persists job-specific cover letter into localStorage and Supabase.
 */
export function saveCachedTailoredCoverLetter(jobId: string, data: TailoredCoverLetterResult): void {
  if (typeof window === "undefined" || !jobId) return;
  try {
    localStorage.setItem(`${TAILORED_COVER_LETTER_PREFIX}${jobId}`, JSON.stringify(data));
  } catch (e) {
    console.warn(`Could not save cached tailored cover letter for ${jobId}`, e);
  }

  // Asynchronously persist to Supabase for multi-device / multi-user persistence
  saveTailoredCoverLetterToSupabase(jobId, data).catch((err) => {
    console.warn(`Could not sync tailored cover letter to Supabase for ${jobId}:`, err);
  });
}

/**
 * Persists tailored cover letter directly to Supabase table `tailored_resumes`.
 */
export async function saveTailoredCoverLetterToSupabase(
  jobId: string,
  data: TailoredCoverLetterResult
): Promise<void> {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

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
  jobId: string
): Promise<TailoredCoverLetterResult | null> {
  const local = getCachedTailoredCoverLetter(jobId);
  if (local) return local;

  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from("tailored_resumes")
      .select("cover_letter_data")
      .eq("user_id", user.id)
      .eq("job_id", jobId)
      .maybeSingle();

    if (!error && data?.cover_letter_data) {
      const parsed = data.cover_letter_data as TailoredCoverLetterResult;
      if (typeof window !== "undefined") {
        localStorage.setItem(`${TAILORED_COVER_LETTER_PREFIX}${jobId}`, JSON.stringify(parsed));
      }
      return parsed;
    }
  } catch (err) {}

  return null;
}

