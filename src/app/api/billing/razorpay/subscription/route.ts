import { NextResponse } from "next/server";

/**
 * Recurring (auto-renew) Razorpay subscriptions are disabled for launch.
 *
 * All plans are one-time prepaid orders created via /api/billing/razorpay/order.
 * This route is intentionally inert: it never reads NEXT_PUBLIC_AUTORENEW_ENABLED,
 * never touches Supabase or Razorpay, and always answers 410 Gone so no flag or
 * client can create a recurring subscription.
 */
export const runtime = "edge";

const RECURRING_DISABLED_BODY = {
  error: "Recurring subscriptions are disabled. All plans are one-time prepaid purchases.",
  code: "RECURRING_DISABLED",
} as const;

export async function POST(_req: Request) {
  return NextResponse.json(RECURRING_DISABLED_BODY, { status: 410 });
}
