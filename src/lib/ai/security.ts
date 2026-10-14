import { SupabaseClient } from "@supabase/supabase-js";
import { CandidateProfile } from "../resume/types";

export type AllowedAiOperation =
  | "cover_letter"
  | "resume_extraction"
  | "resume_tailor"
  | "job_fit";

export interface OperationConfig {
  operation: AllowedAiOperation;
  aliases: string[];
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  jsonMode: boolean;
  dailyQuota: number;
  description: string;
}

export const OPERATION_CONFIGS: Record<AllowedAiOperation, OperationConfig> = {
  cover_letter: {
    operation: "cover_letter",
    aliases: ["cover-letter", "coverletter"],
    model: process.env.SMART_MODEL || "openai/gpt-oss-120b",
    maxInputTokens: 3000,
    maxOutputTokens: 1000,
    temperature: 0.2,
    jsonMode: false,
    dailyQuota: 30,
    description: "Factual tailored cover letter body paragraphs strictly grounded in candidate facts",
  },
  resume_extraction: {
    operation: "resume_extraction",
    aliases: ["resume-extraction", "resumeextraction", "extract_resume", "extract-resume"],
    model: process.env.FAST_MODEL || "openai/gpt-oss-20b",
    maxInputTokens: 4000,
    maxOutputTokens: 2500,
    temperature: 0.1,
    jsonMode: true,
    dailyQuota: 20,
    description: "Zero-hallucination factual extraction of candidate profile from raw resume text",
  },
  resume_tailor: {
    operation: "resume_tailor",
    aliases: ["resume-tailor", "resumetailor", "tailor_resume", "tailor-resume"],
    model: process.env.SMART_MODEL || "openai/gpt-oss-120b",
    maxInputTokens: 4000,
    maxOutputTokens: 2000,
    temperature: 0.2,
    jsonMode: true,
    dailyQuota: 30,
    description: "Tailor candidate profile bullet points and summary strictly grounded in candidate facts",
  },
  job_fit: {
    operation: "job_fit",
    aliases: ["job-fit", "jobfit", "match_score", "fit_analysis"],
    model: process.env.FAST_MODEL || "openai/gpt-oss-20b",
    maxInputTokens: 3000,
    maxOutputTokens: 1000,
    temperature: 0.1,
    jsonMode: true,
    dailyQuota: 50,
    description: "Detailed candidate-to-job match assessment and gap analysis",
  },
};

/**
 * Resolves an incoming operation name or alias to its strict server-side configuration.
 */
export function resolveOperation(opName?: string): OperationConfig | null {
  if (!opName || typeof opName !== "string") return null;
  const clean = opName.toLowerCase().trim();
  for (const config of Object.values(OPERATION_CONFIGS)) {
    if (config.operation === clean || config.aliases.includes(clean)) {
      return config;
    }
  }
  return null;
}

/**
 * Conservative token count estimator (~3.5 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 3.5);
}

export interface BuiltAiPayload {
  messages: Array<{ role: "system" | "user"; content: string }>;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  jsonMode: boolean;
  estimatedInputTokens: number;
}

/**
 * Builds and bounds operation messages strictly server-side.
 * Rejects client-supplied raw models and arbitrary message arrays.
 */
