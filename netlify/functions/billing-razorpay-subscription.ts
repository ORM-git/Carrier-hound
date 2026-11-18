import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

/**
 * Recurring (auto-renew) Razorpay subscriptions are disabled for launch.
 *
 * All plans are one-time prepaid orders created via billing-razorpay-order.
 * This function is intentionally inert: it never reads NEXT_PUBLIC_AUTORENEW_ENABLED,
 * never touches Supabase or Razorpay, and always answers 410 Gone to POST requests.
 */
const CORS_OPTIONS = {
  allowedMethods: "POST, OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
};

export function createHandler() {
  return async function handler(event: any) {
    const preflight = handleCorsPreflight(event, CORS_OPTIONS);
    if (preflight) return preflight;

    const headers = {
      "Content-Type": "application/json",
      ...buildCorsHeaders(event, CORS_OPTIONS),
    };

    if (event?.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    return {
      statusCode: 410,
      headers,
      body: JSON.stringify({
        error: "Recurring subscriptions are disabled. All plans are one-time prepaid purchases.",
        code: "RECURRING_DISABLED",
      }),
    };
  };
}

export const handler = createHandler();
