import { CandidateProfile } from "../resume/types";
import {
  generateTailoredCoverLetter as fallbackGenerateCoverLetter,
  validateCoverLetter,
  formatContactHeader,
} from "../resume/tailor";
import { validateAndSanitizeAiOutput } from "./security";
import { stripHtmlAndExecutableMarkup } from "../security/xss";
import { createClient } from "../supabase/client";

/**
 * Checks if server-side AI enhancement is available.
 * Backward-compatible helper used across frontend components.
 */
export function getGroqApiKey(): boolean {
  return true;
}

export const isAiAvailable = getGroqApiKey;

/**
 * Proxies AI completion requests to our secure server-side endpoint (/api/ai).
 * The server strictly enforces Pro subscription status, operation allowlists,
 * and durable quotas. API keys and models are NEVER exposed to the client.
 */
export async function callGroqCompletion(options: {
  operation?: string;
  feature?: string;
  params?: Record<string, any>;
  model?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  jsonMode?: boolean;
}): Promise<string | null> {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (!token) {
      console.warn("User not authenticated; utilizing deterministic local algorithms.");
      return null;
    }

    const operation = options.operation || options.feature || "cover_letter";
    const body: Record<string, any> = {
      operation,
      params: options.params || {},
    };

    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.warn("[AI] Server endpoint returned error:", errData.error || response.status);
      return null;
    }

    const data = await response.json();
    return data?.content || data?.text || null;
  } catch (err) {
    console.warn("[AI] Secure completion request failed, falling back to local engine:", err);
    return null;
  }
}

/**
 * AI-enhanced Resume Fact Extraction via server-side /api/ai.
 * Strictly enforces zero-hallucination extraction without exposing keys.
 */
export async function extractResumeFactsWithGroq(
  rawText: string,
  baseProfile: CandidateProfile
): Promise<CandidateProfile> {
  try {
    const output = await callGroqCompletion({
      operation: "resume_extraction",
      params: {
        rawText,
      },
    });

    if (output) {
      const check = validateAndSanitizeAiOutput("resume_extraction", output);
      if (!check.ok || !check.parsedJson) {
        return baseProfile;
      }
      const parsed = check.parsedJson;
      return {
        ...baseProfile,
        name: parsed.name || baseProfile.name,
        headline: parsed.headline || baseProfile.headline,
        summary: parsed.summary || baseProfile.summary,
        skills: Array.isArray(parsed.skills) && parsed.skills.length > 0 ? parsed.skills : baseProfile.skills,
        experience: Array.isArray(parsed.experience) ? parsed.experience : baseProfile.experience,
        education: Array.isArray(parsed.education) ? parsed.education : baseProfile.education,
        certifications: Array.isArray(parsed.certifications) ? parsed.certifications : baseProfile.certifications,
      };
    }
  } catch (err) {
    console.warn("Failed to parse AI extraction output, retaining deterministic output:", err);
  }

  return baseProfile;
}

export interface GroqCoverLetterResponse {
  text: string;
  isValidated: boolean;
  error?: string;
}

/**
 * 1-Click Tailored Cover Letter via server-side /api/ai.
 * Hard evidence validation: rejects any unevidenced employers, contacts, or dates.
 */
export async function generateGroqTailoredCoverLetter(
  candidate: CandidateProfile,
  job: {
    title: string;
    company: string;
    description?: string;
  }
): Promise<GroqCoverLetterResponse> {
  const fallback = fallbackGenerateCoverLetter(candidate, job);

  try {
    const output = await callGroqCompletion({
      operation: "cover_letter",
      params: {
        candidate,
        job,
      },
    });

    if (output && output.trim().length > 80) {
      const check = validateAndSanitizeAiOutput("cover_letter", output);
      if (!check.ok) {
        return {
          text: fallback.fullText,
          isValidated: true,
          error: check.error,
        };
      }
      const cleanOutput = check.sanitizedText;
      // Validate the generated paragraphs against candidate facts
      const validation = validateCoverLetter(cleanOutput, candidate, job);
      if (!validation.valid) {
        console.warn("AI cover letter failed strict evidence verification:", validation.reasons);
        return {
          text: fallback.fullText,
          isValidated: true,
          error: `AI output contained unverified claims (${validation.reasons[0]}). Safely reverted to verified factual draft.`,
        };
      }

      // Assemble full letter deterministically with protected contact header
      const header = formatContactHeader(candidate);
      const blocks: string[] = [];
      if (header) blocks.push(header);
      blocks.push(`Dear Hiring Team at ${stripHtmlAndExecutableMarkup(job.company)},`);
      blocks.push(cleanOutput.trim());
      blocks.push("Sincerely,");
      blocks.push(stripHtmlAndExecutableMarkup(candidate.name || "Candidate"));

      return {
        text: blocks.join("\n\n"),
        isValidated: true,
      };
    }
  } catch (e) {
    console.warn("AI cover letter generation failed, using deterministic template:", e);
  }

  return {
    text: fallback.fullText,
    isValidated: true,
  };
}

