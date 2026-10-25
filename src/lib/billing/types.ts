export type BillingProvider = "razorpay" | "stripe" | "manual";

export type UserTier = "none" | "listings" | "ai";

export type SubscriptionStatus =
  | "none"
  | "active"
  | "trialing"
  | "in_grace_period"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "loading"
  | "unknown";

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  provider: BillingProvider;
  currency: "INR" | "USD";
  price: number; // In display currency (e.g. 199 or 9)
  formattedPrice: string;
  period: "month";
  features: string[];
}

export const PLAN_DOMESTIC: BillingPlan = {
  id: "domestic_monthly_199",
  name: "India Domestic Pro Pass",
  description: "Optimized for Indian developers and regional tech applications.",
  provider: "razorpay",
  currency: "INR",
  price: 199,
  formattedPrice: "₹199 / month",
  period: "month",
  features: [
    "Direct Company ATS Endpoints (Greenhouse, Lever, Ashby)",
    "Unmasked Verified Salary Bands & Equity",
    "Instant UPI (GPay, PhonePe, Paytm), RuPay & Cards",
    "Compatibility Match Scoring & Tailored Cover Letters",
    "Application Kanban Pipeline with Auto-Sync",
    "Priority 3D Globe Radar Density Filters",
  ],
};

export const PLAN_INTERNATIONAL: BillingPlan = {
  id: "intl_monthly_9",
  name: "Global International Pro Pass",
  description: "Unrestricted Worldwide Remote access across 37 global tech hubs.",
  provider: "stripe",
  currency: "USD",
  price: 9,
  formattedPrice: "$9 / month",
  period: "month",
  features: [
    "All Direct Company ATS Endpoints Worldwide",
    "Unmasked Verified Compensation across US, EU & APAC",
    "Global Credit/Debit Cards, Apple Pay & Google Pay",
    "Compatibility Match Scoring & Tailored Cover Letters",
    "Application Kanban Pipeline with Auto-Sync",
    "Priority 3D Globe Radar Density Filters",
  ],
};

export const PLAN_LISTINGS_TIER: BillingPlan = {
  id: "listings_launch_pass",
  name: "Listings Pass (No-Payment Launch)",
  description: "Direct ATS endpoints and verified salary bands without AI features.",
  provider: "manual",
  currency: "USD",
  price: 0,
  formattedPrice: "Free (Launch)",
  period: "month",
  features: [
    "Direct Company ATS Endpoints (Greenhouse, Lever, Ashby)",
    "Unmasked Verified Salary Bands & Compensation",
    "Full Unredacted Job Descriptions & Apply URLs",
    "Application Kanban Pipeline with Auto-Sync",
  ],
};

export const PLAN_AI_TIER: BillingPlan = {
  id: "ai_launch_pass",
  name: "AI Pro Pass (No-Payment Launch)",
  description: "Full unmasked listings plus candidate compatibility scores and AI tailoring.",
  provider: "manual",
  currency: "USD",
  price: 0,
  formattedPrice: "Free (Launch)",
  period: "month",
  features: [
    "All Listings Tier Features Included",
    "Compatibility Match Scores & Ring Indicators",
    "Detailed Candidate Fit Diagnostics",
    "Sort Jobs by Candidate Match",
    "AI Resume Tailoring & Cover Letter Generation",
  ],
};

export interface UserSubscription {
  id: string;
  userId: string;
  provider: BillingProvider;
  planId: string;
  currency: string;
  amount: number;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  gracePeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
  metadata?: Record<string, any>;
}

export interface ProAccessStatus {
  tier: UserTier;
  canAccessListings: boolean;
  canAccessScores: boolean;
  canAccessAi: boolean;
  isPro: boolean;
  status: SubscriptionStatus;
  planName?: string;
  inGracePeriod: boolean;
  graceDaysLeft?: number;
  expirationDate?: string;
  isLoading?: boolean;
  isDefinitive?: boolean;
}
