import { buildCorsHeaders, handleCorsPreflight } from "./_cors";

const CORS_OPTIONS = {
  allowedMethods: "GET, HEAD, OPTIONS",
  allowedHeaders: "Content-Type",
};

export async function handler(event?: any) {
  // Handle CORS preflight
  const preflight = handleCorsPreflight(event, CORS_OPTIONS);
  if (preflight) return preflight;

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    ...buildCorsHeaders(event, CORS_OPTIONS),
  };

  const method = (event?.httpMethod || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  // Pure in-memory liveness probe: returns exactly { ok: true, time: ISOString }
  // ZERO database queries, ZERO secret or environment leaks
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      time: new Date().toISOString(),
    }),
  };
}
