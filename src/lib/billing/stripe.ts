import { PLAN_INTERNATIONAL } from "./types";

/**
 * Initiates Stripe International Checkout ($9/month)
 */
export async function redirectToStripeCheckout(options: {
  userEmail?: string;
  userId?: string;
  returnUrl?: string;
}) {
  // If dedicated checkout session URL or payment link exists
  const paymentLink =
    process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK ||
    `https://buy.stripe.com/test_placeholder_careermonke?prefilled_email=${encodeURIComponent(
      options.userEmail || ""
    )}`;

  // If live link is not configured yet
  if (paymentLink.includes("placeholder")) {
    return { success: false, redirected: false };
  }

  if (typeof window !== "undefined") {
    window.location.href = paymentLink;
  }

  return { success: true, redirected: true };
}

/**
 * Server-side / Webhook Signature Verification for Stripe
 * Computes HMAC-SHA256(timestamp + '.' + payload, secret) and verifies against signature header
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;

  try {
    const crypto = await import("crypto");

    // Header format: t=1492774577,v1=5257a869e7ecebeda32affa62cd...
    const parts = signatureHeader.split(",");
    let timestamp = "";
    let signature = "";

    for (const part of parts) {
      const [key, val] = part.trim().split("=");
      if (key === "t") timestamp = val;
      if (key === "v1") signature = val;
    }

    if (!timestamp || !signature) return false;

    // Reject expired timestamps (replay attack prevention)
    const tsNumber = parseInt(timestamp, 10);
    if (isNaN(tsNumber)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - tsNumber) > toleranceSeconds) {
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch (err) {
    console.error("Stripe webhook signature verification error:", err);
    return false;
  }
}
