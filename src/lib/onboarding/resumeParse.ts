/**
 * src/lib/onboarding/resumeParse.ts
 *
 * Orchestrates "uploaded onboarding resume -> structured profile":
 *   1. extract text server-side (resumeText.ts)
 *   2. deterministic parse (always) + the existing AI resume_extraction operation through
 *      executeAiCore, which applies the existing AI rate limits, quota, entitlement,
 *      kill switch and output validation. Any AI refusal or error falls back to rules.
 *   3. save privately in public.onboarding_resume_profiles (service role; owner-read only)
 *
 * Nothing here throws: every failure becomes a `failed` outcome so the upload still succeeds.
 */

import { executeAiCore } from "@/lib/ai/serviceHandler";
import { createLogger } from "@/lib/observability/logger";
import { extractResumeText, type ResumeTextFailure } from "./resumeText";
import {
  EMPTY_RESUME_PROFILE,
  hasProfileSignal,
  mergeAiProfile,
  normalizeStoredProfile,
  parseResumeProfileRules,
  type OnboardingResumeProfile,
} from "./resumeProfile";
import type { ResumeKind } from "./step2Resume";

const log = createLogger({ context: { module: "onboarding/resumeParse" } });

export const RESUME_PROFILES_TABLE = "onboarding_resume_profiles";
/** Upper bound on the AI step so a slow provider never stalls the upload response. */
export const AI_PARSE_TIMEOUT_MS = 15000;

export type ResumeParseStatus = "parsed" | "failed";

export interface ResumeParseOutcome {
  status: ResumeParseStatus;
  source: "ai" | "rules" | null;
  failureReason: ResumeTextFailure | null;
  profile: OnboardingResumeProfile;
}

export interface AiContext {
  clientIp: string;
  authHeader: string;
  env?: Record<string, any>;
  supabaseAdmin: any;
}

export interface ResumeParseDeps {
  executeAi?: typeof executeAiCore;
  aiTimeoutMs?: number;
  now?: Date;
}

function failed(reason: ResumeTextFailure): ResumeParseOutcome {
  return { status: "failed", source: null, failureReason: reason, profile: { ...EMPTY_RESUME_PROFILE } };
}

async function runAi(text: string, ctx: AiContext, deps: ResumeParseDeps): Promise<any | null> {
  const exec = deps.executeAi ?? executeAiCore;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.aiTimeoutMs ?? AI_PARSE_TIMEOUT_MS);
    });
    const call = exec(
      ctx.clientIp,
      ctx.authHeader,
      { operation: "resume_extraction", params: { rawText: text } },
      { env: ctx.env, getSupabaseAdmin: () => ctx.supabaseAdmin }
    );
    const res = await Promise.race([call, timeout]);
    if (!res) {
      log.warn("AI resume parse timed out; using rules");
      return null;
    }
    if (res.statusCode !== 200) {
      // 403 PRO_REQUIRED, 429, 503 (kill switch / budget) ... are expected: rules take over.
      log.info("AI resume parse unavailable; using rules", { status: res.statusCode, code: res.body?.code });
      return null;
    }
    const result = res.body?.result;
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch (err: any) {
    log.warn("AI resume parse threw; using rules", { error: err?.message });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extract + parse. `ai` null skips the AI step (rules only). Never throws. */
export async function parseOnboardingResume(
  bytes: Uint8Array,
  kind: ResumeKind,
  ai: AiContext | null,
  deps: ResumeParseDeps = {}
): Promise<ResumeParseOutcome> {
  try {
    const extracted = await extractResumeText(bytes, kind);
    if (extracted.failure || !extracted.text) return failed(extracted.failure ?? "no_text");

    const now = deps.now ?? new Date();
    const rules = parseResumeProfileRules(extracted.text, now);
    const aiResult = ai ? await runAi(extracted.text, ai, deps) : null;
    const profile = aiResult ? mergeAiProfile(aiResult, rules, now) : rules;

    if (!hasProfileSignal(profile)) return failed("parse_error");
    return { status: "parsed", source: aiResult ? "ai" : "rules", failureReason: null, profile };
  } catch (err: any) {
    log.warn("Resume parse failed", { error: err?.message });
    return failed("parse_error");
  }
}

function isMissingTable(error: any): boolean {
  const code = String(error?.code || "");
  return code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(String(error?.message || ""));
}

/**
 * Saves the outcome for `userId`, but only while the user's upload pointer still references
 * `storagePath` (a newer upload wins). Returns false on any failure. Never throws.
 */
export async function saveResumeProfile(
  supabaseAdmin: any,
  userId: string,
  storagePath: string,
  outcome: ResumeParseOutcome
): Promise<boolean> {
  try {
    const { data: pointer, error: readError } = await supabaseAdmin
      .from("onboarding_resume_uploads")
      .select("storage_path")
      .eq("user_id", userId)
      .maybeSingle();
    if (readError || pointer?.storage_path !== storagePath) {
      if (readError) log.warn("Pointer re-read before profile save failed", { userId, error: readError.message });
      return false;
    }
    const { error } = await supabaseAdmin.from(RESUME_PROFILES_TABLE).upsert(
      {
        user_id: userId,
        source_storage_path: storagePath,
        parse_status: outcome.status,
        parse_source: outcome.status === "parsed" ? outcome.source : null,
        failure_reason: outcome.status === "failed" ? outcome.failureReason ?? "parse_error" : null,
        profile: outcome.profile,
        parsed_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) {
      if (isMissingTable(error)) log.warn("onboarding_resume_profiles not migrated yet; parse result not saved", { userId });
      else log.error("Saving parsed resume profile failed", { userId, error: error.message });
      return false;
    }
    return true;
  } catch (err: any) {
    log.error("Saving parsed resume profile threw", { userId, error: err?.message });
    return false;
  }
}

/**
 * Reads the user's current parsed profile for ranking. Returns null when there is none,
 * when it failed to parse, when it belongs to an older upload, or on any error.
 */
export async function loadResumeProfileForRanking(
  supabaseAdmin: any,
  userId: string
): Promise<OnboardingResumeProfile | null> {
  try {
    const [profileRes, pointerRes] = await Promise.all([
      supabaseAdmin
        .from(RESUME_PROFILES_TABLE)
        .select("profile, parse_status, source_storage_path")
        .eq("user_id", userId)
        .maybeSingle(),
      supabaseAdmin.from("onboarding_resume_uploads").select("storage_path").eq("user_id", userId).maybeSingle(),
    ]);
    if (profileRes?.error || pointerRes?.error) return null;
    const row = profileRes?.data;
    if (!row || row.parse_status !== "parsed") return null;
    if (!pointerRes?.data?.storage_path || pointerRes.data.storage_path !== row.source_storage_path) return null;
    const profile = normalizeStoredProfile(row.profile);
    return hasProfileSignal(profile) ? profile : null;
  } catch {
    return null;
  }
}

/** Small, user-facing summary returned to Step 2 (the user's own data only). */
export function summarizeOutcome(outcome: ResumeParseOutcome, saved: boolean) {
  if (!saved) return { status: "unavailable" as const };
  if (outcome.status === "failed") return { status: "failed" as const, reason: outcome.failureReason };
  const p = outcome.profile;
  return {
    status: "parsed" as const,
    source: outcome.source,
    jobTitle: p.preferredRoles[0] || p.jobTitles[0] || null,
    skillsCount: p.skills.length,
    topSkills: p.skills.slice(0, 3),
    yearsOfExperience: p.yearsOfExperience,
  };
}
