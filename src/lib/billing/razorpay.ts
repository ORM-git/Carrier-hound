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
  planCode?: string;
  addonCode?: string;
  authToken?: string;
  userEmail?: string;
  userName?: string;
  userPhone?: string;
  onSuccess?: (result: { orderId: string; paymentId: string; verified: boolean }) => void;
  onError?: (err: any) => void;
  onDismiss?: () => void;
}

/**
 * Initiates Razorpay checkout in browser via server-authoritative order creation and signature verification.
 * Passes ONLY planCode and/or addonCode — NO client-supplied amounts.
 * Fails safe immediately if NEXT_PUBLIC_BILLING_ENABLED !== "true" without making network calls.
 */
export async function openRazorpayCheckout(options: RazorpayCheckoutOptions = {}): Promise<void> {
  // Flag-off gate: if billing is not enabled, do NOT make any call to /api/billing/razorpay/order
  if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {
    options.onError?.(new Error("Payments not enabled. Billing is currently disabled."));
    return;
  }

  // Check Razorpay key configuration
  const keyId =
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID;

  if (!keyId) {
    options.onError?.(new Error("Payments not enabled. Razorpay is not configured."));
    return;
  }

  // Auth token check
  let token = options.authToken;
  if (!token) {
    try {
      const { createClient } = await import("../supabase/client");
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      token = session?.access_token;
    } catch {
      // Fallback: token stays undefined
    }
  }

  if (!token) {
    options.onError?.(new Error("Please sign in to proceed with payment."));
    return;
  }

  // 1. Create order server-side via /api/billing/razorpay/order (server resolves pricing, client amounts ignored)
  let orderData: { orderId: string; amount: number; currency: string; keyId: string };
  try {
    const res = await fetch("/api/billing/razorpay/order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        planCode: options.planCode,
        addonCode: options.addonCode,
      }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      options.onError?.(new Error(errJson.error || "Failed to create payment order"));
      return;
    }

    orderData = await res.json();
  } catch (err: any) {
    options.onError?.(new Error(err?.message || "Network error while creating payment order"));
    return;
  }

  // 2. Load Razorpay Checkout SDK
  const isLoaded = await loadRazorpayScript();
  if (!isLoaded) {
    options.onError?.(new Error("Failed to load Razorpay payment gateway"));
    return;
  }

  // 3. Open Razorpay Checkout modal
  const razorpayOptions = {
    key: orderData.keyId || keyId,
    order_id: orderData.orderId,
    amount: orderData.amount, // Server-authoritative amount from order creation response
    currency: orderData.currency || "INR",
    name: "CareerMonke",
    description: options.addonCode ? "Pro Add-on Pack" : "CareerMonke Pro Pass",
    image: "/icon.png",
    prefill: {
      name: options.userName || "Candidate",
      email: options.userEmail || "",
      contact: options.userPhone || "",
    },
    theme: {
      color: "#2563EB",
    },
    handler: async function (response: any) {
      // 4. Verify payment signature server-side via /api/billing/razorpay/verify
      try {
        const verifyRes = await fetch("/api/billing/razorpay/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            planCode: options.planCode,
            addonCode: options.addonCode,
          }),
        });

        if (!verifyRes.ok) {
          const verifyErr = await verifyRes.json().catch(() => ({}));
          options.onError?.(new Error(verifyErr.error || "Payment verification failed"));
          return;
        }

        const verifyData = await verifyRes.json();
        options.onSuccess?.({
          orderId: response.razorpay_order_id,
          paymentId: response.razorpay_payment_id,
          verified: Boolean(verifyData.verified || verifyData.success),
        });
      } catch (err: any) {
        options.onError?.(new Error(err?.message || "Failed to verify payment with server"));
      }
    },
    modal: {
      ondismiss: function () {
        options.onDismiss?.();
      },
    },
  };

  try {
    const rzp = new (window as any).Razorpay(razorpayOptions);
    rzp.open();
  } catch (err) {
    options.onError?.(err);
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
