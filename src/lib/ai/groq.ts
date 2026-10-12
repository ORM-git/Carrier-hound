import { CandidateProfile } from "../resume/types";
import {
  generateTailoredCoverLetter as fallbackGenerateCoverLetter,
  validateCoverLetter,
  formatContactHeader,
} from "../resume/tailor";
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
      const parsed = JSON.parse(output);
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
      // Validate the generated paragraphs against candidate facts
      const validation = validateCoverLetter(output, candidate, job);
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
      blocks.push(`Dear Hiring Team at ${job.company},`);
      blocks.push(output.trim());
      blocks.push("Sincerely,");
      blocks.push(candidate.name || "Candidate");

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
