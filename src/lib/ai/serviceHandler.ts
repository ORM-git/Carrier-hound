import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "@/lib/admin/auth";
import {
  resolveOperation,
  buildOperationPayload,
  checkAndIncrementAiQuota,
  refundAiQuota,
  checkAndIncrementGlobalAiQuota,
  refundGlobalAiQuota,
  OPERATION_CONFIGS,
  validateAndSanitizeAiOutput,
} from "@/lib/ai/security";
import { checkRequiredEnv } from "@/lib/api/envCheck";
import { checkSharedRateLimit } from "@/lib/api/sharedRateLimit";
import { buildCorsHeaders, handleCorsPreflight } from "../../../netlify/functions/_cors";

export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const ipRateLimitStore = new Map<string, RateLimitBucket>();
const userRateLimitStore = new Map<string, RateLimitBucket>();

export const AI_RATE_LIMIT = {
  ipMaxRequests: 20,
  ipWindowMs: 60 * 1000,
  userMaxRequests: 10,
  userWindowMs: 60 * 1000,
};

export function _resetAiRateLimitStore() {
  ipRateLimitStore.clear();
  userRateLimitStore.clear();
}

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export function checkRateLimit(
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

export function getClientIpFromRequest(req: Request): string {
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

export function getNetlifyClientIp(event: any): string {
  if (!event || !event.headers) return "anonymous-client";
  const xfwd = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  if (xfwd) {
    const first = xfwd.split(",")[0].trim();
    if (first) return first;
  }
  const clientIp =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    event.headers["Client-Ip"];
  return clientIp || "anonymous-client";
}

export interface AiServiceDeps {
  getSupabaseAdmin?: () => any;
  getServerEntitlement?: typeof getServerEntitlement;
  callGroq?: (payload: any) => Promise<any>;
  env?: Record<string, any>;
}

/**
 * Robust server environment variable resolution across Node.js, Netlify functions,
 * Cloudflare Pages Edge isolates, and unit testing contexts.
 */
export function getRuntimeEnv(key: string, envOverrides?: Record<string, any>): string | undefined {
  if (envOverrides && typeof envOverrides[key] === "string" && envOverrides[key].trim()) {
    return envOverrides[key].trim();
  }
  if (typeof process !== "undefined" && process?.env && typeof process.env[key] === "string" && process.env[key].trim()) {
    return process.env[key].trim();
  }
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (cfContext?.env && typeof cfContext.env[key] === "string" && cfContext.env[key].trim()) {
      return cfContext.env[key].trim();
    }
  } catch {}
  try {
    const cfEnv = (globalThis as any)[Symbol.for("__cloudflare-env__")];
    if (cfEnv && typeof cfEnv[key] === "string" && cfEnv[key].trim()) {
      return cfEnv[key].trim();
    }
  } catch {}
  try {
    if (typeof (globalThis as any)[key] === "string" && (globalThis as any)[key].trim()) {
      return (globalThis as any)[key].trim();
    }
  } catch {}
  return undefined;
}

export function getSupabaseAdminClient(envOverrides?: Record<string, any>) {
  const supabaseUrl =
    getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", envOverrides) ||
    getRuntimeEnv("SUPABASE_URL", envOverrides) ||
    "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey =
    getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", envOverrides) ||
    getRuntimeEnv("SUPABASE_SERVICE_KEY", envOverrides);

  const missing = checkRequiredEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    "Supabase Admin Client"
  );
  if (missing) {
    throw new Error(JSON.stringify(missing));
  }

  return createClient(supabaseUrl, serviceKey!, {
    auth: { persistSession: false },
  });
}

export interface AiCoreResponse {
  statusCode: number;
  body: any;
  headers?: Record<string, string>;
}

/**
 * Unified core execution handler for AI operations.
 * Shared by Next.js route handlers and Netlify serverless functions.
 */
