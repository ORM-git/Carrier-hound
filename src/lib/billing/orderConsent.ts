/**
 * Ensures a reused pending payment_orders row durably carries auto-renew consent.
 * Existing consent is kept; missing consent is merged into metadata (other keys preserved).
 * Returns false when the write fails, so callers can fail closed.
 */
export async function ensureOrderConsent(
  supabaseAdmin: any,
  userId: string,
  order: { provider_order_id: string; metadata?: Record<string, any> | null },
  consent: Record<string, any>
): Promise<boolean> {
  if (order.metadata?.consent) return true;
  const { error } = await supabaseAdmin
    .from("payment_orders")
    .update({ metadata: { ...(order.metadata || {}), consent } })
    .eq("user_id", userId)
    .eq("provider_order_id", order.provider_order_id);
  return !error;
}
