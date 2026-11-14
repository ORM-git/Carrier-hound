import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getRazorpayKeyMode,
  resolveServerPaymentMode,
  resolveWebhookPaymentMode,
} from "@/lib/billing/mode";
import {
  normalizePlanCode,
  resolveOrderPricing,
  PLAN_DEFINITIONS,
  ADDON_PACK_DEFINITIONS,
} from "@/lib/billing/quota";
import {
  hexToBytes,
  verifyWebhookSignatureBytes,
} from "@/lib/billing/webhookSignature";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import crypto from "crypto";

describe("Billing Mode, Plan Mapping & Entitlements", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("getRazorpayKeyMode", () => {
    it("returns 'unknown' for null, undefined, or non-string inputs", () => {
      expect(getRazorpayKeyMode(undefined)).toBe("unknown");
      expect(getRazorpayKeyMode(null)).toBe("unknown");
      expect(getRazorpayKeyMode("" as any)).toBe("unknown");
      expect(getRazorpayKeyMode(123 as any)).toBe("unknown");
      expect(getRazorpayKeyMode({} as any)).toBe("unknown");
    });

    it("returns 'test' for rzp_test_ keys including whitespace", () => {
      expect(getRazorpayKeyMode("rzp_test_123456")).toBe("test");
      expect(getRazorpayKeyMode("  rzp_test_trimmed  ")).toBe("test");
    });

    it("returns 'live' for rzp_live_ keys including whitespace", () => {
      expect(getRazorpayKeyMode("rzp_live_abcdef")).toBe("live");
      expect(getRazorpayKeyMode("  rzp_live_trimmed  ")).toBe("live");
    });

    it("returns 'unknown' for unknown prefixes", () => {
      expect(getRazorpayKeyMode("rzp_sandbox_123")).toBe("unknown");
      expect(getRazorpayKeyMode("sk_test_123")).toBe("unknown");
      expect(getRazorpayKeyMode("random_key")).toBe("unknown");
    });
  });

  describe("resolveServerPaymentMode", () => {
    it("fails closed when keyId or keySecret is missing", () => {
      const res1 = resolveServerPaymentMode(null, "secret");
      expect(res1.valid).toBe(false);
      expect(res1.code).toBe("RAZORPAY_CONFIG_MISSING");

      const res2 = resolveServerPaymentMode("rzp_test_key", null);
      expect(res2.valid).toBe(false);
      expect(res2.code).toBe("RAZORPAY_CONFIG_MISSING");
    });

    it("fails closed when keyId has invalid prefix", () => {
      const res = resolveServerPaymentMode("invalid_prefix_key", "secret");
      expect(res.valid).toBe(false);
      expect(res.code).toBe("RAZORPAY_CONFIG_INVALID");
    });

    it("succeeds for valid test and live keys", () => {
      const testRes = resolveServerPaymentMode("rzp_test_valid", "secret");
      expect(testRes.valid).toBe(true);
      expect(testRes.mode).toBe("test");

      const liveRes = resolveServerPaymentMode("rzp_live_valid", "secret");
      expect(liveRes.valid).toBe(true);
      expect(liveRes.mode).toBe("live");
    });
  });

  describe("resolveWebhookPaymentMode", () => {
    it("fails closed when webhookSecret is missing", () => {
      const res = resolveWebhookPaymentMode(null, "rzp_test_key");
      expect(res.valid).toBe(false);
      expect(res.code).toBe("WEBHOOK_SECRET_MISSING");
    });

    it("fails closed when server keyId has invalid prefix", () => {
      const res = resolveWebhookPaymentMode("secret", "invalid_key");
      expect(res.valid).toBe(false);
      expect(res.code).toBe("RAZORPAY_CONFIG_INVALID");
    });

    it("succeeds for valid test and live webhook configurations", () => {
      const testRes = resolveWebhookPaymentMode("whsec_123", "rzp_test_key");
      expect(testRes.valid).toBe(true);
      expect(testRes.mode).toBe("test");

      const liveRes = resolveWebhookPaymentMode("whsec_123", "rzp_live_key");
      expect(liveRes.valid).toBe(true);
      expect(liveRes.mode).toBe("live");
    });
  });

  describe("Plan Mapping & Order Pricing (quota.ts)", () => {
    describe("normalizePlanCode", () => {
      it("returns null for non-string or empty inputs", () => {
        expect(normalizePlanCode(undefined)).toBeNull();
        expect(normalizePlanCode(null)).toBeNull();
        expect(normalizePlanCode("")).toBeNull();
        expect(normalizePlanCode("   ")).toBeNull();
        expect(normalizePlanCode(123 as any)).toBeNull();
      });

      it("maps weekly variants to 'weekly'", () => {
        expect(normalizePlanCode("weekly")).toBe("weekly");
        expect(normalizePlanCode("WEEKLY")).toBe("weekly");
        expect(normalizePlanCode("  pro_weekly_pass  ")).toBe("weekly");
      });

      it("maps quarterly and 3_month variants to 'quarterly'", () => {
        expect(normalizePlanCode("quarterly")).toBe("quarterly");
        expect(normalizePlanCode("QUARTERLY")).toBe("quarterly");
        expect(normalizePlanCode("3_month")).toBe("quarterly");
        expect(normalizePlanCode("3_months_pass")).toBe("quarterly");
      });

      it("maps monthly and legacy monthly identifiers to 'monthly'", () => {
        expect(normalizePlanCode("monthly")).toBe("monthly");
        expect(normalizePlanCode("MONTHLY")).toBe("monthly");
        expect(normalizePlanCode("pro_month")).toBe("monthly");
        expect(normalizePlanCode("domestic_monthly_199")).toBe("monthly");
        expect(normalizePlanCode("intl_monthly_9")).toBe("monthly");
      });

      it("returns null for unsupported plans", () => {
        expect(normalizePlanCode("annual")).toBeNull();
        expect(normalizePlanCode("lifetime")).toBeNull();
      });
    });

    describe("resolveOrderPricing", () => {
      it("resolves add-on pack pricing when addonCode is passed", () => {
        const res10 = resolveOrderPricing({ addonCode: "addon_10" });
        expect(res10).toEqual({
          type: "addon",
          code: "addon_10",
          name: ADDON_PACK_DEFINITIONS.addon_10.name,
          amount_paise: 14900,
          currency: "INR",
          sets: 10,
        });

        const res30 = resolveOrderPricing({ addonCode: "addon_30" });
        expect(res30?.amount_paise).toBe(39900);

        const res60 = resolveOrderPricing({ addonCode: "addon_60" });
        expect(res60?.amount_paise).toBe(69900);

        expect(resolveOrderPricing({ addonCode: "addon_unknown" })).toBeNull();
      });

      it("resolves add-on pack when passed in planCode/planId field", () => {
        const res = resolveOrderPricing({ planCode: "addon_10" });
        expect(res?.type).toBe("addon");
        expect(res?.amount_paise).toBe(14900);
      });

      it("resolves plan pricing when planCode or planId is passed", () => {
        const weekly = resolveOrderPricing({ planCode: "weekly" });
        expect(weekly).toEqual({
          type: "plan",
          code: "weekly",
          name: PLAN_DEFINITIONS.weekly.name,
          amount_paise: 69200,
          currency: "INR",
          duration_days: 7,
        });

        const monthly = resolveOrderPricing({ planId: "monthly" });
        expect(monthly?.amount_paise).toBe(149900);
        expect(monthly?.duration_days).toBe(30);

        const quarterly = resolveOrderPricing({ planCode: "quarterly" });
        expect(quarterly?.amount_paise).toBe(399900);
        expect(quarterly?.duration_days).toBe(90);
      });

      it("returns null when plan code cannot be resolved or is invalid", () => {
        expect(resolveOrderPricing({ planCode: "unknown_code" })).toBeNull();
        expect(resolveOrderPricing({})).toBeNull();
      });
    });
  });

  describe("Webhook Signature Bytes (webhookSignature.ts)", () => {
    describe("hexToBytes", () => {
      it("returns null for non-string, empty, or wrong length strings", () => {
        expect(hexToBytes("")).toBeNull();
        expect(hexToBytes(null as any)).toBeNull();
        expect(hexToBytes("abcd")).toBeNull();
        expect(hexToBytes("a".repeat(63))).toBeNull();
        expect(hexToBytes("a".repeat(65))).toBeNull();
      });

      it("returns null for non-hex characters", () => {
        expect(hexToBytes("z".repeat(64))).toBeNull();
      });

      it("converts valid 64-char hex string to 32-byte Uint8Array", () => {
        const hex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        const bytes = hexToBytes(hex);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes?.length).toBe(32);
        expect(bytes?.[0]).toBe(0x00);
        expect(bytes?.[1]).toBe(0x01);
        expect(bytes?.[31]).toBe(0x1f);
      });
    });

    describe("verifyWebhookSignatureBytes", () => {
      const secret = "whsec_test_secret_key";
      const payload = Buffer.from(JSON.stringify({ event: "order.paid" }));

      it("returns false when inputs are missing or empty", async () => {
        expect(await verifyWebhookSignatureBytes(new Uint8Array(0), "sig", secret)).toBe(false);
        expect(await verifyWebhookSignatureBytes(payload, "", secret)).toBe(false);
        expect(await verifyWebhookSignatureBytes(payload, "sig", "")).toBe(false);
        expect(await verifyWebhookSignatureBytes(payload, "invalid_short_hex", secret)).toBe(false);
      });

      it("returns true for matching HMAC signature", async () => {
        const expectedSig = crypto
          .createHmac("sha256", secret)
          .update(payload)
          .digest("hex");

        const verified = await verifyWebhookSignatureBytes(payload, expectedSig, secret);
        expect(verified).toBe(true);
      });

      it("returns false for non-matching signature", async () => {
        const wrongSig = crypto
          .createHmac("sha256", "other_secret")
          .update(payload)
          .digest("hex");

        const verified = await verifyWebhookSignatureBytes(payload, wrongSig, secret);
        expect(verified).toBe(false);
      });
    });
  });

  describe("Server Entitlement (serverEntitlement.ts)", () => {
    it("returns Free Tier default when userId is missing or empty", async () => {
      const res = await getServerEntitlement("");
      expect(res.isPro).toBe(false);
      expect(res.planName).toBe("Free Tier");
    });

    it("returns Free Tier when credentials are missing", async () => {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_SERVICE_KEY;

      const res = await getServerEntitlement("user_123");
      expect(res.isPro).toBe(false);
      expect(res.status).toBe("none");
    });
  });
});