export function buildOperationPayload(
  config: OperationConfig,
  params: any
): { ok: true; payload: BuiltAiPayload } | { ok: false; error: string } {
  if (!params || typeof params !== "object") {
    return { ok: false, error: `Missing structured 'params' for operation '${config.operation}'.` };
  }

  let systemPrompt = "";
  let userPrompt = "";

  switch (config.operation) {
    case "cover_letter": {
      const candidate = params.candidate as CandidateProfile;
      const job = params.job;

      if (!candidate || !job || typeof job !== "object") {
        return {
          ok: false,
          error: "Operation 'cover_letter' requires 'candidate' and 'job' parameters.",
        };
      }

      const inputTokens = estimateTokens(JSON.stringify(candidate)) + estimateTokens(JSON.stringify(job));
      if (inputTokens > config.maxInputTokens) {
        return {
          ok: false,
          error: `Payload exceeds maximum allowed token limit for operation 'cover_letter' (${inputTokens} > ${config.maxInputTokens}).`,
        };
      }

      const hasExperience = Array.isArray(candidate.experience) && candidate.experience.length > 0;
      const expSummary = hasExperience
        ? candidate.experience
            .map((e: any) => `${e.role || "Role"} at ${e.company || "Company"} (${e.startDate || ""} - ${e.endDate || ""})`)
            .slice(0, 5)
            .join("; ")
        : "NO PRIOR WORK EXPERIENCE (Fresher/Student). Strictly DO NOT mention previous employers or tenure.";

      const skillsList = Array.isArray(candidate.skills)
        ? candidate.skills.slice(0, 15).join(", ")
        : "";

      const jobTitle = String(job.title || "Target Role");
      const jobCompany = String(job.company || "Target Company");
      const jobDesc = String(job.description || "");

      systemPrompt = `You are an elite career strategist. Draft 3-4 concise, high-impact body paragraphs for a job cover letter.
CRITICAL ZERO-FABRICATION RULES:
1. Generate ONLY the body paragraphs. DO NOT include contact headers (name, email, phone, location), salutations ("Dear..."), or sign-offs ("Sincerely...").
2. Strictly ground the content in the candidate's verified facts:
- Real skills: ${skillsList}
- Work history: ${expSummary}
3. ZERO HALLUCINATIONS:
- NEVER invent false employers, project names, metrics, or years of experience.
- If candidate has NO prior work experience, DO NOT claim "throughout my tenure" or "previous roles". Focus strictly on verified skills and enthusiasm.
- DO NOT include any emails, phone numbers, or URLs.
4. Tailor tone to ${jobTitle} at ${jobCompany}.`;

      userPrompt = `Candidate Facts:\nName: ${String(candidate.name || "Candidate")}\nHeadline: ${String(candidate.headline || "Professional")}\nSummary: ${String(candidate.summary || "")}\nSkills: ${skillsList}\n\nJob Target:\nTitle: ${jobTitle}\nCompany: ${jobCompany}\nDescription: ${jobDesc}`;
      break;
    }

    case "resume_extraction": {
      const rawText = typeof params.rawText === "string" ? params.rawText : "";
      if (!rawText || rawText.trim().length === 0) {
        return {
          ok: false,
          error: "Operation 'resume_extraction' requires a non-empty 'rawText' string.",
        };
      }

      const inputTokens = estimateTokens(rawText);
      if (inputTokens > config.maxInputTokens) {
        return {
          ok: false,
          error: `Payload exceeds maximum allowed token limit for operation 'resume_extraction' (${inputTokens} > ${config.maxInputTokens}).`,
        };
      }

      systemPrompt = `You are an elite, zero-hallucination resume facts extraction engine.
CRITICAL ZERO-FABRICATION RULES:
1. ONLY extract information directly evidenced in the source text.
2. NEVER invent, infer, or hallucinate employers, roles, degrees, dates, achievements, or certifications.
3. If the candidate is a fresher or has no work experience mentioned, "experience" MUST be an empty array [].
4. Extract skills objectively across all fields (Marketing, Design, HR, Finance, Operations, Engineering). Do NOT bias towards software terms.
5. If dates, roles, or institutions are ambiguous, set "needsReview": true.
6. Return a valid JSON object matching the CandidateProfile schema:
{
  "name": string,
  "headline": string,
  "summary": string,
  "skills": string[],
  "experience": [
    {
      "id": string,
      "company": string,
      "role": string,
      "startDate": string,
      "endDate": string,
      "bullets": string[],
      "needsReview": boolean
    }
  ],
  "education": [
    {
      "id": string,
      "degree": string,
      "institution": string,
      "year": string,
      "needsReview": boolean
    }
  ],
  "certifications": string[]
}`;

      userPrompt = `Extract verified facts from this resume text:\n\n${rawText}`;
      break;
    }

    case "resume_tailor": {
      const candidate = params.candidate as CandidateProfile;
      const job = params.job;

      if (!candidate || !job || typeof job !== "object") {
        return {
          ok: false,
          error: "Operation 'resume_tailor' requires 'candidate' and 'job' parameters.",
        };
      }

      const inputTokens = estimateTokens(JSON.stringify(candidate)) + estimateTokens(JSON.stringify(job));
      if (inputTokens > config.maxInputTokens) {
        return {
          ok: false,
          error: `Payload exceeds maximum allowed token limit for operation 'resume_tailor' (${inputTokens} > ${config.maxInputTokens}).`,
        };
      }

      const skillsList = Array.isArray(candidate.skills)
        ? candidate.skills.slice(0, 15).join(", ")
        : "";

      systemPrompt = `You are an ATS resume tailoring specialist. Tailor the candidate's existing summary and bullet points to align with the target job.
CRITICAL ZERO-FABRICATION RULES:
1. ONLY rephrase or emphasize skills and achievements directly evidenced in candidate facts.
2. DO NOT invent employers, degrees, responsibilities, or tools not in the source facts.
3. Return a valid JSON object:
{
  "tailoredSummary": string,
  "highlightedSkills": string[],
  "tailoredBullets": { [experienceId: string]: string[] }
}`;

      userPrompt = `Candidate Profile:\nName: ${String(candidate.name || "Candidate")}\nSkills: ${skillsList}\nSummary: ${String(candidate.summary || "")}\n\nJob Target:\nTitle: ${String(job.title || "")}\nCompany: ${String(job.company || "")}\nDescription: ${String(job.description || "")}`;
      break;
    }

    case "job_fit": {
      const candidate = params.candidate as CandidateProfile;
      const job = params.job;

      if (!candidate || !job || typeof job !== "object") {
        return {
          ok: false,
          error: "Operation 'job_fit' requires 'candidate' and 'job' parameters.",
        };
      }

      const inputTokens = estimateTokens(JSON.stringify(candidate)) + estimateTokens(JSON.stringify(job));
      if (inputTokens > config.maxInputTokens) {
        return {
          ok: false,
          error: `Payload exceeds maximum allowed token limit for operation 'job_fit' (${inputTokens} > ${config.maxInputTokens}).`,
        };
      }

      const skillsList = Array.isArray(candidate.skills)
        ? candidate.skills.slice(0, 20).join(", ")
        : "";

      systemPrompt = `You are an objective talent assessment engine. Evaluate candidate fit against the target job requirements.
RULES:
1. Score match strictly based on evidenced skills and experience (score integer between 0 and 100).
2. Identify matched skills, missing skills, and brief rationale.
3. Return a valid JSON object:
{
  "score": number,
  "matchedSkills": string[],
  "missingSkills": string[],
  "summary": string
}`;

      userPrompt = `Candidate Skills & Background:\nSkills: ${skillsList}\nHeadline: ${String(candidate.headline || "")}\n\nJob Target:\nTitle: ${String(job.title || "")}\nCompany: ${String(job.company || "")}\nDescription: ${String(job.description || "")}`;
      break;
    }

    default:
      return { ok: false, error: `Unhandled operation: ${config.operation}` };
  }

  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

  if (estimatedInputTokens > config.maxInputTokens) {
    return {
      ok: false,
      error: `Payload exceeds maximum allowed token limit for operation '${config.operation}' (${estimatedInputTokens} > ${config.maxInputTokens}).`,
    };
  }

  return {
    ok: true,
    payload: {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      jsonMode: config.jsonMode,
      estimatedInputTokens,
    },
  };
}

