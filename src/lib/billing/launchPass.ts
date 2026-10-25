import { UserTier } from "./types";

export interface LaunchPassPayload {
  sub: string; // Authenticated user ID (UUID)
  tier: "listings" | "ai";
  iat: number; // Issued-at timestamp (ms)
  exp: number; // Expiry timestamp (ms)
  aud: string; // Target audience identifier
  env: string; // Deployment environment
  jti?: string; // Optional unique pass UUID for server-side registry/revocation
}

// Maximum approved launch duration: 14 days
export const MAX_LAUNCH_PASS_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const LAUNCH_DURATION_MS = MAX_LAUNCH_PASS_LIFETIME_MS;

// Canonical audience identifier
export const LAUNCH_PASS_AUDIENCE = "careermonke-launch-pass";

// Maximum allowable clock skew (1 minute)
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

export const SIGNING_SECRET_ENV_NAME = "LAUNCH_PASS_SECRET";

export class MissingSigningSecretError extends Error {
  readonly missingVariable = SIGNING_SECRET_ENV_NAME;
  constructor() {
    super(`Missing required launch pass signing secret: ${SIGNING_SECRET_ENV_NAME}`);
    this.name = "MissingSigningSecretError";
  }
}

/**
 * Resolves the dedicated launch pass signing secret strictly from environment variables.
 * Never falls back to Supabase credentials, dummy strings, or public fallbacks.
 * Fails closed by throwing MissingSigningSecretError if LAUNCH_PASS_SECRET is absent.
 */
function getDedicatedSecret(env?: Record<string, any>): string {
  const fromEnv = env?.[SIGNING_SECRET_ENV_NAME];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const fromProcess = typeof process !== "undefined" && process?.env?.[SIGNING_SECRET_ENV_NAME];
  if (typeof fromProcess === "string" && fromProcess.trim().length > 0) {
    return fromProcess.trim();
  }
  try {
    const cfContext = (globalThis as any)[Symbol.for("__cloudflare-request-context__")];
    if (
      cfContext?.env?.[SIGNING_SECRET_ENV_NAME] &&
      typeof cfContext.env[SIGNING_SECRET_ENV_NAME] === "string" &&
      cfContext.env[SIGNING_SECRET_ENV_NAME].trim()
    ) {
      return cfContext.env[SIGNING_SECRET_ENV_NAME].trim();
    }
  } catch {}
  try {
    const cfEnv = (globalThis as any)[Symbol.for("__cloudflare-env__")];
    if (
      cfEnv?.[SIGNING_SECRET_ENV_NAME] &&
      typeof cfEnv[SIGNING_SECRET_ENV_NAME] === "string" &&
      cfEnv[SIGNING_SECRET_ENV_NAME].trim()
    ) {
      return cfEnv[SIGNING_SECRET_ENV_NAME].trim();
    }
  } catch {}

  // Fail closed. Strictly report missing secret name only. Never log value or length.
  throw new MissingSigningSecretError();
}

function resolveEnvironmentName(env?: Record<string, any>): string {
  if (env?.NODE_ENV && typeof env.NODE_ENV === "string") return env.NODE_ENV.trim();
  if (typeof process !== "undefined" && process?.env?.NODE_ENV) return process.env.NODE_ENV.trim();
  return "production";
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

export interface SignLaunchPassOptions {
  durationMs?: number;
  env?: Record<string, any>;
  audience?: string;
  environmentName?: string;
  passId?: string;
}

/**
 * Creates a cryptographically signed HMAC launch pass for an authenticated user.
 * Binds token to user ID, approved audience, environment, and maximum lifetime.
 * Fails closed if LAUNCH_PASS_SECRET is missing.
 */
export async function signLaunchPass(
  userId: string,
  tier: "listings" | "ai",
  durationMs: number = LAUNCH_DURATION_MS,
  env?: Record<string, any>,
  options?: SignLaunchPassOptions
): Promise<{ token: string; expiresAt: string; passId?: string }> {
  const secret = getDedicatedSecret(env || options?.env);
  const now = Date.now();

  // Validate tier
  if (tier !== "listings" && tier !== "ai") {
    throw new Error(`Invalid tier requested: ${tier}`);
  }

  // Validate user ID
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Invalid or empty userId for launch pass issuance");
  }

  // Enforce approved lifetime cap
  const effectiveDuration = Math.min(durationMs, MAX_LAUNCH_PASS_LIFETIME_MS);
  const exp = now + effectiveDuration;
  const audience = options?.audience || LAUNCH_PASS_AUDIENCE;
  const environmentName = options?.environmentName || resolveEnvironmentName(env || options?.env);

  const payload: LaunchPassPayload = {
    sub: userId.trim(),
    tier,
    iat: now,
    exp,
    aud: audience,
    env: environmentName,
    ...(options?.passId ? { jti: options.passId } : {}),
  };

  const payloadStr = toBase64Url(JSON.stringify(payload));
  const sig = await computeHmacHex(secret, payloadStr);
  return {
    token: `${payloadStr}.${sig}`,
    expiresAt: new Date(exp).toISOString(),
    ...(options?.passId ? { passId: options.passId } : {}),
  };
}

