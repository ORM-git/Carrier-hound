import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { markAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import { UserPreferences } from "@/lib/auth/types";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { route: "/api/onboarding" } });

export const runtime = "edge";

const VALID_EMPLOYMENT_TYPES = new Set(["full-time", "contract", "part-time", "internship"]);

export async function POST(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized: Missing authentication token" }, { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const supabaseAdmin = getSupabaseAdminClient(cfEnv, true);

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized: Invalid session" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }

  // 1. Validate Roles (Required, 1-20 roles, strings up to 100 chars)
  if (!Array.isArray(body.roles) || body.roles.length === 0) {
    return NextResponse.json({ error: "At least one target role is required" }, { status: 400 });
  }

  const sanitizedRoles: string[] = [];
  for (const r of body.roles) {
    if (typeof r !== "string") continue;
    const clean = r.trim().slice(0, 100);
    if (clean.length > 0 && !sanitizedRoles.includes(clean)) {
      sanitizedRoles.push(clean);
    }
  }

  if (sanitizedRoles.length === 0) {
    return NextResponse.json({ error: "At least one valid target role is required" }, { status: 400 });
  }
  if (sanitizedRoles.length > 20) {
    return NextResponse.json({ error: "Maximum 20 roles may be selected" }, { status: 400 });
  }

  // 2. Validate Employment Types (Required, non-empty, allowed values)
  if (!Array.isArray(body.employmentTypes) || body.employmentTypes.length === 0) {
    return NextResponse.json({ error: "At least one job type must be selected" }, { status: 400 });
  }

  const sanitizedTypes: string[] = [];
  for (const t of body.employmentTypes) {
    if (typeof t !== "string") continue;
    const clean = t.toLowerCase().trim();
    if (VALID_EMPLOYMENT_TYPES.has(clean) && !sanitizedTypes.includes(clean)) {
      sanitizedTypes.push(clean);
    }
  }

  if (sanitizedTypes.length === 0) {
    return NextResponse.json({ error: "Please select a valid job type (Full-time, Contract, Part-time, Internship)" }, { status: 400 });
  }

  // 3. Validate Location
  let location = "Anywhere in India";
  if (typeof body.location === "string" && body.location.trim().length > 0) {
    location = body.location.trim().slice(0, 120);
  }

  // 4. Validate Remote Preference
  const openToRemote = body.openToRemote !== false;
  const remotePreference: UserPreferences["remotePreference"] = openToRemote ? "remote" : "onsite";

  // Derive categories from roles
  const categories: string[] = Array.from(
    new Set(
      sanitizedRoles.map((role) => {
        const lower = role.toLowerCase();
        if (lower.includes("ai") || lower.includes("machine learning") || lower.includes("data")) return "ai";
        if (lower.includes("design") || lower.includes("ux") || lower.includes("ui")) return "design";
        if (lower.includes("marketing") || lower.includes("seo") || lower.includes("content")) return "marketing";
        if (lower.includes("sales") || lower.includes("sdr") || lower.includes("account executive")) return "sales";
        if (lower.includes("product")) return "product";
        if (lower.includes("finance") || lower.includes("accounting") || lower.includes("auditor")) return "finance";
        if (lower.includes("hr") || lower.includes("recruiter") || lower.includes("human resource")) return "hr";
        if (lower.includes("legal") || lower.includes("counsel") || lower.includes("compliance")) return "legal";
        if (lower.includes("health") || lower.includes("medical") || lower.includes("clinical")) return "healthcare";
        if (lower.includes("customer") || lower.includes("support")) return "customer-support";
        return "engineering";
      })
    )
  );

  const payload: Partial<UserPreferences> = {
    roles: sanitizedRoles,
    categories,
    employmentTypes: sanitizedTypes,
    locations: [location],
    remotePreference,
    onboardingCompleted: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    // Upsert user_preferences
    const { error: prefError } = await supabaseAdmin.from("user_preferences").upsert(
      {
        user_id: user.id,
        roles: sanitizedRoles,
        categories,
        employment_types: sanitizedTypes,
        locations: [location],
        remote_preference: remotePreference,
        onboarding_completed: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (prefError) {
      log.error("Failed to persist user_preferences in /api/onboarding", { error: prefError.message });
      return NextResponse.json({ error: "Failed to save preferences to database" }, { status: 500 });
    }

    // Persist account onboarding completion timestamp
    await markAccountOnboardingCompleted(supabaseAdmin, user.id);

    return NextResponse.json({
      success: true,
      preferences: payload,
    });
  } catch (err: any) {
    log.error("Unhandled error in /api/onboarding", { error: err?.message || err });
    return NextResponse.json({ error: "Internal server error while saving preferences" }, { status: 500 });
  }
}
