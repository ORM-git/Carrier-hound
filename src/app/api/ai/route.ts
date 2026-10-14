import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import {
  resolveOperation,
  buildOperationPayload,
  checkAndIncrementAiQuota,
  refundAiQuota,
  OPERATION_CONFIGS,
} from "@/lib/ai/security";

export async function POST(req: Request) {
  try {
    // 1. Verify Authorization Header (Bearer Supabase access token)
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in to use AI features." },
        { status: 401 }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json(
        { error: "Server authentication configuration missing." },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid or expired session. Please sign in again." },
        { status: 401 }
      );
    }

    // Ban check (fails closed on lookup error)
    const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
    if (banCheck.isBlocked) {
      return NextResponse.json(
        { error: banCheck.error || "Account suspended. Access revoked by administrator." },
        { status: banCheck.isServiceUnavailable ? 503 : 403 }
      );
    }

    // 2. Server-side Pro Entitlement check (Single Source of Truth)
    const entitlement = await getServerEntitlement(user.id);
    if (!entitlement.isPro) {
      return NextResponse.json(
        {
          error: "CareerMonke Pro subscription required for AI features.",
          isPro: false,
          code: "PRO_REQUIRED",
        },
        { status: 403 }
      );
    }

    // 3. Parse Request Payload & Enforce Allowlisted Operations
    const body = await req.json().catch(() => ({}));
    const opName = body.operation || body.feature;
    const config = resolveOperation(opName);

    if (!config) {
      return NextResponse.json(
        {
          error: `Invalid AI operation '${opName || "unspecified"}'. Allowed operations: ${Object.keys(OPERATION_CONFIGS).join(", ")}. Raw models and arbitrary messages are rejected.`,
          allowedOperations: Object.keys(OPERATION_CONFIGS),
        },
        { status: 400 }
      );
    }

    // Extract structured params (reject raw client messages)
    const params = body.params || body;
    const payloadResult = buildOperationPayload(config, params);
    if (!payloadResult.ok) {
      return NextResponse.json(
        { error: payloadResult.error },
        { status: 400 }
      );
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
        return NextResponse.json(
          {
            error: quotaResult.error || "AI quota service is temporarily unavailable. Please try again shortly.",
            code: "AI_QUOTA_SERVICE_UNAVAILABLE",
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        {
          error: `Daily AI usage quota exceeded for operation '${config.operation}' (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
          currentCount: quotaResult.currentCount,
          limit: quotaResult.limit,
        },
        { status: 429 }
      );
    }

    // 5. Server-Side Groq API Key Check
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service is currently unavailable. Please check back shortly." },
        { status: 503 }
      );
    }

    // 6. Upstream Groq Call with Enforced Model, Tokens, & Server Prompts
    let groqResponse: Response;
    try {
      groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
    } catch (fetchErr) {
      console.warn("[AI Route] Network error calling upstream provider:", fetchErr);
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service request failed or timed out. Please try again." },
        { status: 502 }
      );
    }

    if (!groqResponse.ok) {
      console.warn(`[AI Route] Upstream provider returned status ${groqResponse.status}`);
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service generation failed. Please try again." },
        { status: 502 }
      );
    }

    let groqData: any;
    try {
      groqData = await groqResponse.json();
    } catch (parseErr) {
      console.warn("[AI Route] Failed to parse upstream provider JSON:", parseErr);
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service returned an invalid response. Please try again." },
        { status: 502 }
      );
    }

    const content = groqData?.choices?.[0]?.message?.content || "";

    return NextResponse.json({
      content,
      text: content,
      operation: config.operation,
      model: payload.model,
    });
  } catch (error) {
    console.warn("[AI Route] Internal error processing AI request:", error);
    return NextResponse.json(
      { error: "Internal error processing AI request." },
      { status: 500 }
    );
  }
}
