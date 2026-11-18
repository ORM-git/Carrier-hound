/**
 * src/config/plans.ts
 *
 * Central configuration file for CareerMonke subscription plans, quotas, and pricing.
 * Single source of truth for pricing amounts, intervals, badges and the add-on pack
 * catalog used by checkout.
 *
 * APPROVED PRICES & QUOTAS:
 * - Weekly: ₹399, access 7 days: 15 sets/week.
 * - Monthly: ₹499 for everyone, access 30 days: 60 sets/month. Badge: "Recommended". Default selected.
 * - Quarterly: ₹2,199, access 90 days: 60 sets each month, resetting monthly. Badge: "Best value".
 * - Separate usage pools per feature: Weekly = 15 resume tailorings + 15 cover letters per 7 days; Monthly (30 days) & Quarterly (90 days) = 60 resume tailorings + 60 cover letters per 30 days.
 * - Add-ons: ₹149 / ₹399 / ₹699 for 10 / 30 / 60 extra generations (checkout catalog only; not shown on /pricing).
 * - Anti-abuse daily limit: 30 generations/day.
 */

export type PlanInterval = "week" | "month" | "quarter";

export interface PlanPricingItem {
  code: "weekly" | "monthly" | "quarterly";
  name: string;
  duration_days: number;
  price_paise: number;
  price_inr: number;
}

/**
 * Server-side source of truth for plan pricing and durations.
 * All amounts kept in this ONE config file so prices change in one place.
 */
export const PLAN_PRICING: Record<"weekly" | "monthly" | "quarterly", PlanPricingItem> = {
  weekly: {
    code: "weekly",
    name: "Weekly",
    duration_days: 7,
    price_paise: 39900,
    price_inr: 399,
  },
  monthly: {
    code: "monthly",
    name: "Monthly",
    duration_days: 30,
    price_paise: 49900,
    price_inr: 499,
  },
  quarterly: {
    code: "quarterly",
    name: "Quarterly",
    duration_days: 90,
    price_paise: 219900,
    price_inr: 2199,
  },
} as const;

export function getPlanPricePaise(
  planCode: "weekly" | "monthly" | "quarterly"
): number {
  return PLAN_PRICING[planCode]?.price_paise ?? 0;
}

export function getPlanPriceINR(
  planCode: "weekly" | "monthly" | "quarterly"
): number {
  return PLAN_PRICING[planCode]?.price_inr ?? 0;
}

/**
 * Flat prepaid price summary built from PLAN_PRICING, used by Pricing, Terms and Refund copy.
 * e.g. "Weekly: ₹399 for 7 days, Monthly: ₹499 for 30 days, Quarterly: ₹2,199 for 90 days"
 */
export const PREPAID_PRICE_SUMMARY: string = (["weekly", "monthly", "quarterly"] as const)
  .map((code) => {
    const p = PLAN_PRICING[code];
    return `${p.name}: ₹${p.price_inr.toLocaleString("en-IN")} for ${p.duration_days} days`;
  })
  .join(", ");

export interface PlanConfig {
  id: "weekly" | "monthly" | "quarterly";
  name: string;
  price: number; // in INR (₹)
  originalPrice?: number;
  savingsBadge?: string;
  currency: "INR";
  interval: PlanInterval;
  billingText: string;
  subLine: string;
  quotaSets: number;
  quotaPeriodText: string;
  badge?: "Recommended" | "Best value" | "Most popular";
  isDefault?: boolean;
}

export interface AddOnPack {
  code: "addon_10" | "addon_30" | "addon_60";
  price: number;
  sets: number;
}

export const ADD_ON_PACKS: AddOnPack[] = [
  { code: "addon_10", price: 149, sets: 10 },
  { code: "addon_30", price: 399, sets: 30 },
  { code: "addon_60", price: 699, sets: 60 },
];

export const REFUND_POLICY_NOTE = "All sales final, no refunds";

export const PLANS: PlanConfig[] = [
  {
    id: "weekly",
    name: "Weekly",
    price: PLAN_PRICING.weekly.price_inr,
    originalPrice: 599,
    currency: "INR",
    interval: "week",
    billingText: "7 days access",
    subLine: "15 sets/week",
    quotaSets: 15,
    quotaPeriodText: "15 sets per week",
  },
  {
    id: "monthly",
    name: "Monthly",
    price: PLAN_PRICING.monthly.price_inr,
    originalPrice: 999,
    savingsBadge: "Save 50%",
    currency: "INR",
    interval: "month",
    billingText: "30 days access",
    subLine: "60 sets/month",
    quotaSets: 60,
    quotaPeriodText: "60 sets per month",
    badge: "Recommended",
    isDefault: true,
  },
  {
    id: "quarterly",
    name: "Quarterly",
    price: PLAN_PRICING.quarterly.price_inr,
    originalPrice: 2999,
    savingsBadge: "Save 27%",
    currency: "INR",
    interval: "quarter",
    billingText: "90 days access",
    subLine: "60 sets each month (resets monthly)",
    quotaSets: 60,
    quotaPeriodText: "60 sets each month, resetting monthly",
    badge: "Best value",
  },
];

/**
 * Display order for paid cards in desktop row: Weekly / Monthly / Quarterly
 */
export const PAID_PLANS_DISPLAY_ORDER: Array<PlanConfig["id"]> = [
  "weekly",
  "monthly",
  "quarterly",
];

/**
 * Formats a currency amount into standard INR notation (e.g. 1499 -> "1,499").
 */
export function formatCurrencyINR(amount: number): string {
  return amount.toLocaleString("en-IN");
}

/**
 * Formats a currency amount with the Indian Rupee symbol (e.g. 1499 -> "₹1,499").
 */
export function formatPriceINR(amount: number): string {
  return `₹${formatCurrencyINR(amount)}`;
}