export interface QuotaCheckResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  storage: "ai_usage_quotas" | "subscriptions_metadata";
  error?: string;
  isServiceUnavailable?: boolean;
}

/**
 * Checks and increments persistent per-user AI call quotas in Supabase.
 * Primary store: public.ai_usage_quotas table.
 * Graceful fallback: public.subscriptions.metadata (ensures zero downtime across restarts/deploys).
 */
export async function checkAndIncrementAiQuota(
  supabaseAdmin: SupabaseClient,
  userId: string,
  operation: AllowedAiOperation,
  estimatedTokens: number
): Promise<QuotaCheckResult> {
  const config = OPERATION_CONFIGS[operation];
  const limit = config ? config.dailyQuota : 30;
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // 1. Try primary storage: public.ai_usage_quotas
  try {
    const { data: row, error: selectErr } = await supabaseAdmin
      .from("ai_usage_quotas")
      .select("count, total_tokens")
      .eq("user_id", userId)
      .eq("period_date", today)
      .eq("operation", operation)
      .maybeSingle();

    if (!selectErr) {
      const currentCount = row?.count || 0;
      if (currentCount >= limit) {
        return {
          allowed: false,
          currentCount,
          limit,
          storage: "ai_usage_quotas",
        };
      }

      if (row) {
        await supabaseAdmin
          .from("ai_usage_quotas")
          .update({
            count: currentCount + 1,
            total_tokens: (row.total_tokens || 0) + estimatedTokens,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("period_date", today)
          .eq("operation", operation);
      } else {
        await supabaseAdmin.from("ai_usage_quotas").insert({
          user_id: userId,
          period_date: today,
          operation,
          count: 1,
          total_tokens: estimatedTokens,
          updated_at: new Date().toISOString(),
        });
      }

      return {
        allowed: true,
        currentCount: currentCount + 1,
        limit,
        storage: "ai_usage_quotas",
      };
    }
  } catch (err) {
    // If table doesn't exist or error, proceed to resilient subscriptions.metadata fallback
  }

  // 2. Resilient fallback storage: subscriptions.metadata.ai_usage
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, metadata")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subErr && sub) {
      const metadata = (sub.metadata && typeof sub.metadata === "object") ? { ...sub.metadata } : {};
      const aiUsage = metadata.ai_usage && typeof metadata.ai_usage === "object" ? { ...metadata.ai_usage } : {};
      const todayUsage = aiUsage[today] && typeof aiUsage[today] === "object" ? { ...aiUsage[today] } : {};
      const currentCount = typeof todayUsage[operation] === "number" ? todayUsage[operation] : 0;

      if (currentCount >= limit) {
        return {
          allowed: false,
          currentCount,
          limit,
          storage: "subscriptions_metadata",
        };
      }

      todayUsage[operation] = currentCount + 1;
      aiUsage[today] = todayUsage;
      metadata.ai_usage = aiUsage;

      await supabaseAdmin
        .from("subscriptions")
        .update({ metadata })
        .eq("id", sub.id);

      return {
        allowed: true,
        currentCount: currentCount + 1,
        limit,
        storage: "subscriptions_metadata",
      };
    }
  } catch (fallbackErr) {
    console.warn("[Quota Check] Error updating subscriptions fallback quota:", fallbackErr);
  }

  // Fail closed: Database unreachable or both quota stores errored
  console.error("[Quota Check] Database unreachable or error in quota stores; failing closed.");
  return {
    allowed: false,
    currentCount: limit,
    limit,
    storage: "subscriptions_metadata",
    error: "AI quota verification is temporarily unavailable. Please try again shortly.",
    isServiceUnavailable: true,
  };
}

