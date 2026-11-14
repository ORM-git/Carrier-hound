import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadRazorpayScript, verifyRazorpayWebhookSignature } from "@/lib/billing/razorpay";
import { handleProCheckout, openRazorpaySubscription } from "@/lib/billing/checkout";
import crypto from "crypto";

describe("Billing Checkout & Razorpay (Node Environment)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_fixture_123";
    delete (globalThis as any).__mockSupabaseClient;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    delete (globalThis as any).__mockSupabaseClient;
    vi.restoreAllMocks();
  });

  describe("loadRazorpayScript (Node - window undefined)", () => {
    it("resolves false when window is undefined", async () => {
      const result = await loadRazorpayScript();
      expect(result).toBe(false);
    });
  });

  describe("verifyRazorpayWebhookSignature", () => {
    const secret = "test_webhook_secret_key_789";
    const body = JSON.stringify({ event: "subscription.charged", id: "evt_123" });

    it("returns false when rawBody is empty", async () => {
      const result = await verifyRazorpayWebhookSignature("", "some_sig", secret);
      expect(result).toBe(false);
    });

    it("returns false when signatureHeader is empty", async () => {
      const result = await verifyRazorpayWebhookSignature(body, "", secret);
      expect(result).toBe(false);
    });

    it("returns false when secret is empty", async () => {
      const result = await verifyRazorpayWebhookSignature(body, "some_sig", "");
      expect(result).toBe(false);
    });

    it("returns true for matching HMAC-SHA256 signature", async () => {
      const expectedSig = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

      const result = await verifyRazorpayWebhookSignature(body, expectedSig, secret);
      expect(result).toBe(true);
    });

    it("returns false for mismatched signature", async () => {
      const wrongSig = crypto
        .createHmac("sha256", "different_secret")
        .update(body)
        .digest("hex");

      const result = await verifyRazorpayWebhookSignature(body, wrongSig, secret);
      expect(result).toBe(false);
    });

    it("returns false when signature lengths mismatch or timingSafeEqual throws", async () => {
      const result = await verifyRazorpayWebhookSignature(body, "short_invalid_sig", secret);
      expect(result).toBe(false);
    });
  });

  describe("handleProCheckout in Node (window undefined)", () => {
    it("handles unauthenticated user safely without window (target defaults to /dashboard)", async () => {
      (globalThis as any).__mockSupabaseClient = {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        },
      };

      // Should complete without error (no window.location to redirect)
      await expect(handleProCheckout()).resolves.toBeUndefined();
    });

    it("handles authenticated user with getUser fallback when session is null", async () => {
      (globalThis as any).__mockSupabaseClient = {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          getUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: "user_node_1",
                email: "node@user.com",
                user_metadata: { full_name: "Node User" },
              },
            },
          }),
        },
      };

      const onError = vi.fn();
      // Razorpay gateway will fail in node because window is undefined (loadRazorpayScript returns false)
      // or billing/order mock. Here fetch will fail or loadScript fails.
      await handleProCheckout({ onError });
      expect(onError).toHaveBeenCalled();
    });
  });

  describe("openRazorpaySubscription in Node (window undefined)", () => {
    it("handles unauthenticated user safely without window (target defaults to /pricing)", async () => {
      (globalThis as any).__mockSupabaseClient = {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        },
      };

      await expect(openRazorpaySubscription()).resolves.toBeUndefined();
    });

    it("handles authenticated user with getUser fallback in node", async () => {
      (globalThis as any).__mockSupabaseClient = {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          getUser: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: "user_node_2",
                email: "node2@user.com",
                user_metadata: { full_name: "Node User 2" },
              },
            },
          }),
        },
      };

      const onError = vi.fn();
      await openRazorpaySubscription({ onError });
      expect(onError).toHaveBeenCalled();
    });
  });
});
