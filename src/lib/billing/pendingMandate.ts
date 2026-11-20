/**
 * One pending recurring checkout (Razorpay "created" sub_ mandate) per user, across all auto-renew plans.
 *
 * - Every new mandate is created with expire_by = now + MANDATE_AUTH_WINDOW_SECONDS. While inside that window it is
 *   the user's one pending checkout: the same plan and mode reuses it, anything else gets an explicit 409.
 * - After the window (or after 15 minutes for #670 rows without expire_by) the slot is only freed once Razorpay
 *   confirms the mandate cannot charge (cancelled / expired / completed, or our cancel is confirmed). A mandate that
 *   was paid is reconciled through fulfil_subscription_renewal (access granted), never refunded. Any provider or
 *   database uncertainty keeps the slot and refuses the new checkout.
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
// Razorpay subscription states in which the mandate can never charge again
const NON_CHARGEABLE_STATES = new Set(["cancelled", "expired", "completed"]);
// Authorised states: the mandate can charge, so it keeps the user's slot
const AUTHORISED_STATES = new Set(["authenticated", "active", "pending", "halted", "paused"]);

export const mandateExpireBy = (nowMs = Date.now()) => Math.floor(nowMs / 1000) + MANDATE_AUTH_WINDOW_SECONDS;

const isSubOrder = (o: any): o is PendingMandateOrder =>
  typeof o?.provider_order_id === "string" && o.provider_order_id.startsWith("sub_");
// Rows written before the mode column existed count as test, matching the original reuse rule
const sameMode = (rowMode: string | null | undefined, mode: KeyMode) => (mode === "live" ? rowMode === "live" : rowMode !== "live");
const matchesRequest = (o: PendingMandateOrder, planCode: string, mode: KeyMode) =>
  o.plan_code === planCode && sameMode(o.mode, mode) && (o.provider ?? "razorpay") === "razorpay";
const conflict = (status: number, code: string, error: string): MandateDecision => ({ kind: "conflict", status, code, error });

/** True while the customer could still authorise this mandate by our own clock. Unknown age counts as authorisable. */
export function isStillAuthorisable(order: PendingMandateOrder, nowMs = Date.now()): boolean {
  const expireBy = Number(order.metadata?.expire_by);
  if (Number.isFinite(expireBy) && expireBy > 0) return nowMs < expireBy * 1000 + CLOCK_SKEW_MS;
  const createdMs = Date.parse(order.created_at ?? "");
  return !Number.isFinite(createdMs) || nowMs - createdMs < LEGACY_PENDING_MS;
}

