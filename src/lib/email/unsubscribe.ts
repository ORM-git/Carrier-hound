/**
 * src/lib/email/unsubscribe.ts
 *
 * Cryptographic HMAC signed-token one-click email unsubscribe flow (RFC 8058).
 * Handles token generation, tamper verification, header production, HTML confirmation
 * rendering, and database suppression recording in public.email_suppressions.
 *
 * Edge runtime and browser compatible using standard Web Crypto API.
 */

import { recordEmailSuppression } from "../events/failedEvents";

export interface UnsubscribePayload {
  email: string;
  topic: string;
  iat: number;
  exp: number;
}

export type TokenVerificationResult =
  | { valid: true; email: string; topic: string; exp: number }
  | { valid: false; reason: string };

/**
 * Resolves the server HMAC signing secret from environment.
 * Requires dedicated UNSUBSCRIBE_SECRET; fails closed (throws) if missing.
 */
export function getUnsubscribeSecret(envOverrides?: Record<string, any>): string {
  const secret = envOverrides?.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET;
  if (!secret || typeof secret !== "string" || secret.trim() === "") {
    throw new Error(
      "Missing required UNSUBSCRIBE_SECRET environment variable for email unsubscribe token signing (fail closed)."
    );
  }
  return secret.trim();
}

/**
 * Helper to encode UTF-8 string to base64url.
 */
