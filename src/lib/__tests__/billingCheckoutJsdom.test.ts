// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadRazorpayScript,
  openRazorpayCheckout,
  openRazorpaySubscription as openGatewaySubscription,
} from "@/lib/billing/razorpay";
import {
  handleProCheckout,
  openRazorpaySubscription as openCheckoutSubscription,
} from "@/lib/billing/checkout";

describe("Billing Checkout & Razorpay (Browser/JSDOM Environment)", () => {
  const originalEnv = { ...process.env };
  let originalLocation: Location;
  let mockLocation: { href: string; pathname: string; search: string };

  const mockUser = {
    id: "user_test_uuid_789",
    email: "subscriber@test.com",
    user_metadata: { full_name: "Sub User" },
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_browser_key_123";

    originalLocation = window.location;
    mockLocation = {
      href: "http://localhost:3000/pricing",
      pathname: "/pricing",
      search: "",
    };
    delete (window as any).location;
    (window as any).location = mockLocation;

    delete (window as any).Razorpay;
    delete (globalThis as any).__mockSupabaseClient;

    (globalThis as any).__mockSupabaseClient = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              user: mockUser,
              access_token: "mock_browser_jwt_token",
            },
          },
        }),
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: mockUser,
          },
        }),
      },
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    (window as any).location = originalLocation;
    delete (window as any).Razorpay;
    delete (globalThis as any).__mockSupabaseClient;
    vi.restoreAllMocks();
  });

  describe("loadRazorpayScript (Browser)", () => {
    it("returns true immediately when window.Razorpay already exists", async () => {
      (window as any).Razorpay = class MockRazorpay {};
      const res = await loadRazorpayScript();
      expect(res).toBe(true);
    });

    it("appends script and resolves true on script onload", async () => {
      const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node: any) => {
        if (node.tagName === "SCRIPT") {
          setTimeout(() => {
            (window as any).Razorpay = class MockRazorpay {};
            node.onload?.(new Event("load"));
          }, 5);
        }
        return node;
      });

      const res = await loadRazorpayScript();
      expect(res).toBe(true);
      expect(appendSpy).toHaveBeenCalled();
    });

    it("resolves false on script onerror", async () => {
      vi.spyOn(document.body, "appendChild").mockImplementation((node: any) => {
        if (node.tagName === "SCRIPT") {
          setTimeout(() => {
            node.onerror?.(new Event("error"));
          }, 5);
        }
        return node;
      });

      const res = await loadRazorpayScript();
      expect(res).toBe(false);
    });
  });

  describe("openRazorpayCheckout (Prepaid Orders)", () => {
    it("fails closed when NEXT_PUBLIC_BILLING_ENABLED is not 'true'", async () => {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Billing is currently disabled"),
        })
      );
    });

    it("fails closed when neither NEXT_PUBLIC_RAZORPAY_KEY_ID nor RAZORPAY_KEY_ID is set", async () => {
      delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_ID;
      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Razorpay is not configured"),
        })
      );
    });

    it("falls back to RAZORPAY_KEY_ID when NEXT_PUBLIC_RAZORPAY_KEY_ID is unset", async () => {
      delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      process.env.RAZORPAY_KEY_ID = "rzp_test_fallback_from_server_env";

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            orderId: "order_fallback_1",
            amount: 49900,
            currency: "INR",
            keyId: "rzp_test_fallback_from_server_env",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      let opened = false;
      (window as any).Razorpay = class MockRazorpay {
        constructor(public opts: any) {}
        on() {}
        open() {
          opened = true;
        }
      };

      await openRazorpayCheckout({ authToken: "custom_token" });
      expect(opened).toBe(true);
    });

    it("fails closed when user has no auth token and session lookup returns null", async () => {
      (globalThis as any).__mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: null },
      });

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Please sign in to proceed"),
        })
      );
    });

    it("handles order creation API errors (!res.ok with JSON)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "User is temporarily restricted from making purchases" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "User is temporarily restricted from making purchases",
        })
      );
    });

    it("handles order creation API errors (!res.ok with non-JSON)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Bad Gateway", { status: 502 })
      );
      vi.stubGlobal("fetch", mockFetch);

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Failed to create payment order",
        })
      );
    });

    it("handles network error when creating payment order", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Connection refused",
        })
      );
    });

    it("handles script loading failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            orderId: "order_123",
            amount: 49900,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      // Force script load failure
      vi.spyOn(document.body, "appendChild").mockImplementation((node: any) => {
        if (node.tagName === "SCRIPT") {
          setTimeout(() => node.onerror?.(new Event("error")), 5);
        }
        return node;
      });

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Failed to load Razorpay payment gateway",
        })
      );
    });

    it("opens Razorpay modal with correct addon vs plan description and prefill values", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            orderId: "order_addon_pack_1",
            amount: 14900,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      let openCalled = false;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {
          openCalled = true;
        }
      };

      await openRazorpayCheckout({
        addonCode: "addon_10",
        userName: "Alex Dev",
        userEmail: "alex@careermonke.com",
        userPhone: "+919999999999",
      });

      expect(openCalled).toBe(true);
      expect(capturedOptions.description).toBe("Pro Add-on Pack");
      expect(capturedOptions.prefill.name).toBe("Alex Dev");
      expect(capturedOptions.prefill.email).toBe("alex@careermonke.com");
      expect(capturedOptions.prefill.contact).toBe("+919999999999");
    });

    it("handles Razorpay modal ondismiss callback", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            orderId: "order_dismiss_test",
            amount: 49900,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {}
      };

      const onDismiss = vi.fn();
      await openRazorpayCheckout({ onDismiss });
      expect(capturedOptions).not.toBeNull();

      capturedOptions.modal.ondismiss();
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("handles Razorpay payment.failed event", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            orderId: "order_fail_test",
            amount: 49900,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      let failedHandler: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(public opts: any) {}
        on(event: string, handler: any) {
          if (event === "payment.failed") {
            failedHandler = handler;
          }
        }
        open() {}
      };

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(failedHandler).not.toBeNull();

      failedHandler?.({
        error: { description: "Card declined by issuing bank" },
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Card declined by issuing bank",
        })
      );

      // Also test reason fallback
      failedHandler?.({
        error: { reason: "payment_cancelled" },
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "payment_cancelled",
        })
      );
    });

    it("handles signature verification success and failures in modal handler", async () => {
      let fetchCount = 0;
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        fetchCount++;
        if (url.includes("/order")) {
          return new Response(
            JSON.stringify({
              orderId: "order_verify_test_1",
              amount: 49900,
              currency: "INR",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/verify")) {
          return new Response(
            JSON.stringify({ verified: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error("Unhandled URL");
      });
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {}
      };

      const onSuccess = vi.fn();
      await openRazorpayCheckout({ planCode: "monthly", onSuccess });

      await capturedOptions.handler({
        razorpay_order_id: "order_verify_test_1",
        razorpay_payment_id: "pay_test_999",
        razorpay_signature: "mock_valid_signature_hex",
      });

      expect(onSuccess).toHaveBeenCalledWith({
        orderId: "order_verify_test_1",
        paymentId: "pay_test_999",
        verified: true,
      });
    });

    it("handles signature verification failure (!verifyRes.ok)", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/order")) {
          return new Response(
            JSON.stringify({ orderId: "order_123", amount: 49900, currency: "INR" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/verify")) {
          return new Response(
            JSON.stringify({ error: "Tampered signature detected" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error("Unhandled URL");
      });
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {}
      };

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });

      await capturedOptions.handler({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_999",
        razorpay_signature: "tampered_sig",
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Tampered signature detected",
        })
      );
    });

    it("handles signature verification network exception", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/order")) {
          return new Response(
            JSON.stringify({ orderId: "order_123", amount: 49900, currency: "INR" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/verify")) {
          throw new Error("Network timeout contacting verify endpoint");
        }
        throw new Error("Unhandled URL");
      });
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {}
      };

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });

      await capturedOptions.handler({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_999",
        razorpay_signature: "sig",
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Network timeout contacting verify endpoint",
        })
      );
    });

    it("handles exception thrown by rzp.open()", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ orderId: "order_open_throw", amount: 49900, currency: "INR" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      (window as any).Razorpay = class MockRazorpay {
        constructor(public opts: any) {}
        on() {}
        open() {
          throw new Error("Popup blocked by user browser settings");
        }
      };

      const onError = vi.fn();
      await openRazorpayCheckout({ onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Popup blocked by user browser settings",
        })
      );
    });
  });

  describe("openGatewaySubscription (recurring path disabled)", () => {
    it("fails closed without loading the SDK or calling fetch, even with AUTORENEW and BILLING on", async () => {
      process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const onError = vi.fn();
      await openGatewaySubscription({ planCode: "monthly", authToken: "tok", onError });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Recurring subscriptions are disabled") })
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("handleProCheckout (Orchestrator in checkout.ts)", () => {
    it("redirects unauthenticated visitor to /login?next=... (default target)", async () => {
      (globalThis as any).__mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: null },
      });
      (globalThis as any).__mockSupabaseClient.auth.getUser.mockResolvedValue({
        data: { user: null },
      });

      await handleProCheckout();
      expect(window.location.href).toBe(`/login?next=${encodeURIComponent("/pricing")}`);
    });

    it("redirects unauthenticated visitor to /login?next=... (custom redirectTarget)", async () => {
      (globalThis as any).__mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: null },
      });
      (globalThis as any).__mockSupabaseClient.auth.getUser.mockResolvedValue({
        data: { user: null },
      });

      await handleProCheckout({ redirectTarget: "/dashboard/jobs?view=saved" });
      expect(window.location.href).toBe(`/login?next=${encodeURIComponent("/dashboard/jobs?view=saved")}`);
    });

    it("orchestrates Pro checkout for authenticated visitor, firing onStart and navigating on success", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/order")) {
          return new Response(
            JSON.stringify({ orderId: "order_orch_1", amount: 49900, currency: "INR" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/verify")) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error("Unhandled URL");
      });
      vi.stubGlobal("fetch", mockFetch);

      let capturedOptions: any = null;
      (window as any).Razorpay = class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        on() {}
        open() {}
      };

      const onStart = vi.fn();
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onDismiss = vi.fn();

      await handleProCheckout({
        planCode: "quarterly",
        redirectTarget: "/pro/welcome",
        onStart,
        onSuccess,
        onError,
        onDismiss,
      });

      expect(onStart).toHaveBeenCalledTimes(1);

      // Trigger modal dismiss
      capturedOptions.modal.ondismiss();
      expect(onDismiss).toHaveBeenCalledTimes(1);

      // Trigger payment success handler
      await capturedOptions.handler({
        razorpay_order_id: "order_orch_1",
        razorpay_payment_id: "pay_orch_1",
        razorpay_signature: "valid_sig",
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe("/pro/welcome");
    });

    it("orchestrates add-on pack checkout: passes addonCode and leaves planCode undefined", async () => {
      let requestBody: any = null;
      const mockFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes("/order")) {
          requestBody = JSON.parse(opts.body);
          return new Response(
            JSON.stringify({ orderId: "order_addon_pack", amount: 14900, currency: "INR" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error("Unhandled URL");
      });
      vi.stubGlobal("fetch", mockFetch);

      (window as any).Razorpay = class MockRazorpay {
        constructor(public opts: any) {}
        on() {}
        open() {}
      };

      await handleProCheckout({ addonCode: "addon_10" });
      expect(requestBody.addonCode).toBe("addon_10");
      expect(requestBody.planCode).toBeUndefined();
    });

    it("wires onError callback when payment fails", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Order limit exceeded" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      const onError = vi.fn();
      await handleProCheckout({ onError });
      expect(onError).toHaveBeenCalledWith("Order limit exceeded");
    });
  });

  describe("openCheckoutSubscription (recurring path disabled)", () => {
    it("fails closed without redirecting or starting checkout, even with AUTORENEW and BILLING on", async () => {
      process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
      const getSession = vi.fn();
      (globalThis as any).__mockSupabaseClient = { auth: { getSession, getUser: vi.fn() } };
      const onError = vi.fn();
      const onStart = vi.fn();
      await openCheckoutSubscription({ planCode: "monthly", onError, onStart });
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Recurring subscriptions are disabled"));
      expect(onStart).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      expect(mockLocation.href).toBe("http://localhost:3000/pricing");
    });
  });
});
