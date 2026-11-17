import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../../../netlify/functions/billing-razorpay-subscription";
import { openRazorpaySubscription as openGatewaySubscription } from "@/lib/billing/razorpay";
import { openRazorpaySubscription as openCheckoutSubscription } from "@/lib/billing/checkout";

/**
 * Recurring (auto-renew) subscriptions are disabled for launch. Every plan is a one-time
 * prepaid order. These tests prove the recurring path is unreachable no matter how
 * NEXT_PUBLIC_AUTORENEW_ENABLED / NEXT_PUBLIC_BILLING_ENABLED are set.
 */
const FLAG_PERMUTATIONS: Array<Record<string, string | undefined>> = [
  { NEXT_PUBLIC_AUTORENEW_ENABLED: undefined, NEXT_PUBLIC_BILLING_ENABLED: undefined },
  { NEXT_PUBLIC_AUTORENEW_ENABLED: "false", NEXT_PUBLIC_BILLING_ENABLED: "true" },
  { NEXT_PUBLIC_AUTORENEW_ENABLED: "true", NEXT_PUBLIC_BILLING_ENABLED: "true" },
  { NEXT_PUBLIC_AUTORENEW_ENABLED: "true", NEXT_PUBLIC_BILLING_ENABLED: "false" },
];

function applyFlags(flags: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("Recurring subscription path is disabled (410)", () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RAZORPAY_MODE = "test";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_key_123456";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_fixture_secret_abcdef";
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const flags of FLAG_PERMUTATIONS) {
    const label = JSON.stringify(flags);

    it(`Next route returns 410 RECURRING_DISABLED for every plan with flags ${label}`, async () => {
      applyFlags(flags);
      for (const planCode of ["weekly", "monthly", "quarterly"]) {
        const req = new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
          body: JSON.stringify({ planCode }),
        });
        const res = await POST(req);
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.code).toBe("RECURRING_DISABLED");
        expect(body.subscriptionId).toBeUndefined();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`Netlify function returns 410 RECURRING_DISABLED with flags ${label}`, async () => {
      applyFlags(flags);
      const handler = createNetlifySubscriptionHandler();
      const res = await handler({
        httpMethod: "POST",
        headers: { authorization: "Bearer valid-token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      expect(res.statusCode).toBe(410);
      expect(JSON.parse(res.body).code).toBe("RECURRING_DISABLED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`client gateway and checkout orchestrator fail closed without network with flags ${label}`, async () => {
      applyFlags(flags);
      const gatewayError = vi.fn();
      await openGatewaySubscription({ planCode: "monthly", authToken: "tok", onError: gatewayError });
      expect(gatewayError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Recurring subscriptions are disabled") })
      );

      const checkoutError = vi.fn();
      const onStart = vi.fn();
      await openCheckoutSubscription({ planCode: "monthly", onError: checkoutError, onStart });
      expect(checkoutError).toHaveBeenCalledWith(expect.stringContaining("Recurring subscriptions are disabled"));
      expect(onStart).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("Netlify function rejects non-POST methods with 405", async () => {
    const handler = createNetlifySubscriptionHandler();
    const res = await handler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(405);
  });
});
