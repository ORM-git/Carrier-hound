/**
 * Web Crypto Signature Verification for Razorpay Webhooks.
 *
 * Uses the WebCrypto `crypto.subtle.verify` primitive with HMAC-SHA256
 * over raw bounded byte buffers.
 */

/**
 * Converts a 64-character hexadecimal SHA-256 signature string into a 32-byte Uint8Array.
 * Returns null if the string is not a valid 64-character hex sequence.
 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (!hex || typeof hex !== "string") return null;
  const clean = hex.trim().toLowerCase();
  if (clean.length !== 64 || !/^[0-9a-f]{64}$/.test(clean)) {
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies a Razorpay HMAC-SHA256 webhook signature using native WebCrypto verify.
 *
 * @param rawBytes Exact raw request bytes received over the wire.
 * @param signatureHex 64-character hex signature from X-Razorpay-Signature header.
 * @param secret Configured webhook secret.
 */
export async function verifyWebhookSignatureBytes(
  rawBytes: Uint8Array,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  if (!signatureHex || !secret || !rawBytes || rawBytes.length === 0) {
    return false;
  }

  const signatureBytes = hexToBytes(signatureHex);
  if (!signatureBytes) {
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes as any,
      rawBytes as any
    );
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper converting string raw body to UTF-8 bytes before verifying.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  if (!rawBody || typeof rawBody !== "string") return false;
  const encoder = new TextEncoder();
  return verifyWebhookSignatureBytes(encoder.encode(rawBody), signatureHex, secret);
}
