import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "../../src/lib/billing/serverEntitlement";
import {
  resolveOperation,
  buildOperationPayload,
  checkAndIncrementAiQuota,
  OPERATION_CONFIGS,
} from "../../src/lib/ai/security";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export async function handler(event: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };


  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // 1. Verify Authorization Header (Bearer Supabase access token)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Unauthorized. Please sign in to use AI features." }),
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !serviceKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Server authentication configuration missing." }),
      };
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Invalid or expired session. Please sign in again." }),
      };
    }

    // 2. Server-side Pro Entitlement check (Single Source of Truth)
    const entitlement = await getServerEntitlement(user.id);
    if (!entitlement.isPro) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: "CareerMonke Pro subscription required for AI features.",
          isPro: false,
          code: "PRO_REQUIRED",
        }),
      };
    }

    // 3. Parse Request Payload & Enforce Allowlisted Operations
    let body: any = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON request body." }),
      };
    }

    const opName = body.operation || body.feature;
    const config = resolveOperation(opName);

    if (!config) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `Invalid AI operation '${opName || "unspecified"}'. Allowed operations: ${Object.keys(OPERATION_CONFIGS).join(", ")}. Raw models and arbitrary messages are rejected.`,
          allowedOperations: Object.keys(OPERATION_CONFIGS),
        }),
      };
    }

    // Extract structured params (reject raw client messages)
    const params = body.params || body;
    const payloadResult = buildOperationPayload(config, params);
    if (!payloadResult.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: payloadResult.error }),
      };
    }

    const { payload } = payloadResult;

    // 4. Durable Quotas Enforcement (Per-User Daily Quota in Supabase)
    const quotaResult = await checkAndIncrementAiQuota(
      supabaseAdmin,
      user.id,
      config.operation,
      payload.estimatedInputTokens
    );

    if (!quotaResult.allowed) {
      if (quotaResult.isServiceUnavailable) {
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({
            error: quotaResult.error || "AI quota service is temporarily unavailable. Please try again shortly.",
            code: "AI_QUOTA_SERVICE_UNAVAILABLE",
          }),
        };
      }
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: `Daily AI usage quota exceeded for operation '${config.operation}' (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
          currentCount: quotaResult.currentCount,
          limit: quotaResult.limit,
        }),
      };
    }

    // 5. Server-Side Groq API Key Check
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({ error: "AI service is currently unavailable. Please check back shortly." }),
      };
    }

    // 6. Upstream Groq Call with Enforced Model, Tokens, & Server Prompts
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        max_tokens: payload.maxOutputTokens,
        temperature: payload.temperature,
        ...(payload.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!groqResponse.ok) {
      console.warn(`[AI Netlify Function] Upstream provider returned status ${groqResponse.status}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "AI service generation failed. Please try again." }),
      };
    }

    const groqData = await groqResponse.json();
    const content = groqData?.choices?.[0]?.message?.content || "";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        content,
        text: content,
        operation: config.operation,
        model: payload.model,
      }),
    };
  } catch (error) {
    console.warn("[AI Netlify Function] Internal error processing AI request:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal error processing AI request." }),
    };
  }
}
