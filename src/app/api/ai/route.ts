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
  validateAndSanitizeAiOutput,
} from "@/lib/ai/security";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";

export const runtime = "edge";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const ipRateLimitStore = new Map<string, RateLimitBucket>();
const userRateLimitStore = new Map<string, RateLimitBucket>();

const AI_RATE_LIMIT = {
  ipMaxRequests: 20,
  ipWindowMs: 60 * 1000,
  userMaxRequests: 10,
  userWindowMs: 60 * 1000,
};

function getClientIpFromRequest(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) {
    const first = xfwd.split(",")[0].trim();
    if (first) return first;
  }
  const clientIp =
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("client-ip");
  return clientIp || "anonymous-client";
}

function checkRateLimit(
  key: string,
  store: Map<string, RateLimitBucket>,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; retryAfter: number; currentCount: number } {
  const now = Date.now();
  let bucket = store.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    store.set(key, bucket);
    return { allowed: true, retryAfter: 0, currentCount: 1 };
  }

  if (bucket.count >= maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfter, currentCount: bucket.count };
  }

  bucket.count++;
  return { allowed: true, retryAfter: 0, currentCount: bucket.count };
}

export async function POST(req: Request) {
  try {
    // 0. Per-IP Rate Limiting (shared Supabase store, memory fallback)
    const clientIp = getClientIpFromRequest(req);
    const ipLimit = await checkSharedRateLimit(
      `ai:ip:${clientIp}`,
      AI_RATE_LIMIT.ipMaxRequests,
      AI_RATE_LIMIT.ipWindowMs / 1000,
      () =>
        checkRateLimit(
          clientIp,
          ipRateLimitStore,
          AI_RATE_LIMIT.ipMaxRequests,
          AI_RATE_LIMIT.ipWindowMs
        )
    );
    if (!ipLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many AI requests from this IP. Please wait before retrying.",
          retryAfter: ipLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(ipLimit.retryAfter),
          },
        }
      );
    }

    // 1. Verify Authorization Header (Bearer Supabase access token)
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in to use AI features." },
        { status: 401 }
      );
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

    const missingSupabase = checkRequiredEnv(
      {
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
      "API /ai"
    );
    if (missingSupabase) {
      return NextResponse.json(missingSupabase, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey!, {
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

    // 1.1 Per-User Burst Rate Limiting (shared Supabase store, memory fallback)
    const userLimit = await checkSharedRateLimit(
      `ai:user:${user.id}`,
      AI_RATE_LIMIT.userMaxRequests,
      AI_RATE_LIMIT.userWindowMs / 1000,
      () =>
        checkRateLimit(
          user.id,
          userRateLimitStore,
          AI_RATE_LIMIT.userMaxRequests,
          AI_RATE_LIMIT.userWindowMs
        )
    );
    if (!userLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many AI requests in a short time. Please wait before retrying.",
          retryAfter: userLimit.retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(userLimit.retryAfter),
          },
        }
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
        {
          status: 429,
          headers: {
            "Retry-After": "86400",
          },
        }
      );
    }

    // 5. Server-Side Groq API Key Check
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey || !groqApiKey.trim()) {
      console.error("[API /ai] Missing required environment variable: GROQ_API_KEY");
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        {
          error: "Missing required environment variable: GROQ_API_KEY",
          missingVariable: "GROQ_API_KEY",
        },
        { status: 500 }
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
      console.warn("[AI Route Handler] Network error calling upstream provider:", fetchErr);
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service request failed or timed out. Please try again." },
        { status: 502 }
      );
    }

    if (!groqResponse.ok) {
      console.warn(`[AI Route Handler] Upstream provider returned status ${groqResponse.status}`);
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
      console.warn("[AI Route Handler] Failed to parse upstream provider JSON:", parseErr);
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service returned an invalid response. Please try again." },
        { status: 502 }
      );
    }

    const content = groqData?.choices?.[0]?.message?.content;
    if (!content) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json(
        { error: "AI service returned an empty generation." },
        { status: 502 }
      );
    }

    const validated = validateAndSanitizeAiOutput(config.operation, content, params);
    if (!validated.ok) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return NextResponse.json({ error: validated.error }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      result: validated.parsedJson ?? validated.sanitizedText,
      content: validated.sanitizedText,
      text: validated.sanitizedText,
      operation: config.operation,
      model: payload.model,
      jobDescriptionShortened: payload.metadata?.jobDescriptionShortened ?? false,
    });
  } catch (err: any) {
    console.error("[AI Route Handler] Unhandled error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal server error occurred." },
      { status: 500 }
    );
  }
}

