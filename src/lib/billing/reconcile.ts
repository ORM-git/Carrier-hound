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
