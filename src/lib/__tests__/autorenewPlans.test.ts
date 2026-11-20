import { describe, it, expect } from "vitest";
import { AUTORENEW_PLANS, getAutoRenewPlan } from "@/lib/billing/autorenewPlans";
import { validateRazorpayPlan } from "@/lib/billing/validatePlan";
import { PLAN_PRICING } from "@/config/plans";

const planFetch = (plan: any) => (async () => new Response(JSON.stringify(plan), { status: 200 })) as unknown as typeof fetch;

describe("auto-renew plan mapping", () => {
  it("maps each prepaid plan to its Razorpay period, interval, ~1 year cap and price", () => {
    expect(AUTORENEW_PLANS.weekly).toMatchObject({ envVar: "RAZORPAY_AUTORENEW_PLAN_WEEKLY", period: "weekly", interval: 1, totalCount: 52, amountPaise: 39900 });
    expect(AUTORENEW_PLANS.monthly).toMatchObject({ envVar: "RAZORPAY_AUTORENEW_PLAN_MONTHLY", period: "monthly", interval: 1, totalCount: 12, amountPaise: 49900 });
    expect(AUTORENEW_PLANS.quarterly).toMatchObject({ envVar: "RAZORPAY_AUTORENEW_PLAN_QUARTERLY", period: "monthly", interval: 3, totalCount: 4, amountPaise: 219900 });
  });

  it("takes amounts from PLAN_PRICING so prices change in one place", () => {
    for (const code of ["weekly", "monthly", "quarterly"] as const) {
      expect(AUTORENEW_PLANS[code].amountPaise).toBe(PLAN_PRICING[code].price_paise);
    }
  });

  it("returns null for unknown or empty plan codes", () => {
    expect(getAutoRenewPlan("quarterly")?.interval).toBe(3);
    for (const bad of [null, undefined, "", "annual", "toString", "__proto__"]) {
      expect(getAutoRenewPlan(bad as any)).toBeNull();
    }
  });
});

describe("validateRazorpayPlan against the expected plan", () => {
  const inr = (amount: number) => ({ amount, currency: "INR" });

  it("accepts a matching quarterly plan (monthly x3) and rejects interval 1", async () => {
    const ok = await validateRazorpayPlan("plan_q", "k", "s", {
      expected: AUTORENEW_PLANS.quarterly,
      fetchFn: planFetch({ period: "monthly", interval: 3, item: inr(219900) }),
    });
    expect(ok.valid).toBe(true);

    const bad = await validateRazorpayPlan("plan_q", "k", "s", {
      expected: AUTORENEW_PLANS.quarterly,
      fetchFn: planFetch({ period: "monthly", interval: 1, item: inr(219900) }),
    });
    expect(bad).toMatchObject({ valid: false, code: "INVALID_PLAN_INTERVAL" });
  });

  it("rejects a weekly plan configured with the wrong period", async () => {
    const res = await validateRazorpayPlan("plan_w", "k", "s", {
      expected: AUTORENEW_PLANS.weekly,
      fetchFn: planFetch({ period: "monthly", interval: 1, item: inr(39900) }),
    });
    expect(res).toMatchObject({ valid: false, code: "INVALID_PLAN_PERIOD" });
  });

  it("defaults to the Rs 499 monthly plan when no expected plan is given", async () => {
    const res = await validateRazorpayPlan("plan_m", "k", "s", {
      fetchFn: planFetch({ period: "monthly", interval: 1, item: inr(39900) }),
    });
    expect(res).toMatchObject({ valid: false, code: "INVALID_PLAN_AMOUNT" });
  });
});
