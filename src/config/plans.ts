/**
 * src/config/plans.ts
 *
 * Central configuration file for CareerMonke subscription plans, quotas, and pricing.
 * Single source of truth for pricing amounts, intervals, sub-lines, badges, add-on packs,
 * comparison capabilities, and policy notes.
 *
 * APPROVED PRICES & QUOTAS:
 * - Weekly: ₹692, billed weekly: 15 sets/week. (Supersedes old ₹499 price).
 * - Monthly: ₹1,499, billed monthly: 60 sets/month. Badge: "Recommended". Default selected.
 * - Quarterly: ₹3,999, billed every 3 months: 60 sets each month, resetting monthly. Badge: "Best value".
 * - Separate usage pools per feature: Weekly = 15 resume tailorings + 15 cover letters per 7 days; Monthly (30 days) & Quarterly (90 days) = 60 resume tailorings + 60 cover letters per 30 days.
 * - Add-ons: ₹149 / ₹399 / ₹699 for 10 / 30 / 60 extra generations, valid 60 days (planned / coming soon).
 * - Anti-abuse daily limit: 30 generations/day.
 */

export type PlanInterval = "week" | "month" | "quarter";

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

export interface FreeTierConfig {
  name: string;
  price: number;
  currency: "INR";
  billingText: string;
  subLine: string;
  ctaText: string;
  features: string[];
}

export interface AddOnPack {
  price: number;
  sets: number;
}

export interface PlanComparisonRow {
  category: string;
  feature: string;
  description: string;
  free: string | boolean;
  premium: string | boolean;
  isUpcoming?: boolean;
}

export const ADD_ON_PACKS: AddOnPack[] = [
  { price: 149, sets: 10 },
  { price: 399, sets: 30 },
  { price: 699, sets: 60 },
];

export const ADD_ON_PACKS_NOTE =
  "Add-ons: ₹149 / ₹399 / ₹699 for 10 / 30 / 60 extra generations. Note: add-on packs can only be added for additional usage on an active subscription.";

export const REFUND_POLICY_NOTE = "All sales final, no refunds";

export const FAIR_USE_LIMIT_NOTE =
  "Fair-use limit: 30 generations per day on every plan.";

/**
 * Per-feature quota summary. Values mirror PLAN_DEFINITIONS in src/lib/billing/quota.ts
 * (resume_quota, cover_letter_quota, quota_period_days, duration_days). Kept as a literal so
 * this client-imported config never pulls the server-only quota module into the browser bundle;
 * scripts/test-razorpay-pricing-about.ts asserts it stays in sync with PLAN_DEFINITIONS.
 */
export const PLAN_QUOTA_SUMMARY_NOTE =
  "Separate usage pools per feature: Weekly includes 15 AI resume tailorings + 15 AI cover letters per 7 days; Monthly (30 days) and Quarterly (90 days) include 60 AI resume tailorings + 60 AI cover letters per 30 days.";

export const PER_WEEK_NOTE =
  "*Per-week figures are calculated as (monthly price × 12 / 52) or (quarterly price × 4 / 52) rounded to the nearest rupee. These are comparisons to show relative savings, not weekly charges.";

export const UPGRADE_BUTTON_LABEL = "Payments opening soon";

export const FREE_TIER_CONFIG: FreeTierConfig = {
  name: "CareerMonke Free",
  price: 0,
  currency: "INR",
  billingText: "Free forever",
  subLine: "Basic search & masked employer previews",
  ctaText: "Current Plan",
  features: [
    "Search unindexed remote tech jobs",
    "Direct employer verification tags",
    "Masked company names & logos",
    "Direct ATS apply links hidden",
    "Masked salary compensation",
    "0 AI application sets",
    "0 Top 10 match unlocks",
  ],
};

