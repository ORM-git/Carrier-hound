import { createClient } from "@supabase/supabase-js";

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "billing/dunning" } });

export interface DunningEventPayload {
  userId: string;
  provider: "razorpay" | "stripe";
  subscriptionId?: string;
  failureReason?: string;
  userEmail?: string;
}

/**
 * Handles subscription renewal failure:
 * 1. Grants a 7-day grace period so the candidate doesn't lose immediate access
 * 2. Updates subscription status to 'in_grace_period'
 * 3. Logs dunning event and queues renewal alert notification email
 */
export async function processFailedRenewalDunning(payload: DunningEventPayload) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) return;

  const supabase = createClient(url, key);
  const now = new Date();
  const gracePeriodEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days

  try {
    // 1. Put subscription into grace period
    await supabase
      .from("subscriptions")
      .update({
        status: "in_grace_period",
        grace_period_end: gracePeriodEnd.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("user_id", payload.userId);

    // 2. Queue dunning email & audit log
    await supabase.from("dunning_logs").insert({
      user_id: payload.userId,
      provider: payload.provider,
      subscription_id: payload.subscriptionId || null,
      event_type: "payment_failed",
      failure_reason: payload.failureReason || "Payment transaction declined by issuing bank",
      grace_period_expires_at: gracePeriodEnd.toISOString(),
      dunning_email_queued: true,
      metadata: {
        recipient_email: payload.userEmail,
        grace_days_granted: 7,
        queued_at: now.toISOString(),
      },
    });

    log.info(`[Dunning] User ${payload.userId} placed in 7-day grace period until ${gracePeriodEnd.toISOString()}. Dunning email queued.`);
  } catch (err) {
    log.warn("Failed to process renewal failure dunning:", { error: err });
  }
}
