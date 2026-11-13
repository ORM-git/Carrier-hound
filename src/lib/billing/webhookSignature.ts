/**
 * Web Crypto Timing-Safe Signature Verification for Razorpay Webhooks.
 *
 * Implements HMAC-SHA256 verification and constant-time string comparison
 * to eliminate timing oracle vulnerabilities without external native dependencies.
 */

/**
 * Constant-time string comparison preventing timing oracles.
 * Compares every character without early exit.
 */
export function constantTimeEqual(a: string, b: string): boolean {
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
 * Computes a fixed-length SHA-256 hex digest using Web Crypto.
 */
export async function computeSha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Timing-safe cryptographic signature verification for Razorpay webhooks.
 * Computes HMAC-SHA256 of the raw body using the webhook secret, then
 * performs constant-time comparison over fixed-length SHA-256 digests.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!rawBody || !signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const macBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const macArray = Array.from(new Uint8Array(macBuffer));
    const expectedSignature = macArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const [hashExpected, hashReceived] = await Promise.all([
      computeSha256Hex(expectedSignature),
      computeSha256Hex(signature),
    ]);

    return constantTimeEqual(hashExpected, hashReceived);
  } catch {
    return false;
  }
}