/**
 * Refunds a reserved AI quota slot in the event of upstream provider failure (429, 5xx, timeout, garbage).
 */
export async function refundAiQuota(
  supabaseAdmin: SupabaseClient,
  userId: string,
  operation: AllowedAiOperation,
  estimatedTokens: number
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // 1. Try primary storage: public.ai_usage_quotas
  try {
    const { data: row, error: selectErr } = await supabaseAdmin
      .from("ai_usage_quotas")
      .select("count, total_tokens")
      .eq("user_id", userId)
      .eq("period_date", today)
      .eq("operation", operation)
      .maybeSingle();

    if (!selectErr && row && typeof row.count === "number" && row.count > 0) {
      await supabaseAdmin
        .from("ai_usage_quotas")
        .update({
          count: Math.max(0, row.count - 1),
          total_tokens: Math.max(0, (row.total_tokens || 0) - estimatedTokens),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("period_date", today)
        .eq("operation", operation);
      return;
    }
  } catch (err) {
    // Proceed to resilient fallback
  }

  // 2. Resilient fallback storage: subscriptions.metadata.ai_usage
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, metadata")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subErr && sub && sub.metadata && typeof sub.metadata === "object") {
      const metadata = { ...sub.metadata };
      const aiUsage = metadata.ai_usage && typeof metadata.ai_usage === "object" ? { ...metadata.ai_usage } : {};
      const todayUsage = aiUsage[today] && typeof aiUsage[today] === "object" ? { ...aiUsage[today] } : {};
      const currentCount = typeof todayUsage[operation] === "number" ? todayUsage[operation] : 0;

      if (currentCount > 0) {
        todayUsage[operation] = currentCount - 1;
        aiUsage[today] = todayUsage;
        metadata.ai_usage = aiUsage;

        await supabaseAdmin
          .from("subscriptions")
          .update({ metadata })
          .eq("id", sub.id);
      }
    }
  } catch (fallbackErr) {
    console.warn("[Quota Refund] Error refunding subscriptions fallback quota:", fallbackErr);
  }
}

