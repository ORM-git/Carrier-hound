import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { processUnsubscribe, verifyUnsubscribeToken } from "../../src/lib/email/unsubscribe";
import { recordEmailSuppression } from "../../src/lib/events/failedEvents";

const CORS_OPTIONS = {
  allowedMethods: "GET, POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!serviceKey) {
    throw new Error("Missing required SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

export async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(event, CORS_OPTIONS);

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: "Method not allowed. Use GET or POST." }),
    };
  }

  try {
    // 1. Extract token from queryStringParameters or body
    let token = event.queryStringParameters?.token;

    if (!token && event.body && event.httpMethod === "POST") {
      try {
        const parsed = JSON.parse(event.body);
        token = parsed?.token;
      } catch {
        const params = new URLSearchParams(event.body);
        token = params.get("token");
      }
    }

    if (!token) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: "Missing required 'token' parameter." }),
      };
    }

    // 2. Verify token
    const verification = await verifyUnsubscribeToken(token);
    if (!verification.valid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: `Unsubscribe failed: ${verification.reason}` }),
      };
    }

    // 3. Connect Supabase Admin and record suppression
    const supabaseAdmin = getSupabaseAdmin();
    const result = await recordEmailSuppression(
      supabaseAdmin,
      verification.email,
      "unsubscribe"
    );

    if (!result.ok) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: result.error || "Failed to persist suppression" }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        unsubscribed: true,
        message: `Successfully unsubscribed from ${verification.topic} emails.`,
        email: verification.email,
        topic: verification.topic,
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: err?.message || "Internal server error" }),
    };
  }
}