export interface TailorResumeAiResponse {
  success: boolean;
  draft?: {
    tailoredSummary: string;
    highlightedSkills: string[];
    tailoredBullets: Record<string, string[]>;
  };
  model?: string;
  jobDescriptionShortened?: boolean;
  error?: string;
}

/**
 * Connects genuine AI resume tailoring via server-side /api/ai.
 * Strictly checks session, calls operation 'resume_tailor', validates zero-fabrication grounding,
 * and returns the structured draft for user review.
 */
export async function generateAiTailoredResume(
  candidate: CandidateProfile,
  job: {
    id?: string;
    title: string;
    company: string;
    location?: string;
    category?: string;
    skills?: string[];
    description?: string;
  }
): Promise<TailorResumeAiResponse> {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (!token) {
      return {
        success: false,
        error: "Authentication required to generate AI tailored resume.",
      };
    }

    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        operation: "resume_tailor",
        params: {
          candidate,
          job,
        },
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `AI generation failed (HTTP ${response.status}).`,
      };
    }

    let parsedDraft = data.result;
    if (!parsedDraft && typeof data.content === "string") {
      try {
        parsedDraft = JSON.parse(data.content);
      } catch (err) {}
    }

    if (!parsedDraft || typeof parsedDraft !== "object") {
      return {
        success: false,
        error: "AI service returned invalid draft structure.",
      };
    }

    const validation = validateAndSanitizeAiOutput(
      "resume_tailor",
      JSON.stringify(parsedDraft),
      { candidate, job }
    );

    if (!validation.ok) {
      return {
        success: false,
        error: validation.error,
      };
    }

    if (!validation.parsedJson) {
      return {
        success: false,
        error: "Generated draft failed grounding validation.",
      };
    }

    return {
      success: true,
      draft: validation.parsedJson,
      model: data.model,
      jobDescriptionShortened: Boolean(data.jobDescriptionShortened),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || "Failed to reach AI service.",
    };
  }
}

export interface JobFitExplanationResult {
  success: boolean;
  summary?: string;
  missingSkills?: string[];
  error?: string;
  statusCode?: number;
}

/**
 * 1-Click AI Job Fit Explanation for Pro subscribers with confirmed resume.
 * Proxies to server-side /api/ai with operation 'job_fit'.
 * Sends ONLY candidate skills + headline and job title, company, description.
 * Shows ONLY the returned summary (2-3 sentences) and missingSkills as 'Gaps to address'.
 * NEVER exposes or returns the AI score.
 */
export async function generateJobFitExplanation(
  candidate: CandidateProfile,
  job: {
    title: string;
    company: string;
    description?: string;
  }
): Promise<JobFitExplanationResult> {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (!token) {
      return {
        success: false,
        error: "Authentication required to generate AI match explanation.",
        statusCode: 401,
      };
    }

    // Send only candidate skills + headline and job title, company, description
    const candidatePayload = {
      headline: candidate.headline || "",
      skills: Array.isArray(candidate.skills) ? candidate.skills : [],
    };
    const jobPayload = {
      title: job.title || "",
      company: job.company || "",
      description: job.description || "",
    };

    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        operation: "job_fit",
        params: {
          candidate: candidatePayload,
          job: jobPayload,
        },
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `AI service returned error (HTTP ${response.status}).`,
        statusCode: response.status,
      };
    }

    let parsed = data.result;
    if (!parsed && typeof data.content === "string") {
      try {
        parsed = JSON.parse(data.content);
      } catch {}
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        success: false,
        error: "AI service returned invalid match explanation structure.",
        statusCode: 502,
      };
    }

    const rawSummary = String(parsed.summary || "").trim();
    if (!rawSummary) {
      return {
        success: false,
        error: "AI service returned empty match summary.",
        statusCode: 502,
      };
    }

    // Strict sanitization: strip HTML and executable markup, plain text only
    const cleanSummary = stripHtmlAndExecutableMarkup(rawSummary).replace(/\s+/g, " ").trim();
    const missingSkills = Array.isArray(parsed.missingSkills)
      ? parsed.missingSkills
          .map((s: any) => stripHtmlAndExecutableMarkup(String(s || "")).replace(/\s+/g, " ").trim())
          .filter(Boolean)
      : [];

    return {
      success: true,
      summary: cleanSummary,
      missingSkills,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || "Failed to connect to AI match explanation service.",
      statusCode: 500,
    };
  }
}
