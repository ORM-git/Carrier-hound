/**
 * src/config/plans.ts
 *
 * Central configuration file for CareerMonke subscription plans, quotas, and pricing.
 * All plan data, pricing, intervals, sub-lines, badges, add-on packs, and policy notes
 * are defined here in one place so prices and terms can change easily later.
 */

export type PlanInterval = "week" | "month" | "quarter";

export interface PlanConfig {
  id: "weekly" | "monthly" | "quarterly";
  name: string;
  price: number; // in INR (Rs)
  currency: "INR";
  interval: PlanInterval;
  billingText: string;
  subLine: string;
  badge?: "Most popular" | "Best value";
  isDefault?: boolean;
}

export interface AddOnPack {
  price: number;
  sets: number;
}

export const ADD_ON_PACKS: AddOnPack[] = [
  { price: 149, sets: 10 },
  { price: 399, sets: 30 },
  { price: 699, sets: 60 },
];

export const ADD_ON_PACKS_NOTE =
  "Need more? Add-on packs Rs 149 / 399 / 699 = 10 / 30 / 60 extra sets, used after your plan quota, valid 60 days";

export const REFUND_POLICY_NOTE = "All sales final, no refunds";

export const FAIR_USE_LIMIT_NOTE =
  "Fair-use limit: 30 generations per day on every plan.";

export const PER_WEEK_NOTE =
  "*Per-week figures are calculated as (monthly price × 12 / 52) or (quarterly price × 4 / 52) rounded to the nearest rupee.";

export const UPGRADE_BUTTON_LABEL = "Payments opening soon";

export const PLANS: PlanConfig[] = [
  {
    id: "weekly",
    name: "Weekly",
    price: 499,
    currency: "INR",
    interval: "week",
    billingText: "Billed weekly",
    subLine: "15 resumes, 15 cover letters per week",
  },
  {
    id: "monthly",
    name: "Monthly",
    price: 1499,
    currency: "INR",
    interval: "month",
    billingText: "billed monthly",
    subLine: "60 resumes, 60 cover letters per month",
    badge: "Most popular",
    isDefault: true,
  },
  {
    id: "quarterly",
    name: "Quarterly",
    price: 3999,
    currency: "INR",
    interval: "quarter",
    billingText: "billed every 3 months",
    subLine: "Same monthly quota for 3 months, one payment",
    badge: "Best value",
  },
];

/**
 * Computes the per-week figure in code from the price.
 * - Weekly: price (already per-week)
 * - Monthly: round(price * 12 / 52)
 * - Quarterly: round(price * 4 / 52)
 */
export function calculatePerWeek(price: number, interval: PlanInterval): number {
  switch (interval) {
    case "week":
      return price;
    case "month":
      return Math.round((price * 12) / 52);
    case "quarter":
      return Math.round((price * 4) / 52);
    default:
      return price;
  }
}

/**
 * Formats a currency amount into standard INR notation (e.g. 1499 -> "1,499").
 */
export function formatCurrencyINR(amount: number): string {
  return amount.toLocaleString("en-IN");
}

/**
 * Formats the primary billing label for the plan row:
 * - Weekly: "Billed weekly"
 * - Monthly: "Rs 1,499, billed monthly"
 * - Quarterly: "Rs 3,999, billed every 3 months"
 */
export function getPlanBillingLabel(plan: PlanConfig): string {
  if (plan.interval === "week") {
    return plan.billingText;
  }
  return `Rs ${formatCurrencyINR(plan.price)}, ${plan.billingText}`;
}

/**
 * Formats the per-week display text for the plan row:
 * - Weekly: "Rs 499 /week"
 * - Monthly: "Rs 346 /week*"
 * - Quarterly: "Rs 308 /week*"
 */
export function getPlanPerWeekText(plan: PlanConfig): string {
  const perWeek = calculatePerWeek(plan.price, plan.interval);
  const asterisk = plan.interval !== "week" ? "*" : "";
  return `Rs ${formatCurrencyINR(perWeek)} /week${asterisk}`;
}
