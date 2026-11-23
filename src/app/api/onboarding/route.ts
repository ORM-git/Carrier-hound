import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/ai/serviceHandler";
import { markAccountOnboardingCompleted } from "@/lib/auth/onboarding";
import { UserPreferences } from "@/lib/auth/types";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { createLogger } from "@/lib/observability/logger";
import { COUNTRY_CODE_TO_NAME, SUPPORTED_COUNTRIES } from "@/lib/countries";
import { COUNTRY_MIGRATION, isMissingCountryColumnError } from "@/lib/auth/countryColumns";

const log = createLogger({ context: { route: "/api/onboarding" } });

export const runtime = "edge";

const CACHE_CONTROL_HEADER = "private, no-cache, no-store, must-revalidate";

const VALID_EMPLOYMENT_TYPES = new Set(["full-time", "contract", "part-time", "internship"]);
const REMOTE_PREFERENCES = new Set<UserPreferences["remotePreference"]>(["any", "hybrid", "remote", "onsite"]);

interface ResolvedCountry {
  code: string;
  name: string;
}

function resolveCountry(input: unknown): ResolvedCountry | null {
  if (typeof input !== "string" || !input.trim()) {
    return null;
  }
  const raw = input.trim();
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();

  // 1. Direct code lookup (e.g. "IN", "US")
  if (COUNTRY_CODE_TO_NAME[upper]) {
    return { code: upper, name: COUNTRY_CODE_TO_NAME[upper] };
  }

  // 2. Direct name match in COUNTRY_CODE_TO_NAME
  for (const [code, name] of Object.entries(COUNTRY_CODE_TO_NAME)) {
    if (name.toLowerCase() === lower) {
      return { code, name };
    }
  }

  // 3. Supported countries label / name match
  for (const opt of SUPPORTED_COUNTRIES) {
    if (!opt.code) continue;
    if (
      opt.name.toLowerCase() === lower ||
      opt.label.toLowerCase() === lower ||
      opt.code.toUpperCase() === upper
    ) {
      return { code: opt.code, name: opt.name };
    }
  }

  return null;
}

