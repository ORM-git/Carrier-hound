import {
  handleNetlifyAiRequest,
  _resetAiRateLimitStore,
  AI_RATE_LIMIT,
  RateLimitBucket,
  getNetlifyClientIp,
} from "../../src/lib/ai/serviceHandler";
import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

/**
 * Netlify serverless handler for /api/ai.
 * The second argument `context` is the platform runtime context and must never be treated as test dependencies.
 */
export async function handler(event: any, context?: any) {
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  // Launch scope gate: AI features are Coming Soon (evaluated before env checks so missing keys still return 503)
  return {
    statusCode: 503,
    headers,
    body: JSON.stringify({
      error: "This feature is coming soon.",
      code: "FEATURE_COMING_SOON",
    }),
  };
}

export function createHandler(deps: any = {}) {
  return async (event: any, context?: any) => {
    if (deps?.bypassComingSoon) {
      return handleNetlifyAiRequest(event, deps);
    }
    const preflight = handleCorsPreflight(event, CORS_OPTIONS);
    if (preflight) return preflight;

    const headers = {
      "Content-Type": "application/json",
      ...buildCorsHeaders(event, CORS_OPTIONS),
    };

    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error: "This feature is coming soon.",
        code: "FEATURE_COMING_SOON",
      }),
    };
  };
}

export { handler as netlifyAiHandler };

export function getClientIp(event: any): string {
  return getNetlifyClientIp(event);
}

export { _resetAiRateLimitStore, AI_RATE_LIMIT };
export type { RateLimitBucket };
