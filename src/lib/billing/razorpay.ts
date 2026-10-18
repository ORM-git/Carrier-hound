import { PLAN_DOMESTIC } from "./types";

/**
 * Loads Razorpay Standard Checkout SDK dynamically
 */
export function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }
    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export interface RazorpayCheckoutOptions {
  userEmail?: string;
  userName?: string;
  userPhone?: string;
  onSuccess: (paymentId: string) => void;
  onError: (err: any) => void;
}

/**
 * Initiates Razorpay checkout in browser (Domestic Rs 199/month, UPI & Cards)
 */
export async function openRazorpayCheckout(options: RazorpayCheckoutOptions) {
  const keyId =
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID;

  if (!keyId) {
    options.onError(new Error("Payments not enabled. Razorpay is not configured."));
    return;
  }

  const isLoaded = await loadRazorpayScript();
  if (!isLoaded) {
    options.onError(new Error("Failed to load Razorpay payment gateway"));
    return;
  }

  const razorpayOptions = {
    key: keyId,
    amount: PLAN_DOMESTIC.price * 100, // In paise (19900 paise = Rs 199)
    currency: "INR",
    name: "CareerMonke",
    description: "Domestic Pro Member Pass — Rs 199/month",
    image: "/icon.png",
    prefill: {
      name: options.userName || "Candidate",
      email: options.userEmail || "candidate@example.com",
      contact: options.userPhone || "",
    },
    theme: {
      color: "#2563EB",
    },
    handler: function (response: any) {
      options.onSuccess(response.razorpay_payment_id || "pay_success");
    },
    modal: {
      ondismiss: function () {
        console.log("Razorpay checkout modal dismissed by user");
      },
    },
  };

  try {
    const rzp = new (window as any).Razorpay(razorpayOptions);
    rzp.open();
  } catch (err) {
    options.onError(err);
  }
}

/**
 * Server-side / Webhook Signature Verification for Razorpay
 * Uses HMAC-SHA256 with RAZORPAY_WEBHOOK_SECRET
 */
export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;

  try {
    const crypto = await import("crypto");
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "utf8"),
      Buffer.from(signatureHeader, "utf8")
    );
  } catch (err) {
    console.error("Razorpay webhook signature verification error:", err);
    return false;
  }
}