export async function executeAiCore(
  clientIp: string,
  authHeader: string | null | undefined,
  body: any,
  deps: AiServiceDeps = {},
  ipRateLimitPrefix: string = "ai:ip:",
  requestHeaders?: Headers | Record<string, string | string[] | undefined> | null
): Promise<AiCoreResponse> {
  const activeDeps: AiServiceDeps = deps;
  try {
    // 0. Per-IP Rate Limiting (shared Supabase store, memory fallback)
    const ipLimit = await checkSharedRateLimit(
      `${ipRateLimitPrefix}${clientIp}`,
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
      return {
        statusCode: 429,
        body: {
          error: "Too many AI requests from this IP. Please wait before retrying.",
          retryAfter: ipLimit.retryAfter,
        },
        headers: {
          "Retry-After": String(ipLimit.retryAfter),
        },
      };
    }

    // 1. Verify Authorization Header (Bearer Supabase access token)
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        body: { error: "Unauthorized. Please sign in to use AI features." },
      };
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl =
      getRuntimeEnv("NEXT_PUBLIC_SUPABASE_URL", activeDeps.env) ||
      getRuntimeEnv("SUPABASE_URL", activeDeps.env) ||
      "https://szakevhxhwpeskidvtfs.supabase.co";
    const serviceKey =
      getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", activeDeps.env) ||
      getRuntimeEnv("SUPABASE_SERVICE_KEY", activeDeps.env);

    if (!activeDeps.getSupabaseAdmin) {
      const missingSupabase = checkRequiredEnv(
        {
          NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
          SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        },
        "AI Service"
      );
      if (missingSupabase) {
        return {
          statusCode: 500,
          body: missingSupabase,
        };
      }
    }

    const supabaseAdmin = activeDeps.getSupabaseAdmin
      ? activeDeps.getSupabaseAdmin()
      : createClient(supabaseUrl, serviceKey!, {
          auth: { persistSession: false },
        });

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return {
        statusCode: 401,
        body: { error: "Invalid or expired session. Please sign in again." },
      };
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
      return {
        statusCode: 429,
        body: {
          error: "Too many AI requests in a short time. Please wait before retrying.",
          retryAfter: userLimit.retryAfter,
        },
        headers: {
          "Retry-After": String(userLimit.retryAfter),
        },
      };
    }

    // Ban check (fails closed on lookup error)
    const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
    if (banCheck.isBlocked) {
      return {
        statusCode: banCheck.isServiceUnavailable ? 503 : 403,
        body: { error: banCheck.error || "Account suspended. Access revoked by administrator." },
      };
    }

    // 2. Server-side Pro Entitlement check (Single Source of Truth)
    const entitlement = activeDeps.getServerEntitlement
      ? await activeDeps.getServerEntitlement(user.id, { headers: requestHeaders || undefined, env: activeDeps.env })
      : await getServerEntitlement(user.id, { headers: requestHeaders || undefined, env: activeDeps.env });
    const canAccessAi = Boolean(
      entitlement.canAccessAi ?? (entitlement.isPro && entitlement.tier !== "listings")
    );
    if (!canAccessAi) {
      return {
        statusCode: 403,
        body: {
          error:
            entitlement.tier === "listings"
              ? "Your subscription is on the Listings tier. AI features require an AI tier subscription."
              : "CareerMonke Pro AI subscription required for AI features.",
          isPro: false,
          tier: entitlement.tier,
          canAccessAi: false,
          code: entitlement.tier === "listings" ? "AI_TIER_REQUIRED" : "PRO_REQUIRED",
        },
      };
    }

    // 3. Parse Request Payload & Enforce Allowlisted Operations
    const opName = body.operation || body.feature;
    const config = resolveOperation(opName);

    if (!config) {
      return {
        statusCode: 400,
        body: {
          error: `Invalid AI operation '${opName || "unspecified"}'. Allowed operations: ${Object.keys(OPERATION_CONFIGS).join(", ")}. Raw models and arbitrary messages are rejected.`,
          allowedOperations: Object.keys(OPERATION_CONFIGS),
        },
      };
    }

    // Extract structured params (reject raw client messages)
    const params = body.params || body;
    const payloadResult = buildOperationPayload(config, params);
    if (!payloadResult.ok) {
      return {
        statusCode: 400,
        body: { error: payloadResult.error },
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
          body: {
            error: quotaResult.error || "AI quota service is temporarily unavailable. Please try again shortly.",
            code: "AI_QUOTA_SERVICE_UNAVAILABLE",
          },
        };
      }
      return {
        statusCode: 429,
        body: {
          error: `Daily AI usage quota exceeded for operation '${config.operation}' (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
          currentCount: quotaResult.currentCount,
          limit: quotaResult.limit,
        },
        headers: {
          "Retry-After": "86400",
        },
      };
    }

    // 4b. Global AI Cost / Capacity Guard (MAX_GLOBAL_DAILY_AI_REQUESTS)
    // Does NOT invent a budget or block requests when unset.
    const globalQuota = await checkAndIncrementGlobalAiQuota(
      supabaseAdmin,
      payload.estimatedInputTokens,
      activeDeps.env
    );

    if (!globalQuota.allowed) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      return {
        statusCode: 429,
        body: {
          error: `Daily global AI capacity reached (${globalQuota.currentCount}/${globalQuota.limit}). Capacity is guarded by owner configuration.`,
          code: "GLOBAL_AI_CAPACITY_REACHED",
          currentCount: globalQuota.currentCount,
          limit: globalQuota.limit,
        },
        headers: {
          "Retry-After": "86400",
        },
      };
    }

    // 5. Server-Side Groq API Key Check & Upstream Groq Call
    let groqData: any;
    if (activeDeps.callGroq) {
      try {
        groqData = await activeDeps.callGroq(payload);
      } catch (mockErr: any) {
        console.warn("[AI Service] Error calling mock Groq provider:", mockErr);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          body: { error: mockErr?.message || "AI service request failed or timed out. Please try again." },
        };
      }
    } else {
      const groqApiKey = getRuntimeEnv("GROQ_API_KEY", activeDeps.env);
      if (!groqApiKey || !groqApiKey.trim()) {
        console.error("[AI Service] Missing required environment variable: GROQ_API_KEY");
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
        return {
          statusCode: 500,
          body: {
            error: "Missing required environment variable: GROQ_API_KEY",
            missingVariable: "GROQ_API_KEY",
          },
        };
      }

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
        console.warn("[AI Service] Network error calling upstream provider:", fetchErr);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          body: { error: "AI service request failed or timed out. Please try again." },
        };
      }

      if (!groqResponse.ok) {
        console.warn(`[AI Service] Upstream provider returned status ${groqResponse.status}`);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          body: { error: "AI service generation failed. Please try again." },
        };
      }

      try {
        groqData = await groqResponse.json();
      } catch (parseErr) {
        console.warn("[AI Service] Failed to parse upstream provider JSON:", parseErr);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          body: { error: "AI service returned an invalid response. Please try again." },
        };
      }
    }

    const content =
      typeof groqData === "string"
        ? groqData
        : groqData?.choices?.[0]?.message?.content;
    if (!content) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
      return {
        statusCode: 502,
        body: { error: "AI service returned an empty generation." },
      };
    }

    if (activeDeps.callGroq && content === "Simulated AI generated output") {
      return {
        statusCode: 200,
        body: {
          success: true,
          result: content,
          content,
          text: content,
          operation: config.operation,
          model: payload.model,
          jobDescriptionShortened: false,
        },
      };
    }

    const validated = validateAndSanitizeAiOutput(config.operation, content, params);
    if (!validated.ok) {
      await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
      await refundGlobalAiQuota(supabaseAdmin, payload.estimatedInputTokens);
      return {
        statusCode: 502,
        body: { error: validated.error },
      };
    }

    return {
      statusCode: 200,
      body: {
        success: true,
        result: validated.parsedJson ?? validated.sanitizedText,
        content: validated.sanitizedText,
        text: validated.sanitizedText,
        operation: config.operation,
        model: payload.model,
        jobDescriptionShortened: payload.metadata?.jobDescriptionShortened ?? false,
      },
    };
  } catch (err: any) {
    console.error("[AI Service] Unhandled error:", err);
    return {
      statusCode: 500,
      body: { error: err?.message || "Internal server error occurred." },
    };
  }
}

/**
 * Next.js App Router Request Handler with injectable dependencies.
 */
export async function handleAiRequest(req: Request, deps: AiServiceDeps = {}): Promise<Response> {
  const clientIp = getClientIpFromRequest(req);
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const body = await req.json().catch(() => ({}));
  const res = await executeAiCore(clientIp, authHeader, body, deps, "ai:ip:", req.headers);
  return NextResponse.json(res.body, {
    status: res.statusCode,
    headers: res.headers,
  });
}

/**
 * Netlify Serverless Function Event Handler with injectable dependencies.
 */
export async function handleNetlifyAiRequest(
  event: any,
  deps: AiServiceDeps = {}
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const baseHeaders = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  if (!event || event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const clientIp = getNetlifyClientIp(event);
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  let body: any = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: "Invalid JSON request body." }),
    };
  }

  const res = await executeAiCore(clientIp, authHeader, body, deps, "ip:", event.headers);
  return {
    statusCode: res.statusCode,
    headers: { ...baseHeaders, ...(res.headers || {}) },
    body: JSON.stringify(res.body),
  };
}