function encodeBase64Url(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Helper to decode base64url string to UTF-8.
 */
function decodeBase64Url(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64url").toString("utf8");
  }
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Constant-time string comparison preventing timing oracles.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Computes HMAC-SHA256 digest in base64url format using Web Crypto API.
 */
async function computeHmacSha256Base64Url(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const bytes = new Uint8Array(signatureBuffer);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates an HMAC-SHA256 signed URL-safe token for one-click unsubscribe.
 * @param email Target recipient email
 * @param topic Subscription topic (e.g., 'digest', 'marketing', 'all')
 * @param expiresInDays Token lifetime (defaults to 90 days)
 * @param customSecret Optional secret override for isolated testing
 */
export async function generateUnsubscribeToken(
  email: string,
  topic: string = "digest",
  expiresInDays: number = 90,
  customSecret?: string
): Promise<string> {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new Error("Invalid email for unsubscribe token generation");
  }

  const now = Date.now();
  const exp = now + expiresInDays * 24 * 60 * 60 * 1000;
  const payload: UnsubscribePayload = {
    email: normalized,
    topic: String(topic || "digest").trim().toLowerCase(),
    iat: now,
    exp,
  };

  const serialized = encodeBase64Url(JSON.stringify(payload));
  const secret = customSecret || getUnsubscribeSecret();
  const signature = await computeHmacSha256Base64Url(serialized, secret);

  return `${serialized}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed unsubscribe token.
 * Rejects tampered, malformed, or expired tokens using constantTimeEqual.
 * Fails closed if UNSUBSCRIBE_SECRET is missing.
 */
export async function verifyUnsubscribeToken(
  token: string,
  customSecret?: string
): Promise<TokenVerificationResult> {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "Missing unsubscribe token" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Malformed token structure" };
  }

  const [serialized, signature] = parts;
  if (!serialized || !signature) {
    return { valid: false, reason: "Incomplete token components" };
  }

  let secret: string;
  try {
    secret = customSecret || getUnsubscribeSecret();
  } catch (err: any) {
    return { valid: false, reason: err?.message || "Missing UNSUBSCRIBE_SECRET" };
  }

  const expectedSig = await computeHmacSha256Base64Url(serialized, secret);

  if (!constantTimeEqual(signature, expectedSig)) {
    return { valid: false, reason: "Invalid token signature / tampered token" };
  }

  let payload: UnsubscribePayload;
  try {
    const jsonStr = decodeBase64Url(serialized);
    payload = JSON.parse(jsonStr);
  } catch {
    return { valid: false, reason: "Invalid token payload encoding" };
  }

  if (!payload?.email || typeof payload.email !== "string" || !payload.email.includes("@")) {
    return { valid: false, reason: "Invalid email in token payload" };
  }

  if (typeof payload.exp === "number" && Date.now() > payload.exp) {
    return { valid: false, reason: "Token has expired" };
  }

  return {
    valid: true,
    email: payload.email.trim().toLowerCase(),
    topic: payload.topic || "digest",
    exp: payload.exp,
  };
}

/**
 * Generates absolute one-click unsubscribe URL.
 */
export async function generateUnsubscribeUrl(
  email: string,
  topic: string = "digest",
  siteUrl?: string,
  customSecret?: string
): Promise<string> {
  const token = await generateUnsubscribeToken(email, topic, 90, customSecret);
  const baseUrl =
    siteUrl ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://careermonke.com";
  return `${baseUrl.replace(/\/$/, "")}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Returns RFC 8058 compliant email headers for one-click unsubscribe.
 */
export async function getUnsubscribeHeaders(
  email: string,
  topic: string = "digest",
  siteUrl?: string,
  customSecret?: string
): Promise<{ "List-Unsubscribe": string; "List-Unsubscribe-Post": string }> {
  const url = await generateUnsubscribeUrl(email, topic, siteUrl, customSecret);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Verifies token and records suppression in public.email_suppressions via service role.
 */
export async function processUnsubscribe(
  supabaseClient: any,
  token: string,
  customSecret?: string
): Promise<{
  ok: boolean;
  status: number;
  message: string;
  email?: string;
  topic?: string;
}> {
  const verification = await verifyUnsubscribeToken(token, customSecret);
  if (!verification.valid) {
    return {
      ok: false,
      status: 400,
      message: `Unsubscribe failed: ${verification.reason}`,
    };
  }

  if (!supabaseClient) {
    return {
      ok: false,
      status: 500,
      message: "Database client unavailable to record suppression",
    };
  }

  const recordResult = await recordEmailSuppression(
    supabaseClient,
    verification.email,
    "unsubscribe"
  );

  if (!recordResult.ok) {
    return {
      ok: false,
      status: 500,
      message: recordResult.error || "Failed to persist email suppression",
    };
  }

  return {
    ok: true,
    status: 200,
    message: `You have been successfully unsubscribed from ${verification.topic} emails.`,
    email: verification.email,
    topic: verification.topic,
  };
}

/**
 * Safely escapes HTML special characters.
 */
export function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal confirmation page HTML rendered on GET requests.
 * Displays a button inside a POST form so only deliberate user interaction triggers unsubscribe.
 */
export function renderUnsubscribeConfirmationHtml(params: {
  email: string;
  topic: string;
  token: string;
  postUrl?: string;
}): string {
  const emailEsc = escapeHtml(params.email);
  const topicEsc = escapeHtml(params.topic);
  const tokenEsc = escapeHtml(params.token);
  const postUrl = escapeHtml(params.postUrl || "/api/email/unsubscribe");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribe Confirmation | CareerMonke</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: #ffffff; }
    p { font-size: 14px; color: #9ca3af; margin: 0 0 24px; line-height: 1.5; }
    .btn { display: inline-block; width: 100%; padding: 12px 20px; background: #ef4444; color: #ffffff; font-size: 14px; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s; box-sizing: border-box; }
    .btn:hover { background: #dc2626; }
    .footer { margin-top: 20px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Confirm Unsubscribe</h1>
    <p>Click the button below to unsubscribe <strong>${emailEsc}</strong> from CareerMonke <strong>${topicEsc}</strong> emails.</p>
    <form method="POST" action="${postUrl}">
      <input type="hidden" name="token" value="${tokenEsc}" />
      <button type="submit" class="btn">Unsubscribe</button>
    </form>
    <div class="footer">You will no longer receive recurring emails from CareerMonke.</div>
  </div>
</body>
</html>`;
}

/**
 * Minimal success confirmation page HTML rendered on successful browser POST.
 */
export function renderUnsubscribeSuccessHtml(params: {
  email?: string;
  topic?: string;
  message?: string;
}): string {
  const msg = escapeHtml(params.message || "You have been successfully unsubscribed.");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribed | CareerMonke</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: #10b981; }
    p { font-size: 14px; color: #9ca3af; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unsubscribed Successfully</h1>
    <p>${msg}</p>
  </div>
</body>
</html>`;
}

/**
 * Minimal error page HTML rendered on invalid token / missing token.
 */
export function renderUnsubscribeErrorHtml(errorMessage: string): string {
  const msg = escapeHtml(errorMessage || "The unsubscribe link is invalid or has expired.");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invalid Unsubscribe Link | CareerMonke</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: #f87171; }
    p { font-size: 14px; color: #9ca3af; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unable to Unsubscribe</h1>
    <p>${msg}</p>
  </div>
</body>
</html>`;
}
