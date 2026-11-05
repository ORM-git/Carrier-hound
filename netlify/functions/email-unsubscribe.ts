import { createClient } from "@supabase/supabase-js";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import {
  verifyUnsubscribeToken,
  processUnsubscribe,
  renderUnsubscribeConfirmationHtml,
  renderUnsubscribeSuccessHtml,
  renderUnsubscribeErrorHtml,
} from "../../src/lib/email/unsubscribe";

const CORS_OPTIONS = {
  allowedMethods: "GET, POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

function getSupabaseAdmin() {
  if ((globalThis as any).__mockSupabaseClient) {
    return (globalThis as any).__mockSupabaseClient;
  }
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
  const acceptHeader = event.headers?.accept || event.headers?.Accept || "";
  const prefersHtml =
    acceptHeader.includes("text/html") && !acceptHeader.includes("application/json");

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: "Method not allowed. Use GET or POST." }),
    };
  }

  try {
    // ------------------------------------------------------------------------
    // GET: Render confirmation page with button; DO NOT perform suppression
    // ------------------------------------------------------------------------
    if (event.httpMethod === "GET") {
      const token = event.queryStringParameters?.token;
      if (!token) {
        return {
          statusCode: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
          body: renderUnsubscribeErrorHtml("Missing required 'token' parameter."),
        };
      }

      const verification = await verifyUnsubscribeToken(token);
      if (!verification.valid) {
        return {
          statusCode: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
          body: renderUnsubscribeErrorHtml(
            `This unsubscribe link is invalid or has expired: ${verification.reason}`
          ),
        };
      }

      const html = renderUnsubscribeConfirmationHtml({
        email: verification.email,
        topic: verification.topic,
        token,
        postUrl: "/api/email/unsubscribe",
      });

      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
        body: html,
      };
    }

    // ------------------------------------------------------------------------
    // POST: Perform actual suppression (RFC 8058 One-Click / user confirmation)
    // ------------------------------------------------------------------------
    let token = event.queryStringParameters?.token;

    if (!token && event.body) {
      try {
        const parsed = JSON.parse(event.body);
        token = parsed?.token;
      } catch {
        const params = new URLSearchParams(event.body);
        token = params.get("token");
      }
    }

    if (!token) {
      if (prefersHtml) {
        return {
          statusCode: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
          body: renderUnsubscribeErrorHtml("Missing required 'token' parameter."),
        };
      }
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: "Missing required 'token' parameter." }),
      };
    }

    const supabaseAdmin = getSupabaseAdmin();
    const result = await processUnsubscribe(supabaseAdmin, token);

    if (!result.ok) {
      if (prefersHtml) {
        return {
          statusCode: result.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/html; charset=utf-8",
          },
          body: renderUnsubscribeErrorHtml(result.message),
        };
      }
      return {
        statusCode: result.status,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: result.message }),
      };
    }

    if (prefersHtml) {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
        body: renderUnsubscribeSuccessHtml({
          email: result.email,
          topic: result.topic,
          message: result.message,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        unsubscribed: true,
        message: result.message,
        email: result.email,
        topic: result.topic,
      }),
    };
  } catch (err: any) {
    if (prefersHtml) {
      return {
        statusCode: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
        body: renderUnsubscribeErrorHtml(err?.message || "Internal server error"),
      };
    }
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: err?.message || "Internal server error" }),
    };
  }
}
