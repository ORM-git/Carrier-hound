import { createClient } from "@supabase/supabase-js";
import { getServerEntitlement as defaultGetServerEntitlement } from "../../src/lib/billing/serverEntitlement";
import { verifyUserNotBanned } from "../../src/lib/admin/auth";
import {
  resolveOperation,
  buildOperationPayload,
  checkAndIncrementAiQuota,
  refundAiQuota,
  OPERATION_CONFIGS,
} from "../../src/lib/ai/security";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";
import { safeLog } from "./_logger";

export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

// In-memory rate-limit stores (best-effort per serverless container)
// Note: In-memory counters do not persist across distinct serverless instances or cold starts.
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

export function getClientIp(event: any): string {
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

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export interface AiHandlerDeps {
  getSupabaseAdmin?: () => any;
  callGroq?: (payload: any) => Promise<any>;
  getServerEntitlement?: (userId: string) => Promise<{ isPro: boolean }>;
}

export function createHandler(deps: AiHandlerDeps = {}) {
  const entitlementChecker = deps.getServerEntitlement || defaultGetServerEntitlement;

  return async function handler(event: any) {
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
      // 0. Per-IP Rate Limiting (in-memory sliding window)
      const clientIp = getClientIp(event);
      const ipLimit = checkRateLimit(
        clientIp,
        ipRateLimitStore,
        AI_RATE_LIMIT.ipMaxRequests,
        AI_RATE_LIMIT.ipWindowMs
      );
      if (!ipLimit.allowed) {
        return {
          statusCode: 429,
          headers: {
            ...headers,
            "Retry-After": String(ipLimit.retryAfter),
          },
          body: JSON.stringify({
            error: "Too many AI requests from this IP. Please wait before retrying.",
            retryAfter: ipLimit.retryAfter,
          }),
        };
      }

      // 1. Verify Authorization Header (Bearer Supabase access token)
      const authHeader = event.headers?.authorization || event.headers?.Authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: "Unauthorized. Please sign in to use AI features." }),
        };
      }

      const token = authHeader.replace("Bearer ", "").trim();
      let supabaseAdmin: any;
      if (deps.getSupabaseAdmin) {
        supabaseAdmin = deps.getSupabaseAdmin();
      } else {
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

        supabaseAdmin = createClient(supabaseUrl, serviceKey, {
          auth: { persistSession: false },
        });
      }


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

      // 1.1 Per-User Burst Rate Limiting (in-memory sliding window)
      const userLimit = checkRateLimit(
        user.id,
        userRateLimitStore,
        AI_RATE_LIMIT.userMaxRequests,
        AI_RATE_LIMIT.userWindowMs
      );
      if (!userLimit.allowed) {
        return {
          statusCode: 429,
          headers: {
            ...headers,
            "Retry-After": String(userLimit.retryAfter),
          },
          body: JSON.stringify({
            error: "Too many AI requests in a short time. Please wait before retrying.",
            retryAfter: userLimit.retryAfter,
          }),
        };
      }

      // Ban check (fails closed on lookup error)
      const banCheck = await verifyUserNotBanned(supabaseAdmin, user.id, user.user_metadata);
      if (banCheck.isBlocked) {
        return {
          statusCode: banCheck.isServiceUnavailable ? 503 : 403,
          headers,
          body: JSON.stringify({ error: banCheck.error || "Account suspended. Access revoked by administrator." }),
        };
      }

      // 2. Server-side Pro Entitlement check (Single Source of Truth)
      const entitlement = await entitlementChecker(user.id);
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
      } catch (parseErr) {
        safeLog.warn("[Netlify /ai] Request body parse error", parseErr);
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
          headers: {
            ...headers,
            "Retry-After": "86400",
          },
          body: JSON.stringify({
            error: `Daily AI usage quota exceeded for operation '${config.operation}' (${quotaResult.currentCount}/${quotaResult.limit}). Quotas reset daily at midnight UTC.`,
            currentCount: quotaResult.currentCount,
            limit: quotaResult.limit,
          }),
        };
      }

      // 5. Server-Side Groq Execution (injected or direct network)
      if (deps.callGroq) {
        try {
          const result = await deps.callGroq(payload);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              result,
              operation: config.operation,
            }),
          };
        } catch (callErr: any) {
          await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
          return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: callErr?.message || "AI service execution failed." }),
          };
        }
      }

      const groqApiKey = process.env.GROQ_API_KEY;
      if (!groqApiKey) {
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        return {
          statusCode: 503,
          headers,
          body: JSON.stringify({ error: "AI service is currently unavailable. Please check back shortly." }),
        };
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
        console.warn("[AI Netlify Function] Network error calling upstream provider:", fetchErr);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: "AI service request failed or timed out. Please try again." }),
        };
      }

      if (!groqResponse.ok) {
        console.warn(`[AI Netlify Function] Upstream provider returned status ${groqResponse.status}`);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: "AI service generation failed. Please try again." }),
        };
      }

      let groqData: any;
      try {
        groqData = await groqResponse.json();
      } catch (parseErr) {
        console.warn("[AI Netlify Function] Failed to parse upstream provider JSON:", parseErr);
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: "AI service returned an invalid response. Please try again." }),
        };
      }

      const content = groqData?.choices?.[0]?.message?.content;
      if (!content) {
        await refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens);
        return {
          statusCode: 502,
          headers,
          body: JSON.stringify({ error: "AI service returned an empty generation." }),
        };
      }

      let parsedResult = content;
      if (payload.jsonMode) {
        try {
          parsedResult = JSON.parse(content);
        } catch {
          parsedResult = content;
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          result: parsedResult,
          operation: config.operation,
        }),
      };
    } catch (err: any) {
      console.error("[AI Netlify Function] Unhandled error:", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err?.message || "Internal server error occurred." }),
      };
    }
  };
}

export const handler = createHandler();