function jsonResponse(data: any, status: number = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": CACHE_CONTROL_HEADER,
    },
  });
}

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
    return jsonResponse({ error: "Unauthorized: Missing authentication token" }, 401);
  }

  const token = authHeader.replace("Bearer ", "").trim();
  let supabaseAdmin: any;
  try {
    supabaseAdmin = getSupabaseAdminClient(cfEnv, true);
  } catch (err: any) {
    log.error("Database service unavailable in /api/onboarding", { error: err?.message || err });
    return jsonResponse({ error: "Database service unavailable" }, 503);
  }

  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized: Invalid session" }, 401);
  }

  // Refuse onboarding if account has an interrupted deletion pending
  try {
    const query = supabaseAdmin
      .from("deleted_account_tombstones")
      .select("user_id")
      .eq("user_id", user.id);
    const { data: tombstone, error: tombstoneErr } = await (typeof (query as any)?.is === "function"
      ? (query as any).is("purged_at", null)
      : query
    ).maybeSingle();

    const isMissingTombstone = (err: any) => {
      if (!err) return false;
      const msg = String(err.message || "").toLowerCase();
      return (
        err.code === "42P01" ||
        err.code === "PGRST204" ||
        err.code === "PGRST205" ||
        msg.includes("does not exist") ||
        msg.includes("relation")
      );
    };

    if (tombstoneErr && !isMissingTombstone(tombstoneErr)) {
      log.error("Failed to verify tombstone state in /api/onboarding", { error: tombstoneErr.message });
      return jsonResponse({ error: "Service temporarily unavailable" }, 503);
    }

    if (tombstone) {
      return jsonResponse(
        { error: "Account deletion is pending. Please resolve or cancel deletion in Settings before onboarding." },
        409
      );
    }
  } catch (err: any) {
    log.error("Tombstone verification error in /api/onboarding", { error: err?.message || err });
    return jsonResponse({ error: "Service temporarily unavailable" }, 503);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request body" }, 400);
  }

  // 1. Validate Roles (Required, 1-20 roles)
  if (!Array.isArray(body.roles) || body.roles.length === 0) {
    return jsonResponse({ error: "At least one target role is required" }, 400);
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
    return jsonResponse({ error: "At least one valid target role is required" }, 400);
  }
  if (sanitizedRoles.length > 20) {
    return jsonResponse({ error: "Maximum 20 roles may be selected" }, 400);
  }

  // 2. Validate Employment Types (Required, non-empty, allowed values)
  if (!Array.isArray(body.employmentTypes) || body.employmentTypes.length === 0) {
    return jsonResponse({ error: "At least one job type must be selected" }, 400);
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
    return jsonResponse(
      { error: "Please select a valid job type (Full-time, Contract, Part-time, Internship)" },
      400
    );
  }

  // 3. Validate Location / Country (Required, searchable country picker, no fallback)
  const resolvedCountry = resolveCountry(body.country || body.countryCode);
  if (!resolvedCountry) {
    return jsonResponse(
      { error: "Valid country is required. Please select a supported country." },
      400
    );
  }

  // 4. Validate Work Authorization (Required, never defaulted)
  if (typeof body.workAuth !== "string" || !body.workAuth.trim()) {
    return jsonResponse({ error: "Work authorization status is required" }, 400);
  }
  const sanitizedWorkAuth = body.workAuth.trim().slice(0, 100);

  // Fetch existing DB preferences to preserve old locations, experience level, currency, and work model.
  // Only query live (non-soft-deleted) preferences; a soft-deleted row from an interrupted deletion must not leak old data.
  let existingDbPrefs: any = null;
  try {
    let { data: dbData, error: readError } = await supabaseAdmin
      .from("user_preferences")
      .select("roles, categories, experience_level, employment_types, locations, remote_preference, work_auth, min_salary, salary_currency, eligibility_filter, daily_digest_opt_in")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    const isMissingSoftDeleteCol = (err: any) => {
      if (!err) return false;
      const msg = String(err.message || "").toLowerCase();
      return (err.code === "42703" || err.code === "PGRST204" || msg.includes("column")) && msg.includes("deleted_at");
    };

    if (readError && isMissingSoftDeleteCol(readError)) {
      ({ data: dbData, error: readError } = await supabaseAdmin
        .from("user_preferences")
        .select("roles, categories, experience_level, employment_types, locations, remote_preference, work_auth, min_salary, salary_currency, eligibility_filter, daily_digest_opt_in")
        .eq("user_id", user.id)
        .maybeSingle());
    }

    if (readError) {
      log.error("Failed to read existing user_preferences in /api/onboarding", { error: readError.message });
      return jsonResponse({ error: "Failed to load saved preferences" }, 500);
    }
    existingDbPrefs = dbData;
  } catch (err: any) {
    log.error("Failed to read existing user_preferences in /api/onboarding", { error: err?.message || err });
    return jsonResponse({ error: "Failed to load saved preferences" }, 500);
  }

  // 5. Locations: preserve ALL old saved locations without clobbering
  const existingLocations: string[] = Array.isArray(existingDbPrefs?.locations)
    ? existingDbPrefs.locations
    : [];
  const mergedLocations = Array.from(
    new Set([resolvedCountry.name, ...existingLocations])
  ).filter(Boolean);

  // 6. Remote preference: keep any/hybrid/remote/onsite without narrowing
  //    Explicit value wins; otherwise the saved value is kept as-is; legacy openToRemote only for new users.
  let finalRemotePref: UserPreferences["remotePreference"];
  if (REMOTE_PREFERENCES.has(body.remotePreference)) {
    finalRemotePref = body.remotePreference;
  } else if (REMOTE_PREFERENCES.has(existingDbPrefs?.remote_preference)) {
    finalRemotePref = existingDbPrefs.remote_preference;
  } else {
    finalRemotePref = body.openToRemote === false ? "onsite" : "remote";
  }

  // 7. Derive categories from roles
  const derivedCategories: string[] = Array.from(
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

  const mergedCategories = Array.from(
    new Set([...(existingDbPrefs?.categories || []), ...derivedCategories])
  );

  try {
    // 8. Upsert user_preferences. country / country_code are required columns of this write.
    // Carry saved values over explicitly; write null for a new user so column defaults
    // (salary_currency defaults to 'USD') never invent a value the user did not choose.
    const experienceLevel = existingDbPrefs?.experience_level || null;
    const minSalary = existingDbPrefs?.min_salary ?? null;
    const salaryCurrency = existingDbPrefs?.salary_currency || null;
    // Keep a recorded digest choice; a new row gets false, never the column default (true).
    const dailyDigestOptIn = existingDbPrefs?.daily_digest_opt_in === true;
    const updatedAt = new Date().toISOString();

    // The validated preferences exactly as written, returned so the client caches what the DB holds.
    const savedPreferences: UserPreferences = {
      roles: sanitizedRoles,
      categories: mergedCategories,
      employmentTypes: sanitizedTypes,
      locations: mergedLocations,
      country: resolvedCountry.name,
      countryCode: resolvedCountry.code,
      workAuth: sanitizedWorkAuth,
      remotePreference: finalRemotePref,
      experienceLevel: experienceLevel || undefined,
      minSalary: minSalary ?? undefined,
      salaryCurrency: salaryCurrency || undefined,
      dailyDigestOptIn,
      onboardingCompleted: true,
      eligibilityFilter: existingDbPrefs?.eligibility_filter ?? true,
      updatedAt,
    };

    // Explicit column list (object literal): no request field reaches the DB unvetted.
    // Explicitly set deleted_at: null so fresh onboarding after a partial delete clears any tombstone.
    let { error: prefError } = await supabaseAdmin
      .from("user_preferences")
      .upsert({
        user_id: user.id,
        roles: sanitizedRoles,
        categories: mergedCategories,
        employment_types: sanitizedTypes,
        locations: mergedLocations,
        remote_preference: finalRemotePref,
        work_auth: sanitizedWorkAuth,
        country: resolvedCountry.name,
        country_code: resolvedCountry.code,
        experience_level: experienceLevel,
        min_salary: minSalary,
        salary_currency: salaryCurrency,
        daily_digest_opt_in: dailyDigestOptIn,
        onboarding_completed: true,
        deleted_at: null,
        updated_at: updatedAt,
      }, { onConflict: "user_id" });

    const isMissingSoftDeleteCol = (err: any) => {
      if (!err) return false;
      const msg = String(err.message || "").toLowerCase();
      return (err.code === "42703" || err.code === "PGRST204" || msg.includes("column")) && msg.includes("deleted_at");
    };

    if (prefError && isMissingSoftDeleteCol(prefError)) {
      prefError = (await supabaseAdmin
        .from("user_preferences")
        .upsert({
          user_id: user.id,
          roles: sanitizedRoles,
          categories: mergedCategories,
          employment_types: sanitizedTypes,
          locations: mergedLocations,
          remote_preference: finalRemotePref,
          work_auth: sanitizedWorkAuth,
          country: resolvedCountry.name,
          country_code: resolvedCountry.code,
          experience_level: experienceLevel,
          min_salary: minSalary,
          salary_currency: salaryCurrency,
          daily_digest_opt_in: dailyDigestOptIn,
          onboarding_completed: true,
          updated_at: updatedAt,
        }, { onConflict: "user_id" })).error;
    }

    // No retry without the country columns: a save that drops the country must never report success.
    if (prefError && isMissingCountryColumnError(prefError)) {
      log.error("user_preferences country columns missing; migration not applied", {
        migration: COUNTRY_MIGRATION,
        error: prefError.message,
      });
      return jsonResponse(
        { error: "Saving your country is temporarily unavailable. Please try again later." },
        503
      );
    }

    if (prefError) {
      log.error("Failed to persist user_preferences in /api/onboarding", { error: prefError.message });
      return jsonResponse({ error: "Failed to save preferences to database" }, 500);
    }

    // Persist account onboarding completion timestamp
    await markAccountOnboardingCompleted(supabaseAdmin, user.id);

    return jsonResponse({
      success: true,
      preferences: savedPreferences,
    });
  } catch (err: any) {
    log.error("Unhandled error in /api/onboarding", { error: err?.message || err });
    return jsonResponse({ error: "Internal server error while saving preferences" }, 500);
  }
}
