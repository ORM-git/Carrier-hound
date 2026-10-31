import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import type { SkillWhatIfData } from "@/data/skillWhatIfFixture";

export const SKILL_WHAT_IF_NOT_AVAILABLE_MESSAGE =
  "Skill What-If simulation is not available yet for this role.";

function isRealSkillWhatIfResult(
  simulation: SkillWhatIfData | null | undefined,
  requestedJobId: string
): simulation is SkillWhatIfData {
  if (!simulation || typeof simulation !== "object") return false;
  if (!requestedJobId || requestedJobId === "sample" || requestedJobId === "preview" || requestedJobId === "default") {
    return false;
  }
  if (!simulation.jobId || simulation.jobId === "sample") return false;
  if (simulation._serverProofSignature === "SERVER_ONLY_PROOF_CANARY_NEXUS_WHAT_IF_984") {
    return false;
  }
  return Boolean(simulation.jobTitle && Array.isArray(simulation.missingSkills));
}

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /jobs/skill-what-if"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

export interface SkillWhatIfDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: (userId: string) => Promise<{ isPro: boolean }>;
  generateSkillWhatIf?: (params: {
    userId: string;
    jobId: string;
  }) => Promise<SkillWhatIfData | null>;
}

export async function handleSkillWhatIfRequest(
  req: Request,
  deps: SkillWhatIfDeps = {}
) {
  // 1. Verify Authorization Header (Bearer Supabase access token)
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Unauthorized. Missing authorization token.", isPro: false },
      { status: 401 }
    );
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized. Missing authorization token.", isPro: false },
      { status: 401 }
    );
  }

  const getAdmin = deps.getSupabaseAdmin || getSupabaseAdmin;
  const getEntitlement = deps.getServerEntitlement || getServerEntitlement;

  const supabaseAdmin = getAdmin();
  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user) {
    return NextResponse.json(
      { error: "Invalid or expired session. Please sign in again.", isPro: false },
      { status: 401 }
    );
  }

  // Ban check (fails closed on lookup error)
  const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
  if (banCheck.isBlocked) {
    return NextResponse.json(
      { error: banCheck.error || "Account suspended. Access revoked by administrator.", isPro: false },
      { status: banCheck.isServiceUnavailable ? 503 : 403 }
    );
  }

  // 2. Server-Managed Pro Entitlement Check (Single Source of Truth, strictly ignoring user_metadata)
  const entitlement = await getEntitlement(user.id);
  if (!entitlement.isPro) {
    return NextResponse.json(
      {
        error: "CareerMonke Pro subscription required to access the Skill What-If simulation.",
        isPro: false,
        code: "PRO_REQUIRED",
      },
      { status: 403 }
    );
  }

  // 3. Return only a real AI result for Pro Member; never return sample fixture data as if real
  const url = new URL(req.url);
  const jobId = (url.searchParams.get("jobId") || "").trim();

  if (deps.generateSkillWhatIf && jobId) {
    try {
      const generated = await deps.generateSkillWhatIf({
        userId: user.id,
        jobId,
      });
      if (isRealSkillWhatIfResult(generated, jobId)) {
        return NextResponse.json(
          {
            simulation: {
              ...generated,
              jobId,
            },
            available: true,
            isPro: true,
          },
          {
            status: 200,
            headers: {
              "Cache-Control": "private, no-cache, no-store, must-revalidate",
            },
          }
        );
      }
    } catch {
      // Fall through to explicit not_available_yet state
    }
  }

  return NextResponse.json(
    {
      simulation: null,
      available: false,
      status: "not_available_yet",
      code: "NOT_AVAILABLE_YET",
      error: SKILL_WHAT_IF_NOT_AVAILABLE_MESSAGE,
      message: SKILL_WHAT_IF_NOT_AVAILABLE_MESSAGE,
      isPro: true,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    }
  );
}
