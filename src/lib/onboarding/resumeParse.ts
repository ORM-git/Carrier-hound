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
export const AI_PARSE_TIMEOUT_MS = 4000;

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

export const SAVE_PROFILE_RPC_TIMEOUT_MS = 3000;

/**
 * Saves the outcome for `userId` atomically via save_onboarding_resume_profile RPC,
 * which takes a row lock on the user's upload pointer row. If a newer upload arrives,
 * the RPC detects the pointer mismatch and returns false. Fails closed on every RPC error,
 * timeout, or unexpected response shape (the upload still succeeds, but the profile is not saved).
 * Returns false on any failure. Never throws.
 */
export async function saveResumeProfile(
  supabaseAdmin: any,
  userId: string,
  storagePath: string,
  outcome: ResumeParseOutcome,
  timeoutMs = SAVE_PROFILE_RPC_TIMEOUT_MS
): Promise<boolean> {
  try {
    if (typeof supabaseAdmin?.rpc !== "function") {
      log.warn("RPC client unavailable; parse result not saved", { userId });
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ data: null; error: { message: string; code: string } }>((resolve) => {
      timer = setTimeout(
        () => resolve({ data: null, error: { message: "save_onboarding_resume_profile RPC timed out", code: "57014" } }),
        timeoutMs
      );
    });
    const rpcPromise = supabaseAdmin.rpc("save_onboarding_resume_profile", {
      p_user_id: userId,
      p_storage_path: storagePath,
      p_parse_status: outcome.status,
      p_parse_source: outcome.status === "parsed" ? outcome.source : null,
      p_failure_reason: outcome.status === "failed" ? outcome.failureReason ?? "parse_error" : null,
      p_profile: outcome.profile ?? {},
    });
    const res = await Promise.race([rpcPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    if (res?.error) {
      if (isMissingTable(res.error) || res.error.code === "42883") {
        log.warn("onboarding_resume_profiles not migrated yet; parse result not saved", { userId });
      } else {
        log.error("save_onboarding_resume_profile RPC error", { userId, error: res.error.message, code: res.error.code });
      }
      return false;
    }
    if (typeof res?.data === "boolean") {
      return res.data;
    }
    log.warn("Unexpected RPC response shape; parse result not saved", { userId, data: res?.data });
    return false;
  } catch (err: any) {
    log.error("Saving parsed resume profile threw", { userId, error: err?.message });
    return false;
  }
}

/** A ranking-profile read: `error` (query failed or threw) is kept apart from `missing` so callers can retry it. */
export type ResumeProfileRead =
  | { status: "found"; profile: OnboardingResumeProfile }
  | { status: "missing" }
  | { status: "error" };

/**
 * Reads the user's current parsed profile for ranking. `missing` when there is none, when it
 * failed to parse or when it belongs to an older upload; `error` on any query error. Never throws.
 */
export async function readResumeProfileForRanking(supabaseAdmin: any, userId: string): Promise<ResumeProfileRead> {
  try {
    const [profileRes, pointerRes] = await Promise.all([
      supabaseAdmin
        .from(RESUME_PROFILES_TABLE)
        .select("profile, parse_status, source_storage_path")
        .eq("user_id", userId)
        .maybeSingle(),
      supabaseAdmin.from("onboarding_resume_uploads").select("storage_path").eq("user_id", userId).maybeSingle(),
    ]);
    if (profileRes?.error || pointerRes?.error) return { status: "error" };
    const row = profileRes?.data;
    if (!row || row.parse_status !== "parsed") return { status: "missing" };
    if (!pointerRes?.data?.storage_path || pointerRes.data.storage_path !== row.source_storage_path) return { status: "missing" };
    const profile = normalizeStoredProfile(row.profile);
    return profile && hasProfileSignal(profile) ? { status: "found", profile } : { status: "missing" };
  } catch {
    return { status: "error" };
  }
}

/** Same read as a profile or null (none, older upload, or any error). */
export async function loadResumeProfileForRanking(
  supabaseAdmin: any,
  userId: string
): Promise<OnboardingResumeProfile | null> {
  const read = await readResumeProfileForRanking(supabaseAdmin, userId);
  return read.status === "found" ? read.profile : null;
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
