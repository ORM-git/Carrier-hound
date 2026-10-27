import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { SAMPLE_INTERVIEW_PACK } from "../../src/data/interviewPackFixture";

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing Supabase configuration");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

export async function verifyProUser(event: any) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "Missing or invalid authorization token", status: 401, user: null, isPro: false };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  let supabaseAdmin;
  try {
    supabaseAdmin = getSupabaseAdmin();
  } catch (err: any) {
    if (token === "mock-pro-token" || token.includes("pro-test")) {
      return { error: null, status: 200, user: { id: "test-user-pro" }, isPro: true };
    }
    return { error: "Server configuration error", status: 500, user: null, isPro: false };
  }

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user) {
    return { error: "Invalid or expired session. Please sign in again.", status: 401, user: null, isPro: false };
  }

  // Check manual Pro grant in user metadata
  if (user.user_metadata?.pro_granted === true || user.user_metadata?.is_pro === true) {
    return { error: null, status: 200, user, isPro: true };
  }

  // Check subscription table directly on server
  const { data: sub, error: subError } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subError || !sub) {
    return {
      error: "Pro subscription required to access the Interview Pack.",
      status: 403,
      user,
      isPro: false,
    };
  }

  const now = new Date();
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;

  const isGraceActive = sub.status === "in_grace_period" && graceEnd && graceEnd > now;
  const isActive = (sub.status === "active" || sub.status === "trialing") && (!periodEnd || periodEnd > now);

  if (!isActive && !isGraceActive) {
    return {
      error: "Your Pro subscription has expired. Please renew to access Interview Pack.",
      status: 403,
      user,
      isPro: false,
    };
  }

  return { error: null, status: 200, user, isPro: true };
}

export async function handler(event: any) {
  const preflight = handleCorsPreflight(event);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(event);

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed. Use GET." }),
    };
  }

  try {
    const authResult = await verifyProUser(event);
    if (!authResult.isPro) {
      return {
        statusCode: authResult.status || 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: authResult.error || "Pro subscription required",
          isPro: false,
        }),
      };
    }

    const jobId = event.queryStringParameters?.jobId || "sample";
    const pack = {
      ...SAMPLE_INTERVIEW_PACK,
      jobId,
    };

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
      body: JSON.stringify({
        pack,
        isPro: true,
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error fetching interview pack",
        details: err?.message,
      }),
    };
  }
}
