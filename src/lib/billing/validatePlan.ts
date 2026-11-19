/**
 * src/lib/billing/validatePlan.ts
 *
 * Pre-flight validation of Razorpay Auto-Renew Subscription Plan.
 * Before creating a subscription, fetches the plan from Razorpay API and asserts:
 * - amount: 49900 paise (₹499)
 * - currency: INR
 * - period: monthly
 * - interval: 1
 *
 * Refuses subscription creation if any attribute fails to match.
 */

export interface PlanValidationResult {
  valid: boolean;
  code?: string;
  error?: string;
  plan?: any;
}

export async function validateRazorpayPlan(
  planId: string,
  keyId: string,
  keySecret: string,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number }
): Promise<PlanValidationResult> {
  const trimmedPlanId = planId?.trim();
  if (!trimmedPlanId) {
    return {
      valid: false,
      code: "PLAN_NOT_CONFIGURED",
      error: "Subscription plan is not configured on server",
    };
  }

  if (!keyId || !keySecret) {
    return {
      valid: false,
      code: "RAZORPAY_CONFIG_ERROR",
      error: "Payment gateway credentials are not configured",
    };
  }

  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const fetchCaller = options?.fetchFn || fetch;
  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchCaller(
      `https://api.razorpay.com/v1/plans/${encodeURIComponent(trimmedPlanId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return {
        valid: false,
        code: "PLAN_FETCH_FAILED",
        error:
          errBody?.error?.description ||
          `Failed to fetch plan from Razorpay (gateway returned HTTP ${res.status})`,
      };
    }

    const plan = await res.json();
    const amount = plan?.item?.amount ?? plan?.amount;
    const currency = String(plan?.item?.currency ?? plan?.currency ?? "").toUpperCase();
    const period = String(plan?.period ?? "").toLowerCase();
    const interval = Number(plan?.interval ?? 0);

    if (amount !== 49900) {
      return {
        valid: false,
        code: "INVALID_PLAN_AMOUNT",
        error: `Configured Razorpay plan amount (${amount} paise) does not match required flat ₹499 (49900 paise)`,
      };
    }

    if (currency !== "INR") {
      return {
        valid: false,
        code: "INVALID_PLAN_CURRENCY",
        error: `Configured Razorpay plan currency (${currency}) does not match required INR`,
      };
    }

    if (period !== "monthly") {
      return {
        valid: false,
        code: "INVALID_PLAN_PERIOD",
        error: `Configured Razorpay plan period (${period}) does not match required monthly period`,
      };
    }

    if (interval !== 1) {
      return {
        valid: false,
        code: "INVALID_PLAN_INTERVAL",
        error: `Configured Razorpay plan interval (${interval}) does not match required interval 1`,
      };
    }

    return { valid: true, plan };
  } catch (err: any) {
    const isTimeout =
      err?.name === "AbortError" ||
      err?.message?.toLowerCase().includes("timeout") ||
      err?.message?.toLowerCase().includes("abort");

    return {
      valid: false,
      code: isTimeout ? "PLAN_FETCH_TIMEOUT" : "PLAN_FETCH_ERROR",
      error: isTimeout
        ? "Timed out communicating with payment gateway to validate plan"
        : (err?.message || "Failed to validate plan with payment gateway"),
    };
  } finally {
    clearTimeout(timer);
  }
}
