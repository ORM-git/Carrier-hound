/**
 * One pending recurring checkout (Razorpay "created" sub_ mandate) per user, across all auto-renew plans.
 *
 * - Every new mandate is created with expire_by = now + MANDATE_AUTH_WINDOW_SECONDS, so once that passes Razorpay
 *   refuses to authorise it and it can never charge. Until then it is the user's one pending checkout:
 *   the same plan and mode reuses it, anything else gets an explicit 409.
 * - The database serializes this across server instances: migration 20261120c adds a partial unique index
 *   (one status='created' sub_ order per user). A request that loses that race gets 23505, cancels the
 *   subscription it just created at Razorpay and only returns the existing mandate when plan, mode and
 *   provider all match.
 */

export type KeyMode = "test" | "live";

export interface PendingMandateOrder {
  id: string;
  provider?: string | null;
  provider_order_id: string;
  plan_code: string | null;
  mode: string | null;
  created_at?: string | null;
  metadata?: Record<string, any> | null;
}

export type MandateDecision =
  | { kind: "create" }
  | { kind: "reuse"; order: PendingMandateOrder }
  | { kind: "conflict"; status: number; code: string; error: string };

export interface GatewayOptions {
  keyId: string;
  keySecret: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export const MANDATE_AUTH_WINDOW_SECONDS = 30 * 60;
// Mandates created before expire_by was set (#670) keep the original 15-minute reuse rule
const LEGACY_PENDING_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const PENDING_COLUMNS = "id, provider, provider_order_id, plan_code, mode, created_at, metadata";

export const mandateExpireBy = (nowMs = Date.now()) => Math.floor(nowMs / 1000) + MANDATE_AUTH_WINDOW_SECONDS;

const isSubOrder = (o: any): o is PendingMandateOrder =>
  typeof o?.provider_order_id === "string" && o.provider_order_id.startsWith("sub_");
// Rows written before the mode column existed count as test, matching the original reuse rule
const sameMode = (rowMode: string | null | undefined, mode: KeyMode) => (mode === "live" ? rowMode === "live" : rowMode !== "live");
const matchesRequest = (o: PendingMandateOrder, planCode: string, mode: KeyMode) =>
  o.plan_code === planCode && sameMode(o.mode, mode) && (o.provider ?? "razorpay") === "razorpay";

/** True while the customer could still authorise this mandate. Unknown age counts as authorisable (fail safe). */
export function isStillAuthorisable(order: PendingMandateOrder, nowMs = Date.now()): boolean {
  const expireBy = Number(order.metadata?.expire_by);
  if (Number.isFinite(expireBy) && expireBy > 0) return nowMs < expireBy * 1000 + CLOCK_SKEW_MS;
  const createdMs = Date.parse(order.created_at ?? "");
  return !Number.isFinite(createdMs) || nowMs - createdMs < LEGACY_PENDING_MS;
}

/** Cancels a Razorpay subscription immediately. Returns true only when Razorpay confirms. */
export async function cancelRazorpayMandate(subscriptionId: string, gw: GatewayOptions): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), gw.timeoutMs ?? 8000);
  try {
    const res = await (gw.fetchFn || fetch)(
      `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${gw.keyId}:${gw.keySecret}`).toString("base64")}`,
        },
        body: JSON.stringify({ cancel_at_cycle_end: 0 }),
        signal: controller.signal,
      }
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const planLabel = (code: string | null) => (code ? code : "another");

export async function resolvePendingMandates(opts: {
  supabaseAdmin: any;
  userId: string;
  planCode: string;
  mode: KeyMode;
  gateway: GatewayOptions;
}): Promise<MandateDecision> {
  const { supabaseAdmin, userId, planCode, mode, gateway } = opts;
  const { data: newest, error } = await supabaseAdmin
    .from("payment_orders")
    .select(PENDING_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "created")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { kind: "conflict", status: 500, code: "DATABASE_ERROR", error: "Failed to check pending subscriptions. Please try again." };
  }
  if (!isSubOrder(newest)) return { kind: "create" };

  if (!isStillAuthorisable(newest)) {
    // Past its authorisation window. Legacy rows have no expire_by at Razorpay, so cancel them there too (best effort).
    if (!newest.metadata?.expire_by) await cancelRazorpayMandate(newest.provider_order_id, gateway);
    const { error: expireErr } = await supabaseAdmin
      .from("payment_orders")
      .update({ status: "expired", metadata: { ...(newest.metadata || {}), expired_at: new Date().toISOString() } })
      .eq("id", newest.id)
      .eq("status", "created");
    if (expireErr) {
      return { kind: "conflict", status: 500, code: "DATABASE_ERROR", error: "Failed to update your previous checkout. Please try again." };
    }
    return { kind: "create" };
  }

  if (matchesRequest(newest, planCode, mode)) return { kind: "reuse", order: newest };

  return {
    kind: "conflict",
    status: 409,
    code: "PENDING_SUBSCRIPTION_OTHER_PLAN",
    error: `You have a pending checkout for the ${planLabel(newest.plan_code)} plan. Complete it, or try another plan after ${Math.round(
      MANDATE_AUTH_WINDOW_SECONDS / 60
    )} minutes.`,
  };
}

/** After a 23505 on insert (another request reserved the user's pending slot first). */
export async function recoverFromPendingConflict(opts: {
  supabaseAdmin: any;
  userId: string;
  planCode: string;
  mode: KeyMode;
  orphanSubscriptionId: string;
  gateway: GatewayOptions;
}): Promise<MandateDecision> {
  const { supabaseAdmin, userId, planCode, mode, orphanSubscriptionId, gateway } = opts;
  // The subscription this request created is never shown to the user; cancel it so it cannot be authorised
  await cancelRazorpayMandate(orphanSubscriptionId, gateway);

  const { data: samePlan } = await supabaseAdmin
    .from("payment_orders")
    .select(PENDING_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "created")
    .eq("plan_code", planCode)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (isSubOrder(samePlan) && samePlan.provider_order_id !== orphanSubscriptionId && matchesRequest(samePlan, planCode, mode)) {
    return { kind: "reuse", order: samePlan };
  }

  return {
    kind: "conflict",
    status: 409,
    code: "PENDING_SUBSCRIPTION_EXISTS",
    error: "Another subscription checkout is already in progress. Please complete it or try again later.",
  };
}
