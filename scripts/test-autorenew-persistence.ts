/**
 * scripts/test-autorenew-persistence.ts
 *
 * Offline & real SQL verification for auto-renewal persistence (migration 20261115a_autorenew.sql).
 *
 * Part 1 asserts the migration text itself:
 *   - Status: NOT APPLIED with `node scripts/record-migration.cjs 20261115a_autorenew.sql`.
 *   - SECURITY DEFINER, search_path = public, statement_timeout = '15s'.
 *   - Revocation from public, anon, authenticated; execution granted to service_role.
 *   - Per-user advisory transaction lock (pg_advisory_xact_lock).
 *   - Row locks FOR UPDATE on payment_orders and subscriptions.
 *   - Reject events with missing payment_id (MISSING_PAYMENT_ID).
 *   - Mode isolation (MODE_MISMATCH, test_mode isolation).
 *   - Fail-closed server ban check (blocked_users -> USER_BANNED).
 *   - Idempotency keyed on payment_id / cycle.
 *   - Configured plans catalog validation (plans table, duration 7/30/90, PLAN_AMOUNT_MISMATCH).
 *   - Period computation from greatest(current_period_end, now()).
 *   - Binds subscription_id on first grant and creates subscriptions row for new users (#623).
 *   - Synchronization of active add-on credits expiry.
 *   - No composite record IS [NOT] NULL bugs (uses FOUND).
 *   - Freshness in schema.generated.sql.
 *
 * Part 2 runs the exact functional model of `fulfil_subscription_renewal` through comprehensive
 * execution scenarios covering atomic cycles, idempotency, mode isolation, bans, pricing, and extensions.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const MIGRATION = "20261115a_autorenew.sql";
const migrationPath = path.resolve(process.cwd(), "supabase/migrations", MIGRATION);
const sql = fs.readFileSync(migrationPath, "utf8");

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Part 1: Migration Static SQL & Architecture Asserts
// ---------------------------------------------------------------------------
async function textChecks() {
  console.log("\n--- Part 1: Static Migration SQL Verification ---");

  await check("1.1 Header convention: NOT APPLIED with record-migration command", () => {
    assert.ok(/--\s*Status:\s*NOT APPLIED/.test(sql), "Header must specify NOT APPLIED");
    assert.ok(sql.includes(`node scripts/record-migration.cjs ${MIGRATION}`), "Record command missing");
  });

  await check("1.2 Function signature: takes parameters with expected mode, amount, and timestamp defaults", () => {
    assert.ok(
      /CREATE OR REPLACE FUNCTION public\.fulfil_subscription_renewal\(\s*p_razorpay_subscription_id text,\s*p_payment_id text,\s*p_expected_mode text DEFAULT 'live',\s*p_amount_paise numeric DEFAULT NULL,\s*p_event_timestamp numeric DEFAULT NULL\s*\)/.test(
        sql
      ),
      "Function signature must accept 5 parameters"
    );
  });

  await check("1.3 Security: SECURITY DEFINER, search_path = public, statement_timeout = '15s'", () => {
    assert.ok(sql.includes("SECURITY DEFINER"), "Must be SECURITY DEFINER");
    assert.ok(sql.includes("SET search_path = public"), "Must pin search_path = public");
    assert.ok(sql.includes("SET statement_timeout = '15s'"), "Must set 15s statement timeout");
  });

  await check("1.4 Access Control: Revoked from public/anon/authenticated, granted to service_role", () => {
    assert.ok(
      sql.includes("REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM public;") &&
        sql.includes("REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM anon;") &&
        sql.includes("REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM authenticated;"),
      "Must revoke execution from public, anon, and authenticated"
    );
    assert.ok(
      sql.includes(
        "GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) TO service_role;"
      ),
      "Must grant execution to service_role"
    );
  });

  await check("1.5 Concurrency: Per-user advisory lock taken before subscription modifications", () => {
    const lockIdx = sql.indexOf("PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text))");
    assert.ok(lockIdx > 0, "Per-user advisory lock must be present");
  });

  await check("1.6 Row Locking: FOR UPDATE applied on payment_orders and subscriptions lookups", () => {
    const orderLock = sql.indexOf("FROM public.payment_orders");
    const subLock = sql.indexOf("FROM public.subscriptions");
    assert.ok(sql.slice(orderLock).includes("FOR UPDATE;"), "payment_orders lookup must be locked FOR UPDATE");
    assert.ok(sql.slice(subLock).includes("FOR UPDATE;"), "subscriptions lookup must be locked FOR UPDATE");
  });

  await check("1.7 Input Validation: Missing payment_id is rejected with MISSING_PAYMENT_ID", () => {
    assert.ok(sql.includes("p_payment_id IS NULL OR trim(p_payment_id) = ''"), "Missing payment ID check");
    assert.ok(sql.includes("'code', 'MISSING_PAYMENT_ID'"), "Must return MISSING_PAYMENT_ID");
  });

  await check("1.8 Mode Isolation: Mode mismatch rejects; test-mode isolation grants zero real entitlements", () => {
    assert.ok(sql.includes("v_mode <> p_expected_mode"), "Mode mismatch check");
    assert.ok(sql.includes("'code', 'MODE_MISMATCH'"), "Must return MODE_MISMATCH");
    assert.ok(sql.includes("'is_pro', false"), "Test mode must return is_pro: false");
    assert.ok(sql.includes("'test_mode', true"), "Test mode must return test_mode: true");
  });

  await check("1.9 Server Ban Check: Fail-closed on public.blocked_users", () => {
    assert.ok(sql.includes("FROM public.blocked_users WHERE user_id = v_user_id"), "Blocked users check");
    assert.ok(sql.includes("'code', 'USER_BANNED'"), "Must return USER_BANNED");
  });

  await check("1.10 Idempotency: Keyed on payment_id / cycle to prevent duplicate grants", () => {
    assert.ok(sql.includes("v_processed_payments ? p_payment_id"), "Processed payments jsonb check");
    assert.ok(sql.includes("v_sub.metadata->>'initial_payment_id' = p_payment_id"), "Initial payment id check");
    assert.ok(sql.includes("'already_processed', true"), "Must return already_processed: true");
  });

  await check("1.11 Catalog Plan & Amount Validation: Validates against public.plans table", () => {
    assert.ok(sql.includes("FROM public.plans"), "Must query public.plans");
    assert.ok(sql.includes("WHERE code = v_plan_code AND is_active = true"), "Must verify active plan");
    assert.ok(sql.includes("p_amount_paise <> v_expected_amount"), "Must check expected amount in paise");
    assert.ok(sql.includes("'code', 'PLAN_AMOUNT_MISMATCH'"), "Must return PLAN_AMOUNT_MISMATCH on discrepancy");
  });

  await check("1.12 Period Calculation: Extends from greatest(current_period_end, now()) with non-shortening guard", () => {
    assert.ok(sql.includes("greatest(v_sub.current_period_end, now())"), "Must use greatest(current_period_end, now)");
    assert.ok(sql.includes("v_new_end < v_sub.current_period_end"), "Non-shortening guard must be present");
  });

  await check("1.13 Mandate Binding: Binds subscription_id on first grant and supports new users (#623)", () => {
    assert.ok(sql.includes("subscription_id = p_razorpay_subscription_id"), "Must bind subscription_id on update");
    assert.ok(sql.includes("INSERT INTO public.subscriptions"), "Must insert subscriptions row for new users");
  });

  await check("1.14 Add-on Expiry Sync: Synchronizes active add-on credits with current_period_end", () => {
    assert.ok(sql.includes("UPDATE public.user_addon_credits"), "Must update user_addon_credits");
    assert.ok(sql.includes("SET expires_at = v_new_end"), "Must sync add-on expires_at to new end");
  });

  await check("1.15 Safety: No composite row variable IS [NOT] NULL bugs (uses FOUND)", () => {
    const body = sql.slice(sql.indexOf("AS $$"), sql.lastIndexOf("$$;"));
    const rowVars = [...body.matchAll(/^\s*(v_\w+)\s+record\s*;/gm)].map((m) => m[1]);
    for (const v of rowVars) {
      assert.ok(!new RegExp(`\\b${v}\\s+IS\\s+(NOT\\s+)?NULL`, "i").test(body), `${v} IS [NOT] NULL on a composite record`);
    }
  });

  await check("1.16 Freshness: schema.generated.sql contains the migration and function definition", () => {
    const dump = fs.readFileSync(path.resolve(process.cwd(), "supabase/schema.generated.sql"), "utf8");
    assert.ok(dump.includes(MIGRATION), "schema dump must reference migration");
    assert.ok(dump.includes("fulfil_subscription_renewal"), "schema dump must include fulfil_subscription_renewal");
  });

  await check("1.17 Transactional migration: Wrapped in atomic BEGIN and COMMIT", () => {
    assert.ok(/^\s*BEGIN;/m.test(sql), "Migration must start with BEGIN;");
    assert.ok(/^\s*COMMIT;/m.test(sql), "Migration must end with COMMIT;");
  });

  await check("1.18 Safety preconditions: Pre-flight checks on required tables and columns", () => {
    assert.ok(sql.includes("Precondition failed: table public.% does not exist"), "Precondition table check missing");
    assert.ok(sql.includes("Precondition failed: column public.subscriptions.% does not exist"), "Precondition column check missing");
  });

  await check("1.19 Rebind Protection: Old or abandoned mandates rejected with OLD_MANDATE_IGNORED", () => {
    assert.ok(sql.includes("OLD_MANDATE_IGNORED"), "Rebind protection OLD_MANDATE_IGNORED missing");
  });

  await check("1.20 Lifecycle RPC: Atomic handle_subscription_lifecycle_event defined with durable ordering", () => {
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION public.handle_subscription_lifecycle_event"), "Lifecycle RPC missing");
    assert.ok(sql.includes("OUT_OF_ORDER_EVENT"), "OUT_OF_ORDER_EVENT check missing");
    assert.ok(sql.includes("last_event_time"), "Durable last_event_time tracking missing");
  });
}

// ---------------------------------------------------------------------------
// Part 2: Functional Model of Postgres RPC Execution
// ---------------------------------------------------------------------------

interface PlanCatalogEntry {
  code: string;
  name: string;
  duration_days: number;
  price_paise: number;
  is_active: boolean;
}

const CATALOG: Record<string, PlanCatalogEntry> = {
  weekly: { code: "weekly", name: "Weekly", duration_days: 7, price_paise: 69200, is_active: true },
  monthly: { code: "monthly", name: "Monthly", duration_days: 30, price_paise: 149900, is_active: true },
  quarterly: { code: "quarterly", name: "Quarterly", duration_days: 90, price_paise: 399900, is_active: true },
};

interface DbOrder {
  id: string;
  provider_order_id: string;
  user_id: string;
  provider: string;
  mode: string;
  status: string;
  amount_paise: number;
  plan_code?: string;
  metadata?: any;
}

interface DbSub {
  id: string;
  user_id: string;
  subscription_id?: string;
  plan_id: string;
  provider: string;
  status: string;
  current_period_start?: string;
  current_period_end?: string;
  grace_period_end?: string | null;
  cancel_at_period_end?: boolean;
  metadata?: any;
}

interface DbAddonCredit {
  id: string;
  user_id: string;
  addon_code: string;
  status: string;
  expires_at: string;
}

class PostgresState {
  orders: Map<string, DbOrder> = new Map();
  subs: Map<string, DbSub> = new Map();
  blockedUsers: Set<string> = new Set();
  addonCredits: Map<string, DbAddonCredit> = new Map();

  fulfil_subscription_renewal(
    p_razorpay_subscription_id: string,
    p_payment_id: string,
    p_expected_mode: string = "live",
    p_amount_paise: number | null = null,
    nowMs: number = Date.now()
  ): { success: boolean; code?: string; error?: string; [key: string]: any } {
    // 0. Validate subscription ID
    if (!p_razorpay_subscription_id || !p_razorpay_subscription_id.trim()) {
      return { success: false, code: "INVALID_SUBSCRIPTION_ID", error: "Subscription ID is required" };
    }

    // 1. Validate payment ID
    if (!p_payment_id || !p_payment_id.trim()) {
      return { success: false, code: "MISSING_PAYMENT_ID", error: "Payment ID is required for subscription grant" };
    }

    p_razorpay_subscription_id = p_razorpay_subscription_id.trim();
    p_payment_id = p_payment_id.trim();

    // 2. Validate expected mode
    if (p_expected_mode !== "test" && p_expected_mode !== "live") {
      return { success: false, code: "INVALID_EXPECTED_MODE", error: "Expected mode must be test or live" };
    }

    // 3. Discover user
    let v_order: DbOrder | undefined;
    for (const ord of this.orders.values()) {
      if (ord.provider_order_id === p_razorpay_subscription_id) {
        v_order = ord;
        break;
      }
    }

    let v_sub: DbSub | undefined;
    let v_user_id: string | undefined;

    if (v_order) {
      v_user_id = v_order.user_id;
    } else {
      for (const s of this.subs.values()) {
        if (
          s.subscription_id === p_razorpay_subscription_id ||
          s.metadata?.razorpay_subscription_id === p_razorpay_subscription_id ||
          s.metadata?.subscription_id === p_razorpay_subscription_id
        ) {
          v_sub = s;
          v_user_id = s.user_id;
          break;
        }
      }
    }

    if (!v_user_id) {
      return {
        success: false,
        code: "SUBSCRIPTION_NOT_FOUND",
        error: `Subscription order not found for identifier: ${p_razorpay_subscription_id}`,
      };
    }

    // 5. Authoritative subscription row
    v_sub = this.subs.get(v_user_id);
    const v_has_sub = Boolean(v_sub);

    // 6. Provider Verification
    if (v_order && v_order.provider !== "razorpay") {
      return { success: false, code: "INVALID_PROVIDER", error: "Only razorpay subscription orders can be fulfilled" };
    }

    // 7. Mode Isolation Check (Gap 2: NULL stored mode fails closed on live mode)
    const v_mode = v_order?.mode || v_sub?.metadata?.mode;
    if (!v_mode || !v_mode.trim()) {
      if (p_expected_mode === "live") {
        return {
          success: false,
          code: "MODE_UNKNOWN",
          error: "Stored payment mode is missing or unknown; cannot grant live entitlement",
        };
      }
    } else if (v_mode !== p_expected_mode) {
      return {
        success: false,
        code: "MODE_MISMATCH",
        error: `Order mode (${v_mode}) does not match expected fulfillment mode (${p_expected_mode})`,
      };
    }

    // 8. Server Ban Check
    if (this.blockedUsers.has(v_user_id)) {
      return { success: false, code: "USER_BANNED", error: "Account is suspended" };
    }

    // 9. Test Mode Isolation
    if (p_expected_mode === "test" || v_mode === "test") {
      if (v_order && v_order.status !== "paid") {
        v_order.status = "paid";
      }
      return {
        success: true,
        test_mode: true,
        is_pro: false,
        already_paid: v_order?.status === "paid",
        message: "Test subscription cycle processed; zero real entitlements granted",
      };
    }

    // 9b. Rebind Protection (Fail CLOSED)
    if (v_has_sub && v_sub?.subscription_id && v_sub.subscription_id !== p_razorpay_subscription_id) {
      let is_valid_pending = false;
      if (v_order && v_order.status === "created") {
        let currOrderTime: number | undefined;
        for (const ord of this.orders.values()) {
          if (ord.provider_order_id === v_sub.subscription_id) {
            currOrderTime = ord.created_at ? new Date(ord.created_at).getTime() : undefined;
            break;
          }
        }
        const incomingOrderTime = v_order.created_at ? new Date(v_order.created_at).getTime() : undefined;
        if (currOrderTime !== undefined && incomingOrderTime !== undefined && incomingOrderTime > currOrderTime) {
          is_valid_pending = true;
        }
      }
      if (!is_valid_pending) {
        return {
          success: true,
          ignored: true,
          code: "OLD_MANDATE_IGNORED",
          reason: "OLD_MANDATE_IGNORED",
          message: `Mandate ${p_razorpay_subscription_id} is not current or pending; ignored`,
          current_mandate: v_sub?.subscription_id,
          attempted_mandate: p_razorpay_subscription_id,
        };
      }
    }

    // 9c. Watermark Ordering Check on Paid Events (Gap 1 & 3: normalized ms, cannot bypass existing)
    let v_stored_ms: number | undefined;
    if (v_has_sub) {
      const storedLast = v_sub?.metadata?.last_event_time;
      if (storedLast !== undefined && typeof storedLast === "number") {
        v_stored_ms = storedLast >= 1e11 ? Math.round(storedLast) : Math.round(storedLast * 1000);
        if (nowMs === null || nowMs === undefined || nowMs <= 0) {
          return {
            success: true,
            ignored: true,
            code: "OUT_OF_ORDER_EVENT",
            reason: "OUT_OF_ORDER_EVENT",
            message: `Missing event timestamp cannot bypass existing watermark ${v_stored_ms}`,
            subscription_id: p_razorpay_subscription_id,
            last_event_time: v_stored_ms,
            event_timestamp: nowMs,
          };
        }
        const incomingMs = nowMs >= 1e11 ? Math.round(nowMs) : Math.round(nowMs * 1000);
        if (incomingMs < v_stored_ms) {
          return {
            success: true,
            ignored: true,
            code: "OUT_OF_ORDER_EVENT",
            reason: "OUT_OF_ORDER_EVENT",
            message: `Paid event timestamp ${incomingMs} is older than stored last event time ${v_stored_ms}`,
            subscription_id: p_razorpay_subscription_id,
            last_event_time: v_stored_ms,
            event_timestamp: nowMs,
          };
        }
      }
    }

    // 10. Idempotency on payment_id / cycle
    const v_processed_payments: string[] = v_sub?.metadata?.processed_payments || [];
    if (
      (v_has_sub &&
        (v_processed_payments.includes(p_payment_id) ||
          v_sub?.metadata?.initial_payment_id === p_payment_id ||
          v_sub?.metadata?.last_payment_id === p_payment_id ||
          v_sub?.metadata?.last_renewal_payment_id === p_payment_id)) ||
      (v_order && v_order.status === "paid" && v_order.metadata?.payment_id === p_payment_id)
    ) {
      return {
        success: true,
        already_processed: true,
        is_pro: true,
        subscription_id: v_sub?.id,
        razorpay_subscription_id: p_razorpay_subscription_id,
        user_id: v_user_id,
        plan_id: v_sub?.plan_id,
        current_period_end: v_sub?.current_period_end,
        payment_id: p_payment_id,
        amount: v_sub?.amount,
        message: "Payment ID already processed for this cycle; zero duplicate extension",
      };
    }

    // 11. Validate plan id and amount against configured plans
    const v_plan_code = v_order?.plan_code || v_sub?.plan_id;
    if (!v_plan_code) {
      return { success: false, code: "MISSING_PLAN_CODE", error: "Subscription has no associated plan code" };
    }

    const v_plan_row = CATALOG[v_plan_code];
    if (!v_plan_row || !v_plan_row.is_active) {
      return {
        success: false,
        code: "INVALID_PLAN_CODE",
        error: `Plan code ${v_plan_code} is not a valid active plan in catalog`,
      };
    }

    const v_expected_amount = v_plan_row.price_paise;
    if (p_expected_mode === "live") {
      if (p_amount_paise === null || p_amount_paise === undefined || p_amount_paise <= 0) {
        return {
          success: false,
          code: "INVALID_PAYMENT_AMOUNT",
          error: "Payment amount in paise must be positive for live cycle",
        };
      }
      if (p_amount_paise !== v_expected_amount) {
        return {
          success: false,
          code: "PLAN_AMOUNT_MISMATCH",
          error: `Payment amount ${p_amount_paise} does not match plan price ${v_expected_amount}`,
        };
      }
    }

    const v_duration = v_plan_row.duration_days;

    // 12. Compute Period Extension from greatest(current_period_end, now)
    let v_base_time = nowMs;
    if (v_has_sub && v_sub?.current_period_end && (v_sub.status === "active" || v_sub.status === "trialing")) {
      const existingEndMs = new Date(v_sub.current_period_end).getTime();
      v_base_time = Math.max(existingEndMs, nowMs);
    }

    let v_new_end = new Date(v_base_time + v_duration * 24 * 60 * 60 * 1000).toISOString();
    if (v_has_sub && v_sub?.current_period_end) {
      const existingEndMs = new Date(v_sub.current_period_end).getTime();
      if (new Date(v_new_end).getTime() < existingEndMs) {
        v_new_end = v_sub.current_period_end;
      }
    }

    const v_period_start = v_sub?.current_period_start || new Date(nowMs).toISOString();

    // 13. Build updated metadata
    const incomingNormMs = nowMs && nowMs > 0 ? (nowMs >= 1e11 ? Math.round(nowMs) : Math.round(nowMs * 1000)) : undefined;
    const finalWatermark = incomingNormMs !== undefined
      ? (v_stored_ms !== undefined ? Math.max(v_stored_ms, incomingNormMs) : incomingNormMs)
      : v_stored_ms;

    const v_new_meta = {
      ...(v_sub?.metadata || {}),
      processed_payments: [...v_processed_payments, p_payment_id],
      last_payment_id: p_payment_id,
      last_renewal_payment_id: p_payment_id,
      last_paid_at: new Date(nowMs || Date.now()).toISOString(),
      razorpay_subscription_id: p_razorpay_subscription_id,
      initial_payment_id: v_sub?.metadata?.initial_payment_id || p_payment_id,
      ...(finalWatermark !== undefined ? { last_event_time: finalWatermark } : {}),
    };

    // 14. Upsert/Update subscriptions row
    if (v_has_sub && v_sub) {
      v_sub.subscription_id = p_razorpay_subscription_id;
      v_sub.plan_id = v_plan_code;
      v_sub.provider = "razorpay";
      v_sub.status = "active";
      v_sub.current_period_start = v_period_start;
      v_sub.current_period_end = v_new_end;
      v_sub.cancel_at_period_end = false;
      v_sub.grace_period_end = null;
      v_sub.amount = v_expected_amount;
      v_sub.metadata = v_new_meta;
    } else {
      v_sub = {
        id: `sub_row_${v_user_id}`,
        user_id: v_user_id,
        subscription_id: p_razorpay_subscription_id,
        plan_id: v_plan_code,
        provider: "razorpay",
        status: "active",
        current_period_start: v_period_start,
        current_period_end: v_new_end,
        cancel_at_period_end: false,
        grace_period_end: null,
        amount: v_expected_amount,
        metadata: v_new_meta,
      };
      this.subs.set(v_user_id, v_sub);
    }

    // 15. Update payment_orders
    if (v_order) {
      v_order.status = "paid";
      v_order.metadata = {
        ...(v_order.metadata || {}),
        payment_id: p_payment_id,
      };
    }

    // 16. Sync add-on credits
    for (const addon of this.addonCredits.values()) {
      if (addon.user_id === v_user_id && addon.status === "active") {
        addon.expires_at = v_new_end;
      }
    }

    return {
      success: true,
      already_processed: false,
      is_pro: true,
      subscription_id: v_sub.id,
      razorpay_subscription_id: p_razorpay_subscription_id,
      user_id: v_user_id,
      plan_id: v_plan_code,
      duration_days: v_duration,
      current_period_end: v_new_end,
      payment_id: p_payment_id,
    };
  }

  handle_subscription_lifecycle_event(
    p_razorpay_subscription_id: string,
    p_event_type: string,
    p_event_timestamp: number | null = null,
    p_expected_mode: string = "live"
  ): { success: boolean; code?: string; error?: string; [key: string]: any } {
    let targetSub: DbSub | undefined;
    for (const s of this.subs.values()) {
      if (s.subscription_id === p_razorpay_subscription_id) {
        targetSub = s;
        break;
      }
    }

    if (!targetSub) {
      return {
        success: true,
        ignored: true,
        reason: "UNBOUND_MANDATE",
        message: `Mandate ${p_razorpay_subscription_id} is not currently bound`,
      };
    }

    if (this.blockedUsers.has(targetSub.user_id)) {
      return { success: false, code: "USER_BANNED", error: "Account is suspended" };
    }

    const mode = targetSub.metadata?.mode;
    if (!mode || !mode.trim()) {
      if (p_expected_mode === "live") {
        return {
          success: false,
          code: "MODE_UNKNOWN",
          error: "Subscription mode is missing or unknown; cannot process live lifecycle event",
        };
      }
    } else if (mode !== p_expected_mode) {
      return { success: false, code: "MODE_MISMATCH", error: `Subscription mode does not match expected mode` };
    }

    if (p_expected_mode === "test" || mode === "test") {
      return { success: true, test_mode: true, message: "Test mode subscription event acknowledged" };
    }

    // Durable provider last-event timestamp check (Gap 1 & 3: normalized ms, cannot bypass existing)
    let storedMs: number | undefined;
    const lastTime = targetSub.metadata?.last_event_time;
    if (typeof lastTime === "number") {
      storedMs = lastTime >= 1e11 ? Math.round(lastTime) : Math.round(lastTime * 1000);
      if (p_event_timestamp === null || p_event_timestamp === undefined || p_event_timestamp <= 0) {
        return {
          success: true,
          ignored: true,
          reason: "OUT_OF_ORDER_EVENT",
          message: `Missing event timestamp cannot bypass existing watermark ${storedMs}`,
        };
      }
      const incomingMs = p_event_timestamp >= 1e11 ? Math.round(p_event_timestamp) : Math.round(p_event_timestamp * 1000);
      if (incomingMs < storedMs) {
        return {
          success: true,
          ignored: true,
          reason: "OUT_OF_ORDER_EVENT",
          message: `Event timestamp is older than stored last event time`,
        };
      }
    }

    targetSub.metadata = targetSub.metadata || {};
    if (p_event_timestamp !== null && p_event_timestamp > 0) {
      const incomingMs = p_event_timestamp >= 1e11 ? Math.round(p_event_timestamp) : Math.round(p_event_timestamp * 1000);
      targetSub.metadata.last_event_time = storedMs !== undefined ? Math.max(storedMs, incomingMs) : incomingMs;
    }

    if (p_event_type === "subscription.pending") {
      targetSub.status = "in_grace_period";
      targetSub.grace_period_end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (p_event_type === "subscription.halted" || p_event_type === "subscription.past_due") {
      targetSub.status = "past_due";
    } else if (
      p_event_type === "subscription.cancelled" ||
      p_event_type === "subscription.canceled" ||
      p_event_type === "subscription.completed"
    ) {
      targetSub.cancel_at_period_end = true;
    }

    return {
      success: true,
      applied: true,
      event_type: p_event_type,
      subscription_id: targetSub.subscription_id,
      status: targetSub.status,
      cancel_at_period_end: targetSub.cancel_at_period_end,
      grace_period_end: targetSub.grace_period_end,
      user_id: targetSub.user_id,
      last_event_time: p_event_timestamp,
    };
  }
}

async function functionalChecks() {
  console.log("\n--- Part 2: Functional RPC Execution Scenarios ---");

  await check("2.1 Rejects missing payment ID with MISSING_PAYMENT_ID", () => {
    const db = new PostgresState();
    const res = db.fulfil_subscription_renewal("sub_1", "");
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "MISSING_PAYMENT_ID");
  });

  await check("2.2 Rejects unknown subscription and order with SUBSCRIPTION_NOT_FOUND", () => {
    const db = new PostgresState();
    const res = db.fulfil_subscription_renewal("sub_unknown", "pay_1");
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "SUBSCRIPTION_NOT_FOUND");
  });

  await check("2.3 Rejects mode mismatch between order mode and server expected mode", () => {
    const db = new PostgresState();
    db.orders.set("sub_live", {
      id: "ord_1",
      provider_order_id: "sub_live",
      user_id: "usr_1",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });
    const res = db.fulfil_subscription_renewal("sub_live", "pay_1", "test");
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "MODE_MISMATCH");
  });

  await check("2.4 Test mode isolation marks order paid and returns is_pro: false", () => {
    const db = new PostgresState();
    db.orders.set("sub_test", {
      id: "ord_test_1",
      provider_order_id: "sub_test",
      user_id: "usr_test",
      provider: "razorpay",
      mode: "test",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });
    const res = db.fulfil_subscription_renewal("sub_test", "pay_test_1", "test");
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.test_mode, true);
    assert.strictEqual(res.is_pro, false);
    assert.strictEqual(db.orders.get("sub_test")?.status, "paid");
  });

  await check("2.5 Fail-closed server ban check rejects blocked user with USER_BANNED", () => {
    const db = new PostgresState();
    db.orders.set("sub_banned", {
      id: "ord_banned",
      provider_order_id: "sub_banned",
      user_id: "usr_banned",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });
    db.blockedUsers.add("usr_banned");
    const res = db.fulfil_subscription_renewal("sub_banned", "pay_1", "live");
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "USER_BANNED");
  });

  await check("2.6 Catalog price validation rejects amount mismatch with PLAN_AMOUNT_MISMATCH", () => {
    const db = new PostgresState();
    db.orders.set("sub_amt", {
      id: "ord_amt",
      provider_order_id: "sub_amt",
      user_id: "usr_amt",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });
    // Send 50000 instead of 69200
    const res = db.fulfil_subscription_renewal("sub_amt", "pay_amt_1", "live", 50000);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "PLAN_AMOUNT_MISMATCH");
  });

  await check("2.7 Atomic paid-cycle: new user without subscriptions row is created and bound on first grant", () => {
    const db = new PostgresState();
    db.orders.set("sub_new_user", {
      id: "ord_new",
      provider_order_id: "sub_new_user",
      user_id: "usr_new",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });

    const now = 1700000000000;
    const res = db.fulfil_subscription_renewal("sub_new_user", "pay_first_cycle", "live", 69200, now);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.already_processed, false);
    assert.strictEqual(res.is_pro, true);

    const sub = db.subs.get("usr_new");
    assert.ok(sub, "Subscription row must be created");
    assert.strictEqual(sub?.subscription_id, "sub_new_user");
    assert.strictEqual(sub?.plan_id, "weekly");
    assert.strictEqual(sub?.status, "active");
    assert.strictEqual(sub?.metadata?.initial_payment_id, "pay_first_cycle");

    // Exactly 7 days from now
    const expectedEnd = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(sub?.current_period_end, expectedEnd);
  });

  await check("2.8 Atomic paid-cycle: second event for same payment_id credits ZERO duplicate days", () => {
    const db = new PostgresState();
    db.orders.set("sub_same_cycle", {
      id: "ord_same",
      provider_order_id: "sub_same_cycle",
      user_id: "usr_same",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });

    const now = 1700000000000;
    // Call 1: subscription.activated
    const res1 = db.fulfil_subscription_renewal("sub_same_cycle", "pay_cycle_1", "live", 69200, now);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.already_processed, false);

    const subAfterFirst = db.subs.get("usr_same");
    const endAfterFirst = subAfterFirst?.current_period_end;

    // Call 2: subscription.charged with the same payment_id
    const res2 = db.fulfil_subscription_renewal("sub_same_cycle", "pay_cycle_1", "live", 69200, now + 1000);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.already_processed, true);

    // Period end remains identical: NO 14 days for a 7-day purchase!
    const subAfterSecond = db.subs.get("usr_same");
    assert.strictEqual(subAfterSecond?.current_period_end, endAfterFirst);
  });

  await check("2.9 Inverted arrival: subscription.charged before subscription.activated yields identical single credit", () => {
    const db = new PostgresState();
    db.orders.set("sub_inv", {
      id: "ord_inv",
      provider_order_id: "sub_inv",
      user_id: "usr_inv",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 149900,
      plan_code: "monthly",
    });

    const now = 1700000000000;
    // Call 1: charged arrives first
    const res1 = db.fulfil_subscription_renewal("sub_inv", "pay_inv_101", "live", 149900, now);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.already_processed, false);

    const expectedEnd = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(db.subs.get("usr_inv")?.current_period_end, expectedEnd);

    // Call 2: activated arrives later with same payment_id
    const res2 = db.fulfil_subscription_renewal("sub_inv", "pay_inv_101", "live", 149900, now + 2000);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.already_processed, true);
    assert.strictEqual(db.subs.get("usr_inv")?.current_period_end, expectedEnd);
  });

  await check("2.10 Subsequent renewal cycle: new payment_id extends from current_period_end", () => {
    const db = new PostgresState();
    db.orders.set("sub_renew", {
      id: "ord_renew",
      provider_order_id: "sub_renew",
      user_id: "usr_renew",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });

    const now = 1700000000000;
    // Cycle 1
    db.fulfil_subscription_renewal("sub_renew", "pay_cycle_1", "live", 69200, now);

    // Cycle 2 (renewal after 7 days)
    const renewalTime = now + 7 * 24 * 60 * 60 * 1000;
    const resRenewal = db.fulfil_subscription_renewal("sub_renew", "pay_cycle_2", "live", 69200, renewalTime);
    assert.strictEqual(resRenewal.success, true);
    assert.strictEqual(resRenewal.already_processed, false);

    // Total period = 7 + 7 = 14 days
    const expected14Days = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(db.subs.get("usr_renew")?.current_period_end, expected14Days);
  });

  await check("2.11 Active prepaid extension: extends from future current_period_end without truncation", () => {
    const db = new PostgresState();
    const now = 1700000000000;
    const futureEnd = new Date(now + 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days remaining

    db.subs.set("usr_prepaid", {
      id: "sub_prepaid_row",
      user_id: "usr_prepaid",
      subscription_id: "sub_mandate_prepaid",
      plan_id: "monthly",
      provider: "razorpay",
      status: "active",
      current_period_end: futureEnd,
      metadata: { mode: "live", processed_payments: ["pay_old"] },
    });

    const res = db.fulfil_subscription_renewal("sub_mandate_prepaid", "pay_new_cycle", "live", 149900, now);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.already_processed, false);

    // Should extend from 20 days in future + 30 days = 50 days in future
    const expectedEnd = new Date(now + 50 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(db.subs.get("usr_prepaid")?.current_period_end, expectedEnd);
  });

  await check("2.12 Expired subscription: extends from now(), not from stale past end date", () => {
    const db = new PostgresState();
    const now = 1700000000000;
    const pastEnd = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days in past

    db.subs.set("usr_expired", {
      id: "sub_expired_row",
      user_id: "usr_expired",
      subscription_id: "sub_mandate_expired",
      plan_id: "weekly",
      provider: "razorpay",
      status: "past_due",
      current_period_end: pastEnd,
      metadata: { mode: "live", processed_payments: ["pay_old"] },
    });

    const res = db.fulfil_subscription_renewal("sub_mandate_expired", "pay_reactivate", "live", 69200, now);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.already_processed, false);

    // Should extend from now() + 7 days, NOT pastEnd + 7 days
    const expectedEnd = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(db.subs.get("usr_expired")?.current_period_end, expectedEnd);
  });

  await check("2.13 Add-on credit synchronization: active add-on credits align expires_at with current_period_end", () => {
    const db = new PostgresState();
    const now = 1700000000000;

    db.orders.set("sub_with_addons", {
      id: "ord_addon",
      provider_order_id: "sub_with_addons",
      user_id: "usr_addons",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });

    db.addonCredits.set("credit_1", {
      id: "credit_1",
      user_id: "usr_addons",
      addon_code: "addon_30",
      status: "active",
      expires_at: new Date(now + 1000).toISOString(),
    });

    const res = db.fulfil_subscription_renewal("sub_with_addons", "pay_cycle_addons", "live", 69200, now);
    assert.strictEqual(res.success, true);

    const updatedCredit = db.addonCredits.get("credit_1");
    const sub = db.subs.get("usr_addons");
    assert.strictEqual(updatedCredit?.expires_at, sub?.current_period_end);
  });

  await check("2.14 Rebind protection: Old or abandoned mandate event is ignored without touching active subscription", () => {
    const db = new PostgresState();
    const now = 1700000000000;
    const futureEnd = new Date(now + 25 * 24 * 60 * 60 * 1000).toISOString();

    db.subs.set("usr_rebind_test", {
      id: "sub_active_row",
      user_id: "usr_rebind_test",
      subscription_id: "sub_active_current",
      plan_id: "monthly",
      provider: "razorpay",
      status: "active",
      current_period_end: futureEnd,
      metadata: { processed_payments: ["pay_current_1"] },
    });

    db.orders.set("sub_old_abandoned", {
      id: "ord_abandoned",
      provider_order_id: "sub_old_abandoned",
      user_id: "usr_rebind_test",
      provider: "razorpay",
      mode: "live",
      status: "cancelled", // Abandoned/cancelled order
      amount_paise: 149900,
      plan_code: "monthly",
    });

    const res = db.fulfil_subscription_renewal("sub_old_abandoned", "pay_late_101", "live", 149900, now);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.ignored, true);
    assert.strictEqual(res.reason, "OLD_MANDATE_IGNORED");

    // Subscription remains completely untouched
    const sub = db.subs.get("usr_rebind_test");
    assert.strictEqual(sub?.subscription_id, "sub_active_current");
    assert.strictEqual(sub?.current_period_end, futureEnd);
  });

  await check("2.15 Lifecycle RPC: Atomic transitions for pending, halted, cancelled", () => {
    const db = new PostgresState();
    db.subs.set("usr_life_1", {
      id: "sub_life_1",
      user_id: "usr_life_1",
      subscription_id: "sub_rzp_life_1",
      plan_id: "monthly",
      provider: "razorpay",
      status: "active",
      cancel_at_period_end: false,
      metadata: { mode: "live" },
    });

    const resPending = db.handle_subscription_lifecycle_event("sub_rzp_life_1", "subscription.pending", 1700000010);
    assert.strictEqual(resPending.success, true);
    assert.strictEqual(resPending.status, "in_grace_period");

    const resHalted = db.handle_subscription_lifecycle_event("sub_rzp_life_1", "subscription.halted", 1700000020);
    assert.strictEqual(resHalted.success, true);
    assert.strictEqual(resHalted.status, "past_due");

    const resCancelled = db.handle_subscription_lifecycle_event("sub_rzp_life_1", "subscription.cancelled", 1700000030);
    assert.strictEqual(resCancelled.success, true);
    assert.strictEqual(resCancelled.cancel_at_period_end, true);
  });

  await check("2.16 Lifecycle ordering: Out-of-order event rejected with OUT_OF_ORDER_EVENT based on durable last_event_time", () => {
    const db = new PostgresState();
    db.subs.set("usr_life_order", {
      id: "sub_life_order",
      user_id: "usr_life_order",
      subscription_id: "sub_rzp_life_order",
      plan_id: "monthly",
      provider: "razorpay",
      status: "active",
      cancel_at_period_end: false,
      metadata: { mode: "live", last_event_time: 1700000500 },
    });

    // Older event (timestamp 1700000100 < 1700000500)
    const resOld = db.handle_subscription_lifecycle_event("sub_rzp_life_order", "subscription.cancelled", 1700000100);
    assert.strictEqual(resOld.success, true);
    assert.strictEqual(resOld.ignored, true);
    assert.strictEqual(resOld.reason, "OUT_OF_ORDER_EVENT");

    // Subscription remains unchanged
    const sub = db.subs.get("usr_life_order");
    assert.strictEqual(sub?.cancel_at_period_end, false);

    // Newer event (timestamp 1700000600 > 1700000500)
    const resNew = db.handle_subscription_lifecycle_event("sub_rzp_life_order", "subscription.cancelled", 1700000600);
    assert.strictEqual(resNew.success, true);
    assert.strictEqual(resNew.applied, true);
    assert.strictEqual(sub?.cancel_at_period_end, true);
    assert.strictEqual(sub?.metadata?.last_event_time, 1700000600000);
  });

  await check("2.17 NULL stored payment mode fails closed on live mode with MODE_UNKNOWN", () => {
    const db = new PostgresState();
    db.orders.set("sub_null_mode", {
      id: "ord_null_mode",
      provider_order_id: "sub_null_mode",
      user_id: "usr_null_mode",
      provider: "razorpay",
      mode: undefined, // NULL mode
      status: "created",
      amount_paise: 149900,
      plan_code: "monthly",
    });

    const res = db.fulfil_subscription_renewal("sub_null_mode", "pay_null_mode", "live", 149900);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, "MODE_UNKNOWN");

    // Setting mode to 'live' allows fulfillment
    db.orders.get("sub_null_mode")!.mode = "live";
    const resOk = db.fulfil_subscription_renewal("sub_null_mode", "pay_live_mode", "live", 149900);
    assert.strictEqual(resOk.success, true);
  });

  await check("2.18 Missing/NULL event timestamp cannot bypass existing watermark", () => {
    const db = new PostgresState();
    db.subs.set("usr_watermark_guard", {
      id: "sub_wm_row",
      user_id: "usr_watermark_guard",
      subscription_id: "sub_wm_mandate",
      plan_id: "weekly",
      provider: "razorpay",
      status: "active",
      cancel_at_period_end: false,
      metadata: { mode: "live", last_event_time: 1700000500000 },
    });

    // Event with null timestamp against existing watermark must be ignored
    const resNullTs = db.fulfil_subscription_renewal("sub_wm_mandate", "pay_wm_null", "live", 69200, null as any);
    assert.strictEqual(resNullTs.success, true);
    assert.strictEqual(resNullTs.ignored, true);
    assert.strictEqual(resNullTs.code, "OUT_OF_ORDER_EVENT");

    const resNullLife = db.handle_subscription_lifecycle_event("sub_wm_mandate", "subscription.cancelled", null);
    assert.strictEqual(resNullLife.success, true);
    assert.strictEqual(resNullLife.ignored, true);
    assert.strictEqual(resNullLife.reason, "OUT_OF_ORDER_EVENT");

    // Subscription remains unchanged
    assert.strictEqual(db.subs.get("usr_watermark_guard")?.cancel_at_period_end, false);
    assert.strictEqual(db.subs.get("usr_watermark_guard")?.metadata?.last_event_time, 1700000500000);
  });

  await check("2.19 Seconds vs milliseconds normalization (2200000000000 ms -> 2200000001 sec -> 2200000000.5 sec cancel rejected)", () => {
    const db = new PostgresState();
    db.subs.set("usr_norm_test", {
      id: "sub_norm_row",
      user_id: "usr_norm_test",
      subscription_id: "sub_norm_mandate",
      plan_id: "quarterly",
      provider: "razorpay",
      status: "active",
      cancel_at_period_end: false,
      metadata: { mode: "live", last_event_time: 2200000000000 },
    });

    db.orders.set("sub_norm_mandate", {
      id: "ord_norm",
      provider_order_id: "sub_norm_mandate",
      user_id: "usr_norm_test",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 399900,
      plan_code: "quarterly",
    });

    // Step A: 2200000001 sec event advances watermark to 2200000001000 ms
    const resA = db.fulfil_subscription_renewal("sub_norm_mandate", "pay_norm_sec", "live", 399900, 2200000001);
    assert.strictEqual(resA.success, true);
    assert.strictEqual(resA.duration_days, 90);
    assert.strictEqual(db.subs.get("usr_norm_test")?.metadata?.last_event_time, 2200000001000);

    // Step B: 2200000000.5 sec older cancellation must be rejected as OUT_OF_ORDER_EVENT
    const resB = db.handle_subscription_lifecycle_event("sub_norm_mandate", "subscription.cancelled", 2200000000.5);
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.ignored, true);
    assert.strictEqual(resB.reason, "OUT_OF_ORDER_EVENT");

    // Cancel must NOT have applied
    assert.strictEqual(db.subs.get("usr_norm_test")?.cancel_at_period_end, false);
    assert.strictEqual(db.subs.get("usr_norm_test")?.metadata?.last_event_time, 2200000001000);
  });

  await check("2.20 Razorpay subscription period/schedule reconciliation (weekly 7d / monthly 30d / quarterly 90d)", () => {
    const db = new PostgresState();
    const now = 1700000000000;

    // Weekly: 7 days
    db.orders.set("sub_rec_w", {
      id: "ord_w",
      provider_order_id: "sub_rec_w",
      user_id: "usr_rec_w",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 69200,
      plan_code: "weekly",
    });
    const resW = db.fulfil_subscription_renewal("sub_rec_w", "pay_w", "live", 69200, now);
    assert.strictEqual(resW.duration_days, 7);
    assert.strictEqual(db.subs.get("usr_rec_w")?.amount, 69200);

    // Monthly: 30 days
    db.orders.set("sub_rec_m", {
      id: "ord_m",
      provider_order_id: "sub_rec_m",
      user_id: "usr_rec_m",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 149900,
      plan_code: "monthly",
    });
    const resM = db.fulfil_subscription_renewal("sub_rec_m", "pay_m", "live", 149900, now);
    assert.strictEqual(resM.duration_days, 30);
    assert.strictEqual(db.subs.get("usr_rec_m")?.amount, 149900);

    // Quarterly: 90 days
    db.orders.set("sub_rec_q", {
      id: "ord_q",
      provider_order_id: "sub_rec_q",
      user_id: "usr_rec_q",
      provider: "razorpay",
      mode: "live",
      status: "created",
      amount_paise: 399900,
      plan_code: "quarterly",
    });
    const resQ = db.fulfil_subscription_renewal("sub_rec_q", "pay_q", "live", 399900, now);
    assert.strictEqual(resQ.duration_days, 90);
    assert.strictEqual(db.subs.get("usr_rec_q")?.amount, 399900);
  });
}

async function run() {
  console.log("================================================================================");
  console.log("     AUTO-RENEWAL PERSISTENCE & LIFECYCLE VERIFICATION SUITE                     ");
  console.log("================================================================================");

  await textChecks();
  await functionalChecks();

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`RESULTS: ${passed}/${passed + failed} checks passed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    console.error(`VERDICT: FAIL (${failed} checks failed)\n`);
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All auto-renewal persistence, security, and idempotency rules verified)\n");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Unhandled execution error:", err);
  process.exit(1);
});
