/**
 * Scheduled Mandate Reconciliation Job.
 *
 * Scans for stuck/failed recurring mandates in payment_orders and subscription_reconciliations,
 * enqueues pending reconciliation records, and runs the active mandate recovery consumer.
 */
import { reconcileSubscriptionMandates, MandateReconciliationResult } from "./reconcile";

export interface MandateReconciliationJobOptions {
  supabaseAdmin: any;
  jobAuthSecret?: string;
  expectedSecret?: string;
  fetchFn?: typeof fetch;
  credentials?: string;
  staleHours?: number;
  batchSize?: number;
}

export interface MandateReconciliationJobResult {
  success: boolean;
  stuckOrdersFound: number;
  enqueuedCount: number;
  recoveryResult?: MandateReconciliationResult;
  error?: string;
}

export async function runMandateReconciliationJob(
  options: MandateReconciliationJobOptions
): Promise<MandateReconciliationJobResult> {
  // 1. Verify Job Authentication / Authorization
  const expectedSecret = options.expectedSecret !== undefined ? options.expectedSecret : process.env.CRON_SECRET;
  if (expectedSecret) {
    if (!options.jobAuthSecret || options.jobAuthSecret !== expectedSecret) {
      throw new Error("UNAUTHORIZED_JOB_INVOCATION: Invalid or missing cron authentication secret");
    }
  }

  const supabaseAdmin = options.supabaseAdmin;
  if (!supabaseAdmin) {
    throw new Error("UNAUTHORIZED_JOB_INVOCATION: Missing supabaseAdmin client");
  }

  const staleHours = typeof options.staleHours === "number" && options.staleHours > 0 ? options.staleHours : 1;
  const batchSize = options.batchSize || 50;
  const cutoffTime = new Date(Date.now() - staleHours * 3600 * 1000).toISOString();

  // 2. Scan payment_orders for stuck recurring mandates
  const { data: stuckOrders } = await supabaseAdmin
    .from("payment_orders")
    .select("id, user_id, provider_order_id, status, created_at")
    .eq("mode", "recurring")
    .in("status", ["reserved", "created", "unknown", "failed"])
    .lte("created_at", cutoffTime)
    .limit(batchSize);

  let enqueuedCount = 0;
  const orders = stuckOrders || [];

  if (orders.length > 0) {
    const reservationIds = orders
      .map((o: any) => o.provider_order_id)
      .filter((id: any): id is string => typeof id === "string" && id.length > 0);

    let existingReservationIds = new Set<string>();
    if (reservationIds.length > 0) {
      const { data: existingRecs } = await supabaseAdmin
        .from("subscription_reconciliations")
        .select("reservation_order_id")
        .in("reservation_order_id", reservationIds);

      existingReservationIds = new Set((existingRecs || []).map((r: any) => r.reservation_order_id));
    }

    const recordsToInsert = orders
      .filter((o: any) => o.provider_order_id && !existingReservationIds.has(o.provider_order_id))
      .map((o: any) => {
        const isRealSubId =
          typeof o.provider_order_id === "string" &&
          o.provider_order_id.startsWith("sub_") &&
          !o.provider_order_id.startsWith("sub_pending_");

        return {
          user_id: o.user_id,
          provider: "razorpay",
          provider_subscription_id: isRealSubId ? o.provider_order_id : null,
          reservation_order_id: o.provider_order_id,
          reconciliation_state: "pending",
          failure_reason: `stale_${o.status}_mandate_detected_by_cron`,
          metadata: {
            source: "scheduled_reconciliation_job",
            detected_status: o.status,
            order_id: o.id,
          },
        };
      });

    if (recordsToInsert.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from("subscription_reconciliations")
        .insert(recordsToInsert);

      if (!insertErr) {
        enqueuedCount = recordsToInsert.length;
      }
    }
  }

  // 3. Pass stuck/pending mandates to recovery code
  const recoveryResult = await reconcileSubscriptionMandates(supabaseAdmin, {
    fetchFn: options.fetchFn,
    credentials: options.credentials,
    batchSize,
  });

  return {
    success: true,
    stuckOrdersFound: orders.length,
    enqueuedCount,
    recoveryResult,
  };
}
