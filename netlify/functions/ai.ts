import {
  handleNetlifyAiRequest,
  _resetAiRateLimitStore,
  AI_RATE_LIMIT,
  RateLimitBucket,
  getNetlifyClientIp,
} from "../../src/lib/ai/serviceHandler";

/**
 * Netlify serverless handler for /api/ai.
 * The second argument `context` is the platform runtime context and must never be treated as test dependencies.
 */
export async function handler(event: any, context?: any) {
  return handleNetlifyAiRequest(event);
}

export function getClientIp(event: any): string {
  return getNetlifyClientIp(event);
}

export { _resetAiRateLimitStore, AI_RATE_LIMIT };
export type { RateLimitBucket };