export const PLANS: PlanConfig[] = [
  {
    id: "weekly",
    name: "Weekly",
    price: 692,
    originalPrice: 999,
    currency: "INR",
    interval: "week",
    billingText: "Billed weekly",
    subLine: "15 sets/week",
    quotaSets: 15,
    quotaPeriodText: "15 sets per week",
  },
  {
    id: "monthly",
    name: "Monthly",
    price: 1499,
    originalPrice: 2999,
    savingsBadge: "Save 50%",
    currency: "INR",
    interval: "month",
    billingText: "billed monthly",
    subLine: "60 sets/month",
    quotaSets: 60,
    quotaPeriodText: "60 sets per month",
    badge: "Recommended",
    isDefault: true,
  },
  {
    id: "quarterly",
    name: "Quarterly",
    price: 3999,
    originalPrice: 8997,
    savingsBadge: "Save 55%",
    currency: "INR",
    interval: "quarter",
    billingText: "billed every 3 months",
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

export const PLAN_COMPARISON_ROWS: PlanComparisonRow[] = [
  {
    category: "AI Application Tools",
    feature: "AI Custom Resume Generation",
    description: "Tailor resume directly to job requirements in seconds",
    free: "0 sets / month",
    premium: "15 /wk · 60 /mo",
  },
  {
    category: "AI Application Tools",
    feature: "AI Cover Letter Generator",
    description: "Personalized pitch for every single role",
    free: "0 sets / month",
    premium: "15 /wk · 60 /mo",
  },
  {
    category: "Job Search & Data Access",
    feature: "Direct Employer Job Search",
    description: "Search tech roles across verified direct company career pages",
    free: "Unlimited browse",
    premium: "Unlimited browse",
  },
  {
    category: "Job Search & Data Access",
    feature: "Direct ATS Apply Links",
    description: "Direct links to apply on Greenhouse, Lever, Ashby, Workable",
    free: false,
    premium: true,
  },
  {
    category: "Job Search & Data Access",
    feature: "Verified Salary Bands",
    description: "Unmasked compensation ranges with multi-currency conversion",
    free: false,
    premium: true,
  },
  {
    category: "Job Search & Data Access",
    feature: "Employer Identity & Logos",
    description: "Unmask company names and employer logos on listings",
    free: "Masked (\"Verified Employer\")",
    premium: true,
  },
  {
    category: "Intelligence & Pipeline Tools",
    feature: "Top 10 High-Compatibility Matches",
    description: "Top 10 jobs ranked by candidate profile skills & experience",
    free: "Blurred preview",
    premium: true,
  },
  {
    category: "Intelligence & Pipeline Tools",
    feature: "Interactive 3D Globe Radar",
    description: "Interactive 3D visualization of remote jobs across global hubs",
    free: "Upgrade preview",
    premium: true,
  },
  {
    category: "Intelligence & Pipeline Tools",
    feature: "Application Kanban Tracker",
    description: "Track pipeline: Saved, Applied, Interview, Offer, Rejected",
    free: "Upgrade preview",
    premium: true,
  },
  {
    category: "AI Application Tools",
    feature: "Daily AI Anti-Abuse Limit",
    description: "Anti-abuse rate limit to protect system performance",
    free: "0 generations / day",
    premium: "30 generations / day max",
  },
  {
    category: "AI Application Tools",
    feature: "AI Fit Diagnostics (\"Why You Fit\")",
    description: "Deterministic breakdown of missing skills and why you fit each role",
    free: false,
    premium: "Coming soon",
    isUpcoming: true,
  },
  {
    category: "Add-on Capacity",
    feature: "Extra Add-on Credit Packs",
    description: "₹149 / ₹399 / ₹699 for 10 / 30 / 60 extra generations (used after plan quota, expires with subscription)",
    free: false,
    premium: "Coming soon",
    isUpcoming: true,
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
 * Formats a currency amount with the Indian Rupee symbol (e.g. 1499 -> "₹1,499").
 */
export function formatPriceINR(amount: number): string {
  return `₹${formatCurrencyINR(amount)}`;
}

/**
 * Formats the primary billing label for the plan card/row:
 * - Weekly: "Billed weekly"
 * - Monthly: "₹1,499, billed monthly"
 * - Quarterly: "₹3,999, billed every 3 months"
 */
export function getPlanBillingLabel(plan: PlanConfig): string {
  if (plan.interval === "week") {
    return plan.billingText;
  }
  return `₹${formatCurrencyINR(plan.price)}, ${plan.billingText}`;
}

/**
 * Formats the per-week display text for comparison:
 * - Weekly: "₹692 /week"
 * - Monthly: "₹346 /week*"
 * - Quarterly: "₹308 /week*"
 */
export function getPlanPerWeekText(plan: PlanConfig): string {
  const perWeek = calculatePerWeek(plan.price, plan.interval);
  const asterisk = plan.interval !== "week" ? "*" : "";
  return `₹${formatCurrencyINR(perWeek)} /week${asterisk}`;
}
