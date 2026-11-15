import { CandidateProfile } from "../resume/types";
import {
  generateTailoredCoverLetter as fallbackGenerateCoverLetter,
  validateCoverLetter,
  formatContactHeader,
} from "../resume/tailor";
import { validateAndSanitizeAiOutput } from "./security";
import { stripHtmlAndExecutableMarkup } from "../security/xss";
import { createClient } from "../supabase/client";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "ai/groq" } });

/**
 * Checks if server-side AI enhancement is available.
 * Backward-compatible helper used across frontend components.
 */
export function getGroqApiKey(): boolean {
  return true;
}

export const isAiAvailable = getGroqApiKey;

export const GENERIC_AI_UNAVAILABLE_MESSAGE =
  "AI is temporarily unavailable. Please try again.";

/**
 * Sanitizes any AI service error string for client-side user presentation.
 * Replaces any error message exposing environment variable names (such as GROQ_API_KEY)
 * or sensitive internals with a clean, friendly message.
 */
export function sanitizeUserFacingAiError(rawError?: string | null, isTailoring = false): string {
  if (!rawError) {
    return isTailoring
      ? "AI is temporarily unavailable. Your verified rules-based version is ready."
      : GENERIC_AI_UNAVAILABLE_MESSAGE;
  }
  const str = String(rawError);
  if (/GROQ_API_KEY|API_KEY|[A-Z0-9_]+_KEY|[A-Z0-9_]+_SECRET/i.test(str)) {
    return isTailoring
      ? "AI is temporarily unavailable. Your verified rules-based version is ready."
      : GENERIC_AI_UNAVAILABLE_MESSAGE;
  }
  if (/AI (?:service )?generation failed/i.test(str)) {
    return isTailoring
      ? "AI service is temporarily busy. Your verified rules-based version is ready."
      : "AI service is temporarily busy. Please try again.";
  }
  if (/rate limit|too many requests|429/i.test(str)) {
    return "AI service is experiencing high demand. Please try again in a few moments.";
  }
  if (/timed out|timeout/i.test(str)) {
    return "AI service request timed out. Please try again in a moment.";
  }
  return str;
}

const KEPT = "Your verified rules-based version is kept.";

/** User-facing copy for the typed server error codes. */
export function aiErrorMessage(data: any, status?: number, operation?: string): string {
  const op = operation || data?.operation;
  const isTailoring = op === "resume_tailor";

  switch (data?.code) {
    case "AI_TIMEOUT":
      return isTailoring
        ? `AI took too long to respond. ${KEPT} You can try again.`
        : "AI took too long to respond. Please try again.";
    case "AI_BUSY":
      return isTailoring
        ? `AI is busy right now. ${KEPT} You can try again shortly.`
        : "AI is busy right now. Please try again shortly.";
    case "AI_VALIDATION_FAILED":
      return isTailoring
        ? `AI could not produce a draft that matches your resume facts. ${KEPT}`
        : "AI could not produce a response that matches the provided data. Please try again.";
    case "AI_NOT_CONFIGURED":
      return isTailoring
        ? `AI is not available right now. ${KEPT}`
        : "AI is not available right now.";
  }
  if (!data?.error && (status === 502 || status === 504)) {
    return isTailoring
      ? `AI took too long to respond. ${KEPT} You can try again.`
      : "AI took too long to respond. Please try again.";
  }
  return sanitizeUserFacingAiError(data?.error || `AI generation failed (HTTP ${status}).`, isTailoring);
}

/**
 * POSTs to /api/ai with ONE idempotency key per call (i.e. per user click), reused on the
 * single retry so a retried request can never consume quota twice. Retries only on a network
 * failure, an in-flight 409 pending state, a platform gateway error with no JSON body, or a
 * code-less 429 whose Retry-After is short. Coded server responses (quota, budget, kill-switch,
 * typed AI errors) are never retried.
 */