export interface VerifyLaunchPassOptions {
  env?: Record<string, any>;
  expectedAudience?: string;
  expectedEnvironment?: string;
}

export interface VerifyLaunchPassResult {
  valid: boolean;
  tier?: "listings" | "ai";
  expiresAt?: string;
  issuedAt?: string;
  audience?: string;
  environment?: string;
  passId?: string;
  error?: string;
  missingVariable?: string;
}

/**
 * Hardened launch pass verification.
 * Validates HMAC signature with dedicated secret, binds token to expected user ID,
 * enforces audience and environment matching, checks clock skew, rejects future-dated
 * and overlong tokens, and fails closed if signing secret is missing.
 */
export async function verifyLaunchPass(
  token: string | null | undefined,
  expectedUserId: string,
  envOrOptions?: Record<string, any> | VerifyLaunchPassOptions
): Promise<VerifyLaunchPassResult> {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Missing or malformed token structure" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed token format (expected payload.signature)" };
  }

  const [payloadStr, sig] = parts;
  if (!payloadStr || !sig) {
    return { valid: false, error: "Invalid token payload or signature component" };
  }

  // Resolve secret; fails closed if LAUNCH_PASS_SECRET is missing
  let secret: string;
  try {
    const rawEnv = (envOrOptions as VerifyLaunchPassOptions)?.env || (envOrOptions as Record<string, any>);
    secret = getDedicatedSecret(rawEnv);
  } catch (err: any) {
    if (err instanceof MissingSigningSecretError) {
      return {
        valid: false,
        error: err.message,
        missingVariable: SIGNING_SECRET_ENV_NAME,
      };
    }
    return { valid: false, error: "Signing secret lookup failed" };
  }

  // Verify HMAC signature in constant time
  const expectedSig = await computeHmacHex(secret, payloadStr);
  if (!constantTimeEqual(sig.toLowerCase(), expectedSig.toLowerCase())) {
    return { valid: false, error: "Invalid token signature" };
  }

  // Parse and validate payload
  try {
    const payloadJson = fromBase64Url(payloadStr);
    const payload: LaunchPassPayload = JSON.parse(payloadJson);
    const now = Date.now();

    // 1. Subject binding
    if (!payload.sub || payload.sub !== expectedUserId) {
      return { valid: false, error: "Token subject mismatch" };
    }

    // 2. Audience binding
    const expectedAudience = (envOrOptions as VerifyLaunchPassOptions)?.expectedAudience || LAUNCH_PASS_AUDIENCE;
    if (payload.aud !== expectedAudience) {
      return { valid: false, error: `Token audience mismatch (expected ${expectedAudience})` };
    }

    // 3. Environment binding (if explicitly requested)
    const expectedEnvironment = (envOrOptions as VerifyLaunchPassOptions)?.expectedEnvironment;
    if (expectedEnvironment && payload.env !== expectedEnvironment) {
      return { valid: false, error: `Token environment mismatch (expected ${expectedEnvironment}, got ${payload.env})` };
    }

    // 4. Inverted dates check
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat >= payload.exp) {
      return { valid: false, error: "Malformed token dates (iat >= exp or non-numeric)" };
    }

    // 5. Future-dated token check (max 1 minute clock skew allowed)
    if (payload.iat > now + MAX_CLOCK_SKEW_MS) {
      return { valid: false, error: "Token issued in the future (future-dated token rejected)" };
    }

    // 6. Overlong token check (cannot exceed approved 14-day maximum lifetime)
    if (payload.exp - payload.iat > MAX_LAUNCH_PASS_LIFETIME_MS) {
      return { valid: false, error: "Token lifetime exceeds approved maximum (overlong token rejected)" };
    }

    // 7. Expiry check
    if (now > payload.exp) {
      return { valid: false, error: "Launch pass expired" };
    }

    // 8. Tier validation
    if (payload.tier !== "listings" && payload.tier !== "ai") {
      return { valid: false, error: "Invalid tier in launch pass payload" };
    }

    return {
      valid: true,
      tier: payload.tier,
      expiresAt: new Date(payload.exp).toISOString(),
      issuedAt: new Date(payload.iat).toISOString(),
      audience: payload.aud,
      environment: payload.env,
      passId: payload.jti,
    };
  } catch {
    return { valid: false, error: "Failed to parse token payload JSON" };
  }
}
