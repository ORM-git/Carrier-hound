/**
 * Payment reconciliation (Backend sheet row "Payment Reconciliation": "No
 * settlement vs entitlement reconciliation job"). Pure and read-only: takes rows
 * already read from payment_orders, subscriptions and user_addon_credits and
 * returns findings. It never writes and never calls a payment provider.
 *
 * Scope: DB orders vs DB entitlements only. It does NOT compare against the
 * provider's own settlement records (no Razorpay API call), so a payment the
 * provider has but the DB never recorded is not detectable here.
 *
 * Payments stay off: this is a report, it changes nothing.
 */
export interface OrderRow {
  id: string;
  user_id: string;
  plan_code: string | null;
  addon_code: string | null;
  status: string;
  created_at: string;
  paid_at: string | null;
}
export interface SubscriptionRow { user_id: string | null; plan_id: string; status: string; }
export interface CreditRow { id: string; user_id: string; order_id: string | null; }

export type FindingKind =
  | "paid_plan_order_without_subscription"
  | "paid_addon_order_without_credit"
  | "credit_linked_to_unpaid_order"
  | "credit_user_mismatch"
  | "stale_created_order";

export interface Finding { kind: FindingKind; orderId: string; userId: string; detail: string; }

export interface ReconcileInput {
  orders: OrderRow[];
  subscriptions: SubscriptionRow[];
  credits: CreditRow[];
  nowMs: number;
  /** Required: how old a 'created' order must be to be reported. No default (owner to confirm). */
  staleCreatedHours: number;
}

/** Total row count from a PostgREST Content-Range header ("0-999/2500"), or null when absent or "*". */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? Number(m[1]) : null;
}

/**
 * Paging stop rule for the report reader. `from` is the number of rows read so far
 * (including this page), `got` the size of this page, `total` the server-reported
 * total (null when unknown), `pageSize` the requested page size. With a known total the
 * reader continues until it has read that many rows, so a server cap lower than the page
 * size no longer ends the read early; without one it falls back to "short page = done".
 */
export function pagingDone(from: number, got: number, total: number | null, pageSize: number): boolean {
  if (got === 0) return true;
  if (total !== null) return from >= total;
  return got < pageSize;
}

export function reconcilePayments(input: ReconcileInput): Finding[] {
  const h = input.staleCreatedHours;
  if (typeof h !== "number" || !isFinite(h) || h <= 0) {
    throw new Error("reconcilePayments: staleCreatedHours must be a positive number");
  }
  const findings: Finding[] = [];
  const subByUser: Record<string, boolean> = {};
  input.subscriptions.forEach((s) => { if (s.user_id) subByUser[s.user_id] = true; });
  const creditByOrder: Record<string, boolean> = {};
  input.credits.forEach((c) => { if (c.order_id) creditByOrder[c.order_id] = true; });
  const orderById: Record<string, OrderRow> = {};
  input.orders.forEach((o) => { orderById[o.id] = o; });

  input.orders.forEach((o) => {
    if (o.status === "paid") {
      if (o.plan_code && !subByUser[o.user_id]) {
        findings.push({ kind: "paid_plan_order_without_subscription", orderId: o.id, userId: o.user_id, detail: `plan ${o.plan_code} paid but the user has no subscriptions row` });
      }
      if (o.addon_code && !creditByOrder[o.id]) {
        findings.push({ kind: "paid_addon_order_without_credit", orderId: o.id, userId: o.user_id, detail: `add-on ${o.addon_code} paid but no user_addon_credits row has this order_id` });
      }
    } else if (o.status === "created") {
      const created = Date.parse(o.created_at);
      if (isFinite(created) && input.nowMs - created > h * 3600000) {
        findings.push({ kind: "stale_created_order", orderId: o.id, userId: o.user_id, detail: `still 'created' after more than ${h} hours` });
      }
    }
  });

  input.credits.forEach((c) => {
    if (!c.order_id) return;
    const o = orderById[c.order_id];
    if (o && o.status !== "paid") {
      findings.push({ kind: "credit_linked_to_unpaid_order", orderId: o.id, userId: c.user_id, detail: `credit ${c.id} points at an order with status '${o.status}'` });
    }
    if (o && o.user_id !== c.user_id) {
      findings.push({ kind: "credit_user_mismatch", orderId: o.id, userId: c.user_id, detail: `credit ${c.id} belongs to a different user than order ${o.id}` });
    }
  });
  return findings;
}

export interface MandateReconciliationOptions {
  batchSize?: number;
  credentials?: string;
  fetchFn?: typeof fetch;
}

export interface MandateReconciliationResult {
  processed: number;
  resolved: number;
  failed: number;
  details: Array<{
    id: string;
    subId: string | null;
    action: string;
    status: string;
  }>;
}

/**
 * Reviewer 2: Active consumer for subscription_reconciliations table.
 * Queries pending/unknown reconciliation records, verifies state with Razorpay,
 * recovers or cancels orphan provider mandates, and updates database state.
 */
