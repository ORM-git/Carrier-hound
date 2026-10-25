import { UserTier } from "./types";

export interface LaunchPassPayload {
  sub: string; // userId
  tier: "listings" | "ai";
  iat: number;
  exp: number;
}

// Default launch duration: 14 days
export const LAUNCH_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

function getSecretKey(env?: Record<string, any>): string {
  return (
    env?.LAUNCH_PASS_SECRET ||
    (typeof process !== "undefined" && process?.env?.LAUNCH_PASS_SECRET) ||
    env?.SUPABASE_SERVICE_ROLE_KEY ||
    (typeof process !== "undefined" && process?.env?.SUPABASE_SERVICE_ROLE_KEY) ||
    env?.SUPABASE_SERVICE_KEY ||
    (typeof process !== "undefined" && process?.env?.SUPABASE_SERVICE_KEY) ||
    "cm_secure_launch_pass_key_20261025"
  );
}

function toBase64Url(str: string): string {
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

function fromBase64Url(str: string): string {
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

async function computeHmacHex(secret: string, dataStr: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(dataStr));
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Creates a cryptographically signed HMAC launch pass for an authenticated user.
 */
export async function signLaunchPass(
  userId: string,
  tier: "listings" | "ai",
  durationMs: number = LAUNCH_DURATION_MS,
  env?: Record<string, any>
): Promise<{ token: string; expiresAt: string }> {
  const now = Date.now();
  const exp = now + durationMs;
  const payload: LaunchPassPayload = {
    sub: userId,
    tier,
    iat: now,
    exp,
  };
  const payloadStr = toBase64Url(JSON.stringify(payload));
  const secret = getSecretKey(env);
  const sig = await computeHmacHex(secret, payloadStr);
  return {
    token: `${payloadStr}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/**
 * Verifies a launch pass against a specific authenticated user ID.
 * Returns valid=false if the signature is invalid, subject does not match, or token is expired.
 */
export async function verifyLaunchPass(
  token: string | null | undefined,
  expectedUserId: string,
  env?: Record<string, any>
): Promise<{ valid: boolean; tier?: "listings" | "ai"; expiresAt?: string; error?: string }> {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Missing or malformed token" };
  }
  const [payloadStr, sig] = token.split(".");
  if (!payloadStr || !sig) {
    return { valid: false, error: "Invalid token structure" };
  }
  const secret = getSecretKey(env);
  const expectedSig = await computeHmacHex(secret, payloadStr);

  try {
    if (!constantTimeEqual(sig.toLowerCase(), expectedSig.toLowerCase())) {
      return { valid: false, error: "Invalid token signature" };
    }

    const payloadJson = fromBase64Url(payloadStr);
    const payload: LaunchPassPayload = JSON.parse(payloadJson);

    if (!payload.sub || payload.sub !== expectedUserId) {
      return { valid: false, error: "Token subject mismatch" };
    }

    if (Date.now() > payload.exp) {
      return { valid: false, error: "Launch pass expired" };
    }

    if (payload.tier !== "listings" && payload.tier !== "ai") {
      return { valid: false, error: "Invalid tier in launch pass" };
    }

    return {
      valid: true,
      tier: payload.tier,
      expiresAt: new Date(payload.exp).toISOString(),
    };
  } catch {
    return { valid: false, error: "Failed to parse token payload" };
  }
}
