/**
 * Auto-renew (Razorpay Subscriptions) plan mapping for the three prepaid price points.
 *
 * Razorpay plan IDs are never hardcoded: each plan reads its ID from the env var named here.
 * Razorpay has no "quarterly" period, so quarterly is period=monthly, interval=3.
 * total_count caps every mandate at about one year of cycles.
 */
import { PLAN_PRICING } from "../../config/plans";

export type AutoRenewPlanCode = "weekly" | "monthly" | "quarterly";

export interface AutoRenewPlanSpec {
  planCode: AutoRenewPlanCode;
  envVar: string;
  period: "weekly" | "monthly";
  interval: number;
  totalCount: number;
  amountPaise: number;
}

export const AUTORENEW_PLANS: Record<AutoRenewPlanCode, AutoRenewPlanSpec> = {
  weekly: {
    planCode: "weekly",
    envVar: "RAZORPAY_AUTORENEW_PLAN_WEEKLY",
    period: "weekly",
    interval: 1,
    totalCount: 52,
    amountPaise: PLAN_PRICING.weekly.price_paise,
  },
  monthly: {
    planCode: "monthly",
    envVar: "RAZORPAY_AUTORENEW_PLAN_MONTHLY",
    period: "monthly",
    interval: 1,
    totalCount: 12,
    amountPaise: PLAN_PRICING.monthly.price_paise,
  },
  quarterly: {
    planCode: "quarterly",
    envVar: "RAZORPAY_AUTORENEW_PLAN_QUARTERLY",
    period: "monthly",
    interval: 3,
    totalCount: 4,
    amountPaise: PLAN_PRICING.quarterly.price_paise,
  },
};

export function getAutoRenewPlan(planCode: string | null | undefined): AutoRenewPlanSpec | null {
  return planCode && Object.prototype.hasOwnProperty.call(AUTORENEW_PLANS, planCode)
    ? AUTORENEW_PLANS[planCode as AutoRenewPlanCode]
    : null;
}