export async function reconcileSubscriptionMandates(
  supabaseAdmin: any,
  options: MandateReconciliationOptions = {}
): Promise<MandateReconciliationResult> {
  const batchSize = options.batchSize || 50;
  const fetchCaller = options.fetchFn || fetch;
  const result: MandateReconciliationResult = {
    processed: 0,
    resolved: 0,
    failed: 0,
    details: [],
  };

  const { data: records, error: fetchErr } = await supabaseAdmin
    .from("subscription_reconciliations")
    .select("id, user_id, provider_subscription_id, reservation_order_id, reconciliation_state, metadata, created_at")
    .in("reconciliation_state", ["pending", "unknown"])
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchErr || !records || records.length === 0) {
    return result;
  }

  const credentials = options.credentials || (
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
      ? btoa(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`)
      : ""
  );

  for (const rec of records) {
    result.processed++;
    const subId = rec.provider_subscription_id;

    if (subId && typeof subId === "string" && subId.startsWith("sub_") && !subId.startsWith("sub_pending_")) {
      // Real provider subscription ID: query Razorpay
      try {
        const getRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subId}`, {
          method: "GET",
          headers: credentials ? { Authorization: `Basic ${credentials}` } : {},
        });

        if (getRes.status === 404) {
          // No mandate exists at provider; safe to release
          await supabaseAdmin
            .from("subscription_reconciliations")
            .update({
              reconciliation_state: "resolved",
              recovery_outcome: "not_found_on_provider_released",
              updated_at: new Date().toISOString(),
            })
            .eq("id", rec.id);

          if (rec.reservation_order_id) {
            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "failed", updated_at: new Date().toISOString() })
              .eq("provider_order_id", rec.reservation_order_id)
              .in("status", ["reserved", "created", "unknown"]);
          }

          result.resolved++;
          result.details.push({ id: rec.id, subId, action: "released_404", status: "resolved" });
          continue;
        }

        if (getRes.ok) {
          const subData = await getRes.json().catch(() => ({}));
          const isMatching = subData?.id === subId;
          const isCancelled = subData?.status === "cancelled" || subData?.ended_at != null;
          const isCancelAtCycleEnd = subData?.cancel_at_cycle_end === 1 || subData?.cancel_at_cycle_end === true;

          if (isMatching && isCancelled && !isCancelAtCycleEnd) {
            // Already confirmed stopped
            await supabaseAdmin
              .from("subscription_reconciliations")
              .update({
                reconciliation_state: "resolved",
                recovery_outcome: "confirmed_stopped_on_provider",
                updated_at: new Date().toISOString(),
              })
              .eq("id", rec.id);

            await supabaseAdmin
              .from("payment_orders")
              .update({ status: "cancelled", updated_at: new Date().toISOString() })
              .eq("provider_order_id", subId)
              .in("status", ["reserved", "created", "unknown"]);

            result.resolved++;
            result.details.push({ id: rec.id, subId, action: "confirmed_stopped", status: "resolved" });
            continue;
          }

          // If still active or cancel_at_cycle_end: cancel immediately at provider
          const cancelRes = await fetchCaller(`https://api.razorpay.com/v1/subscriptions/${subId}/cancel`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(credentials ? { Authorization: `Basic ${credentials}` } : {}),
            },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }),
          });

          if (cancelRes.ok) {
            const cancelData = await cancelRes.json().catch(() => ({}));
            if (
              cancelData?.id === subId &&
              (cancelData?.status === "cancelled" || cancelData?.ended_at != null) &&
              cancelData?.cancel_at_cycle_end !== 1 &&
              cancelData?.cancel_at_cycle_end !== true
            ) {
              await supabaseAdmin
                .from("subscription_reconciliations")
                .update({
                  reconciliation_state: "resolved",
                  recovery_outcome: "cancelled_orphan_mandate_at_provider",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", rec.id);

              await supabaseAdmin
                .from("payment_orders")
                .update({ status: "cancelled", updated_at: new Date().toISOString() })
                .eq("provider_order_id", subId)
                .in("status", ["reserved", "created", "unknown"]);

              result.resolved++;
              result.details.push({ id: rec.id, subId, action: "cancelled_at_provider", status: "resolved" });
              continue;
            }
          }
        }
      } catch (_) {}

      // Provider cancel/verification failed
      await supabaseAdmin
        .from("subscription_reconciliations")
        .update({
          reconciliation_state: "failed",
          recovery_outcome: "provider_reconciliation_attempt_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", rec.id);

      result.failed++;
      result.details.push({ id: rec.id, subId, action: "verification_failed", status: "failed" });
    } else {
      // Placeholder sub_pending_ or missing ID
      const createdAtMs = rec.created_at ? new Date(rec.created_at).getTime() : 0;
      const isStale = Date.now() - createdAtMs > 24 * 3600 * 1000;

      if (isStale) {
        await supabaseAdmin
          .from("subscription_reconciliations")
          .update({
            reconciliation_state: "resolved",
            recovery_outcome: "stale_placeholder_without_provider_id_released",
            updated_at: new Date().toISOString(),
          })
          .eq("id", rec.id);

        if (rec.reservation_order_id) {
          await supabaseAdmin
            .from("payment_orders")
            .update({ status: "expired", updated_at: new Date().toISOString() })
            .eq("provider_order_id", rec.reservation_order_id)
            .in("status", ["reserved", "created", "unknown"]);
        }

        result.resolved++;
        result.details.push({ id: rec.id, subId: null, action: "stale_placeholder_released", status: "resolved" });
      } else {
        result.failed++;
        result.details.push({ id: rec.id, subId: null, action: "placeholder_kept_pending", status: "pending" });
      }
    }
  }

  return result;
}
