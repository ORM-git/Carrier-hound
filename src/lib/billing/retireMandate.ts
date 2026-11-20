import { recordFailedEvent } from "../events/failedEvents";
import { cancelRazorpayMandate, GatewayOptions } from "./pendingMandate";

/**
 * A paid subscription event that does not grant access (the mandate was superseded, expired, or is not the user's
 * bound mandate) must not leave that mandate able to charge again: cancel it at Razorpay now, mark its order
 * expired and record the captured payment for refund.
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
}): Promise<{ razorpayCancelled: boolean }> {
  const { supabaseAdmin, subscriptionId, paymentId, eventId, eventType, mode, reason, gateway } = opts;
  const razorpayCancelled = gateway ? await cancelRazorpayMandate(subscriptionId, gateway) : false;

  try {
    await supabaseAdmin
      .from("payment_orders")
      .update({ status: "expired" })
      .eq("provider_order_id", subscriptionId)
      .eq("status", "created");
  } catch {}

  try {
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId,
      payload: { event: eventType, subscription_id: subscriptionId, payment_id: paymentId, mode, reason, razorpay_cancelled: razorpayCancelled },
      error: `Payment captured without entitlement (${reason}); refund required${razorpayCancelled ? "" : "; Razorpay cancel NOT confirmed, cancel manually"}`,
      supabaseClient: supabaseAdmin,
    });
  } catch {}

  return { razorpayCancelled };
}