async function razorpay(path: string, gw: GatewayOptions, init?: { method: "POST"; body: unknown }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), gw.timeoutMs ?? 8000);
  try {
    const res = await (gw.fetchFn || fetch)(`https://api.razorpay.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${gw.keyId}:${gw.keySecret}`).toString("base64")}`,
      },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as any };
  } catch {
    return { ok: false, data: {} as any };
  } finally {
    clearTimeout(timer);
  }
}

/** Cancels a Razorpay subscription immediately. Returns true only when Razorpay confirms. */
export async function cancelRazorpayMandate(subscriptionId: string, gw: GatewayOptions): Promise<boolean> {
  const res = await razorpay(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, gw, {
    method: "POST",
    body: { cancel_at_cycle_end: 0 },
  });
  return res.ok;
}

/**
 * True only when Razorpay confirms the mandate can no longer charge: our cancel succeeded, or (e.g. on a retry
 * after an earlier cancel) Razorpay reports a terminal state.
 */
export async function ensureMandateNotChargeable(subscriptionId: string, gw: GatewayOptions): Promise<boolean> {
  if (await cancelRazorpayMandate(subscriptionId, gw)) return true;
  const state = await razorpay(`/subscriptions/${encodeURIComponent(subscriptionId)}`, gw);
  return state.ok && NON_CHARGEABLE_STATES.has(String(state.data?.status ?? ""));
}

/**
 * A mandate Razorpay already charged gets its paid invoices fulfilled (idempotent on payment id), so the user is
 * granted access instead of being refunded. Returns false if anything could not be confirmed.
 */
async function reconcilePaidMandate(supabaseAdmin: any, subscriptionId: string, mode: KeyMode, gw: GatewayOptions) {
  const invoices = await razorpay(`/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`, gw);
  const paid = (Array.isArray(invoices.data?.items) ? invoices.data.items : []).filter(
    (i: any) => i?.status === "paid" && typeof i?.payment_id === "string" && i.payment_id
  );
  if (!invoices.ok || paid.length === 0) return { ok: false, granted: false };

  let granted = false;
  for (const invoice of paid) {
    const { data, error } = await supabaseAdmin.rpc("fulfil_subscription_renewal", {
      p_razorpay_subscription_id: subscriptionId,
      p_payment_id: invoice.payment_id,
      p_expected_mode: mode,
      p_amount_paise: invoice.amount_paid ?? invoice.amount ?? null,
      p_event_timestamp: invoice.paid_at ?? null,
    });
    if (error || !data?.success) return { ok: false, granted };
    if (!data.ignored) granted = true;
  }
  return { ok: true, granted };
}

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
  if (error) return conflict(500, "DATABASE_ERROR", "Failed to check pending subscriptions. Please try again.");
  if (!isSubOrder(newest)) return { kind: "create" };

  if (isStillAuthorisable(newest)) {
    if (matchesRequest(newest, planCode, mode)) return { kind: "reuse", order: newest };
    return conflict(
      409,
      "PENDING_SUBSCRIPTION_OTHER_PLAN",
      `You have a pending checkout for the ${newest.plan_code || "another"} plan. Complete it, or try another plan after ${Math.round(
        MANDATE_AUTH_WINDOW_SECONDS / 60
      )} minutes.`
    );
  }

  // Past its window by our clock: the slot is only freed once Razorpay confirms the mandate cannot charge
  const unverified = () =>
    conflict(503, "PENDING_MANDATE_UNVERIFIED", "We could not confirm the state of your previous checkout. Please try again shortly.");
  const state = await razorpay(`/subscriptions/${encodeURIComponent(newest.provider_order_id)}`, gateway);
  if (!state.ok) return unverified();
  const providerStatus = String(state.data?.status ?? "");

  if (Number(state.data?.paid_count) > 0) {
    const reconciled = await reconcilePaidMandate(supabaseAdmin, newest.provider_order_id, mode, gateway);
    if (!reconciled.ok) return unverified();
    return conflict(409, "PENDING_MANDATE_RECONCILED", "Your previous checkout was paid and is now active. Refresh to see your plan.");
  }
  if (AUTHORISED_STATES.has(providerStatus)) {
    return conflict(409, "SUBSCRIPTION_ALREADY_AUTHORIZED", "Your previous checkout was authorized. Refresh to see your plan before starting another.");
  }
  if (providerStatus === "created") {
    if (!(await ensureMandateNotChargeable(newest.provider_order_id, gateway))) return unverified();
  } else if (!NON_CHARGEABLE_STATES.has(providerStatus)) {
    return unverified();
  }

  // Free the slot only if the row is still pending; a concurrent paid transition must not be followed by a replacement
  const { data: expiredRows, error: expireErr } = await supabaseAdmin
    .from("payment_orders")
    .update({
      status: "expired",
      metadata: { ...(newest.metadata || {}), expired_at: new Date().toISOString(), razorpay_status_at_expiry: providerStatus },
    })
    .eq("id", newest.id)
    .eq("status", "created")
    .select("id");
  if (expireErr) return conflict(500, "DATABASE_ERROR", "Failed to update your previous checkout. Please try again.");
  if (!Array.isArray(expiredRows) || expiredRows.length !== 1) {
    return conflict(409, "PENDING_MANDATE_STATE_CHANGED", "Your previous checkout just changed state. Refresh and try again.");
  }
  return { kind: "create" };
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

  return conflict(409, "PENDING_SUBSCRIPTION_EXISTS", "Another subscription checkout is already in progress. Please complete it or try again later.");
}
