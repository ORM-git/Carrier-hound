export type BillingProvider = "razorpay" | "manual";

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
  currency: "INR";
  price: number; // in INR
  formattedPrice: string;
  period: "week" | "month" | "quarter";
  features: string[];
}

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
  isPro: boolean;
  status: SubscriptionStatus;
  planName?: string;
  inGracePeriod: boolean;
  graceDaysLeft?: number;
  expirationDate?: string;
  isLoading?: boolean;
  isDefinitive?: boolean;
}
