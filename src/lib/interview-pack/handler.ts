import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import type { InterviewPackData } from "@/data/interviewPackFixture";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "interview-pack/handler" } });

export const INTERVIEW_PACK_NOT_AVAILABLE_MESSAGE =
  "Interview Pack is not available yet for this role.";

function isRealInterviewPackResult(
  pack: InterviewPackData | null | undefined,
  requestedJobId: string
): pack is InterviewPackData {
  if (!pack || typeof pack !== "object") return false;
  if (!requestedJobId || requestedJobId === "sample" || requestedJobId === "preview" || requestedJobId === "default") {
    return false;
  }
  if (!pack.jobId || pack.jobId === "sample") return false;
  if (pack.companyName === "Cloud Infrastructure Technologies") return false;
  return Boolean(pack.jobTitle && pack.companyName && Array.isArray(pack.cards));
}

function getSupabaseAdmin() {
  if (process.env.NODE_ENV === "test" && (globalThis as any).__mockSupabaseAdmin) {
    return (globalThis as any).__mockSupabaseAdmin;
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "API /jobs/interview-pack"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

export interface InterviewPackDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: (userId: string) => Promise<{ isPro: boolean }>;
  generateInterviewPack?: (params: {
    userId: string;
    jobId: string;
  }) => Promise<InterviewPackData | null>;
}

export async function handleInterviewPackRequest(
  req: Request,
  deps: InterviewPackDeps = {}
) {
  try {
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
          error: "CareerMonke Pro subscription required to access the Interview Pack.",
          isPro: false,
          code: "PRO_REQUIRED",
        },
        { status: 403 }
      );
    }

    // 3. Return only a real AI result for Pro Member; never return sample fixture data as if real
    const url = new URL(req.url);
    const jobId = (url.searchParams.get("jobId") || "").trim();

    if (deps.generateInterviewPack && jobId) {
      try {
        const generated = await deps.generateInterviewPack({
          userId: user.id,
          jobId,
        });
        if (isRealInterviewPackResult(generated, jobId)) {
          return NextResponse.json(
            {
              pack: {
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
        pack: null,
        available: false,
        status: "not_available_yet",
        code: "NOT_AVAILABLE_YET",
        error: INTERVIEW_PACK_NOT_AVAILABLE_MESSAGE,
        message: INTERVIEW_PACK_NOT_AVAILABLE_MESSAGE,
        isPro: true,
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (err: any) {
    try {
      const parsed = JSON.parse(err?.message);
      if (parsed.missingVariable) {
        return NextResponse.json(parsed, { status: 500 });
      }
    } catch {}
    log.error("[API /jobs/interview-pack error]:", { error: err });
    return NextResponse.json(
      { error: "Service temporarily unavailable. Please try again later.", isPro: false },
      { status: 503 }
    );
  }
}