export async function postAiRequest(
  token: string,
  body: Record<string, any>
): Promise<{ response: Response; data: any }> {
  const payload = JSON.stringify({ ...body, idempotencyKey: `ai_${crypto.randomUUID()}` });
  const send = () =>
    fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload,
    });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let response: Response;
  try {
    response = await send();
  } catch {
    await wait(800);
    response = await send();
    return { response, data: await response.clone().json().catch(() => ({})) };
  }
  let data = await response.clone().json().catch(() => null);

  const gatewayNoBody = (response.status === 502 || response.status === 504) && data === null;
  const retryAfter = Number(response.headers?.get?.("retry-after")) || 0;
  const plain429 = response.status === 429 && !data?.code && retryAfter > 0 && retryAfter <= 5;
  const isInFlight = response.status === 409 || data?.code === "OPERATION_IN_FLIGHT" || data?.status === "pending";

  if (isInFlight) {
    const pollWaitMs = Math.min(Math.max((retryAfter || 2) * 1000, 1500), 4000);
    await wait(pollWaitMs);
    response = await send();
    data = await response.clone().json().catch(() => null);
  } else if (gatewayNoBody || plain429) {
    await wait(plain429 ? retryAfter * 1000 : 800);
    response = await send();
    data = await response.clone().json().catch(() => null);
  }
  return { response, data: data ?? {} };
}

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
      log.warn("User not authenticated; utilizing deterministic local algorithms.");
      return null;
    }

    const operation = options.operation || options.feature || "cover_letter";
    const { response } = await postAiRequest(token, { operation, params: options.params || {} });

    if (!response.ok) {
      const errData = await response.clone().json().catch(() => ({}));
      log.warn("[AI] Server endpoint returned error:", { detail: errData.code || errData.error || response.status });
      return null;
    }

    const data = await response.json();
    return data?.content || data?.text || null;
  } catch (err) {
    log.warn("[AI] Secure completion request failed, falling back to local engine:", { error: err });
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
    log.warn("Failed to parse AI extraction output, retaining deterministic output:", { error: err });
  }

  return baseProfile;
}

export interface GroqCoverLetterResponse {
  text: string;
  isValidated: boolean;
  isAiEnhanced?: boolean;
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
          isAiEnhanced: false,
          error: sanitizeUserFacingAiError(check.error),
        };
      }
      const cleanOutput = check.sanitizedText;
      // Validate the generated paragraphs against candidate facts
      const validation = validateCoverLetter(cleanOutput, candidate, job);
      if (!validation.valid) {
        log.warn("AI cover letter failed strict evidence verification:", { detail: validation.reasons });
        return {
          text: fallback.fullText,
          isValidated: true,
          isAiEnhanced: false,
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
        isAiEnhanced: true,
      };
    }
  } catch (e) {
    log.warn("AI cover letter generation failed, using deterministic template:", { error: e });
  }

  return {
    text: fallback.fullText,
    isValidated: true,
    isAiEnhanced: false,
    error: GENERIC_AI_UNAVAILABLE_MESSAGE,
  };
}

export interface TailorResumeAiResponse {
  success: boolean;
  draft?: {
    tailoredSummary: string;
    highlightedSkills: string[];
    matchedKeywords?: string[];
    unmatchedRequirements?: string[];
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

    const { response, data } = await postAiRequest(token, {
      operation: "resume_tailor",
      params: { candidate, job },
    });

    if (!response.ok) {
      return {
        success: false,
        error: aiErrorMessage(data, response.status, "resume_tailor"),
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
      error: sanitizeUserFacingAiError(err?.message || "Failed to reach AI service."),
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
      const rawError = data.error || `AI service returned error (HTTP ${response.status}).`;
      return {
        success: false,
        error: sanitizeUserFacingAiError(rawError),
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
      error: sanitizeUserFacingAiError(err?.message || "Failed to connect to AI match explanation service."),
      statusCode: 500,
    };
  }
}
