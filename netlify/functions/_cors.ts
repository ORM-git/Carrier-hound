/**
 * Shared CORS helper for Netlify serverless functions.
 * Strictly enforces an allow-list of origins. Never uses wildcard '*' or echoes unknown origins.
 * Always sends 'Vary: Origin'.
 */

export interface CorsOptions {
  allowedMethods?: string;
  allowedHeaders?: string;
}

export function getRequestOrigin(event: any): string | null {
  if (!event || !event.headers) return null;
  return event.headers["origin"] || event.headers["Origin"] || null;
}

export function buildCorsHeaders(
  eventOrOrigin: any,
  options: CorsOptions = {}
): Record<string, string> {
  const origin =
    typeof eventOrOrigin === "string"
      ? eventOrOrigin
      : getRequestOrigin(eventOrOrigin);

  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.CONTEXT === "production";
  const allowLocalhost =
    !isProd || process.env.ALLOW_LOCALHOST_CORS === "true";

  // Canonical allow-list
  const allowedSet = new Set<string>([
    "https://careermonke.com",
    "https://www.careermonke.com",
    "https://careermonke.netlify.app",
    "https://careermonke12.netlify.app",
    "https://carrier-hound.pages.dev",
    "https://careerhound.netlify.app",
  ]);

  if (process.env.NEXT_PUBLIC_SITE_URL) {
    allowedSet.add(process.env.NEXT_PUBLIC_SITE_URL.trim().replace(/\/+$/, ""));
  }
  if (process.env.URL) {
    allowedSet.add(process.env.URL.trim().replace(/\/+$/, ""));
  }
  if (process.env.DEPLOY_PRIME_URL) {
    allowedSet.add(process.env.DEPLOY_PRIME_URL.trim().replace(/\/+$/, ""));
  }

  if (process.env.CORS_ALLOWED_ORIGINS) {
    process.env.CORS_ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .forEach((o) => allowedSet.add(o));
  }

  if (allowLocalhost) {
    allowedSet.add("http://localhost:3000");
    allowedSet.add("http://127.0.0.1:3000");
    allowedSet.add("http://localhost:3001");
    allowedSet.add("http://127.0.0.1:3001");
  }

  const normalizedOrigin = origin ? origin.trim().replace(/\/+$/, "") : null;
  const isAllowed = normalizedOrigin
    ? allowedSet.has(normalizedOrigin) || /^https:\/\/[a-zA-Z0-9-]+\.carrier-hound\.pages\.dev$/.test(normalizedOrigin)
    : false;

  const headers: Record<string, string> = {
    Vary: "Origin",
  };

  if (isAllowed && normalizedOrigin) {
    headers["Access-Control-Allow-Origin"] = normalizedOrigin;
    if (options.allowedMethods) {
      headers["Access-Control-Allow-Methods"] = options.allowedMethods;
    }
    if (options.allowedHeaders) {
      headers["Access-Control-Allow-Headers"] = options.allowedHeaders;
    }
  }

  return headers;
}

export function handleCorsPreflight(
  event: any,
  options: CorsOptions = {}
): { statusCode: number; headers: Record<string, string>; body: string } | null {
  if (event && event.httpMethod === "OPTIONS") {
    const corsHeaders = buildCorsHeaders(event, options);
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }
  return null;
}
