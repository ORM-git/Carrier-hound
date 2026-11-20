import { recordFailedEvent } from "../events/failedEvents";
import { ensureMandateNotChargeable, GatewayOptions } from "./pendingMandate";

/**
 * A paid subscription event that does not grant access (the mandate is not the user's bound mandate) must not
 * leave that mandate able to charge again: confirm it is cancelled at Razorpay, record the captured payment for
 * refund, then mark its order expired.
 *
 * ok is true only when Razorpay confirmed the mandate cannot charge AND the refund record was durably written.
 * Otherwise the webhook must answer with a retryable error so Razorpay redelivers; both steps are safe to repeat
 * (a repeated cancel is confirmed by Razorpay's terminal state, and failed_events is idempotent per event id).
 */
export async function retireUnentitledMandate(opts: {
  supabaseAdmin: any;
  subscriptionId: string;
  paymentId: string;
  eventId: string;
  eventType: string;
  mode: string;
  reason: string;
  gateway: GatewayOptions | null;
}): Promise<{ ok: boolean; razorpayCancelled: boolean; recorded: boolean }> {
  const { supabaseAdmin, subscriptionId, paymentId, eventId, eventType, mode, reason, gateway } = opts;

  const razorpayCancelled = gateway ? await ensureMandateNotChargeable(subscriptionId, gateway) : false;
  if (!razorpayCancelled) return { ok: false, razorpayCancelled, recorded: false };

  let recorded = false;
  try {
    const result = await recordFailedEvent({
      source: "razorpay_webhook",
      eventId,
      payload: { event: eventType, subscription_id: subscriptionId, payment_id: paymentId, mode, reason, razorpay_cancelled: true },
      error: `Payment captured without entitlement (${reason}); mandate cancelled at Razorpay; refund required`,
      supabaseClient: supabaseAdmin,
    });
    recorded = Boolean(result?.ok);
  } catch {
    recorded = false;
  }
  if (!recorded) return { ok: false, razorpayCancelled, recorded };

  // Best effort: the mandate is already non-chargeable and the refund is recorded
  try {
    await supabaseAdmin
      .from("payment_orders")
      .update({ status: "expired" })
      .eq("provider_order_id", subscriptionId)
      .eq("status", "created");
  } catch {}

  return { ok: true, razorpayCancelled, recorded };
}
