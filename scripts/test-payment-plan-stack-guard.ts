/**
 * scripts/test-payment-plan-stack-guard.ts
 *
 * Offline verification for audit B5 (migration 20261114a_payment_plan_stack_guard.sql).
 *
 * Part 1 asserts the migration text itself: header/record convention, the per-user advisory lock taken
 * before the subscription is read, the newer-order label guard, and the retained ACL / timeout / search_path.
 *
 * Part 2 runs the plan-stacking decision in `fulfilModel`, a line-for-line port of the SQL plan path
 * (no Postgres is available offline). It covers: older-after-newer, newer-after-older, same order twice,
 * two concurrent orders (serialized by a per-user lock like pg_advisory_xact_lock), missing metadata,
 * equal timestamps and an expired subscription. The model is a port, not the database: apply the migration
 * and re-run the scenarios against Supabase before relying on it.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const MIGRATION = "20261114a_payment_plan_stack_guard.sql";
const sql = fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations", MIGRATION), "utf8");

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
// Part 1: migration text
// ---------------------------------------------------------------------------
async function textChecks() {
  await check("1.1 header is NOT APPLIED with the record-migration command", () => {
    assert.ok(/--\s*Status:\s*NOT APPLIED/.test(sql));
    assert.ok(sql.includes(`node scripts/record-migration.cjs ${MIGRATION}`));
  });
  await check("1.2 per-user advisory lock is taken before the subscription is read", () => {
    const lock = sql.indexOf("PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text))");
    const firstSubRead = sql.indexOf("FROM public.subscriptions");
    assert.ok(lock > 0, "advisory lock missing");
    assert.ok(lock < firstSubRead, "advisory lock must come before any subscriptions read");
  });
  await check("1.3 order-row lock is kept and comes before the advisory lock", () => {
    const rowLock = sql.indexOf("FOR UPDATE;");
    assert.ok(rowLock > 0 && rowLock < sql.indexOf("PERFORM pg_advisory_xact_lock"));
  });
  await check("1.4 label is guarded by payment_orders.created_at of the previous order", () => {
    assert.ok(sql.includes("v_order.created_at > v_prev_order_created"));
    assert.ok(sql.includes("FROM public.payment_orders"));
    assert.ok(/v_label_plan := v_existing_sub\.plan_id/.test(sql));
  });
  await check("1.5 upsert writes labels from guarded variables, not straight from the order", () => {
    const upsert = sql.slice(sql.indexOf("INSERT INTO public.subscriptions"), sql.indexOf("RETURNING * INTO v_sub"));
    assert.ok(upsert.includes("v_label_plan") && upsert.includes("v_label_meta"));
    assert.ok(!/v_order\.plan_code,\s*\n\s*'razorpay'/.test(upsert));
  });
  await check("1.6 SECURITY DEFINER keeps pinned search_path = public, ACL revokes and 15s timeout", () => {
    assert.ok(/SECURITY DEFINER\s*\nSET search_path = public\s*\nAS \$\$/.test(sql));
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM ${role};`), `revoke ${role}`);
    }
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;"));
    assert.ok(sql.includes("SET statement_timeout = '15s'"));
  });
  await check("1.7 already_paid short-circuit, add-on path and test-mode isolation are retained", () => {
    assert.ok(sql.includes("Order already fulfilled and marked as paid"));
    assert.ok(sql.includes("PRO_REQUIRED"));
    assert.ok(sql.includes("Test payment verified; zero real entitlements granted"));
    assert.ok(sql.includes("MODE_MISMATCH"));
  });
  await check("1.8 schema dump contains the new function body", () => {
    const dump = fs.readFileSync(path.resolve(process.cwd(), "supabase/schema.generated.sql"), "utf8");
    assert.ok(dump.includes(MIGRATION) && dump.includes("pg_advisory_xact_lock(hashtext(p_user_id::text))"));
  });
}

// ---------------------------------------------------------------------------
// Part 2: model of the SQL plan path
// ---------------------------------------------------------------------------
type Sub = {
  plan_id: string;
  currency: string;
  amount: number;
  status: string;
  current_period_start: number;
  current_period_end: number;
  metadata: Record<string, any>;
} | null;
type Order = { id: string; plan_code: string; currency: string; amount_paise: number; created_at: number; status: "created" | "paid" };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14);
const DURATION: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 90 };

function makeDb(orders: Order[], sub: Sub) {
  const state = { orders: new Map(orders.map((o) => [o.id, { ...o }])), sub: sub ? { ...sub, metadata: { ...sub.metadata } } : null as Sub };
  // pg_advisory_xact_lock(hashtext(user)): one fulfilment at a time per user
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => T): Promise<T> => {
    const run = tail.then(() => fn());
    tail = run.catch(() => undefined);
    return run;
  };
  const fulfilModel = (orderId: string) =>
    lock(() => {
      const order = state.orders.get(orderId)!;
      if (order.status === "paid") return { already_paid: true, period_end: state.sub?.current_period_end ?? null };
      const duration = DURATION[order.plan_code] ?? 30;
      const existing = state.sub;
      let label = { plan_id: order.plan_code, currency: order.currency, amount: order.amount_paise, metadata: { payment_order_id: order.id } as Record<string, any> };
      let periodStart: number;
      let newEnd: number;
      if (existing && ["active", "trialing"].includes(existing.status) && existing.current_period_end != null) {
        periodStart = existing.current_period_start ?? NOW;
        const prevId = typeof existing.metadata?.payment_order_id === "string" ? existing.metadata.payment_order_id : null;
        if (prevId === order.id) {
          newEnd = existing.current_period_end;
        } else {
          newEnd = Math.max(existing.current_period_end, NOW) + duration * DAY;
          const prevCreated = prevId ? state.orders.get(prevId)?.created_at ?? null : null;
          if (prevCreated === null || !(order.created_at > prevCreated)) {
            label = { plan_id: existing.plan_id, currency: existing.currency, amount: existing.amount, metadata: existing.metadata };
          }
        }
      } else {
        periodStart = NOW;
        newEnd = NOW + duration * DAY;
      }
      state.sub = { ...label, status: "active", current_period_start: periodStart, current_period_end: newEnd };
      order.status = "paid";
      return { already_paid: false, period_end: newEnd };
    });
  return { state, fulfilModel };
}

const order = (id: string, plan: string, amount: number, createdOffsetDays: number): Order => ({
  id,
  plan_code: plan,
  currency: "INR",
  amount_paise: amount,
  created_at: NOW + createdOffsetDays * DAY,
  status: "created",
});
const weekly = () => order("order-weekly", "weekly", 14900, -2); // older
const monthly = () => order("order-monthly", "monthly", 49900, -1); // newer

async function modelChecks() {
  await check("2.1 older-after-newer: late older order extends but keeps the newer plan label", async () => {
    const { state, fulfilModel } = makeDb([weekly(), monthly()], null);
    await fulfilModel("order-monthly");
    await fulfilModel("order-weekly");
    assert.strictEqual(state.sub!.plan_id, "monthly");
    assert.strictEqual(state.sub!.amount, 49900);
    assert.strictEqual(state.sub!.metadata.payment_order_id, "order-monthly");
    assert.strictEqual(state.sub!.current_period_end, NOW + 37 * DAY);
  });

  await check("2.2 newer-after-older: newer order takes over the label and extends", async () => {
    const { state, fulfilModel } = makeDb([weekly(), monthly()], null);
    await fulfilModel("order-weekly");
    await fulfilModel("order-monthly");
    assert.strictEqual(state.sub!.plan_id, "monthly");
    assert.strictEqual(state.sub!.metadata.payment_order_id, "order-monthly");
    assert.strictEqual(state.sub!.current_period_end, NOW + 37 * DAY);
  });

  await check("2.3 same order twice: second call is already_paid and does not extend", async () => {
    const { state, fulfilModel } = makeDb([weekly()], null);
    const first = await fulfilModel("order-weekly");
    const second = await fulfilModel("order-weekly");
    assert.strictEqual(first.already_paid, false);
    assert.strictEqual(second.already_paid, true);
    assert.strictEqual(state.sub!.current_period_end, NOW + 7 * DAY);
  });

  await check("2.4 two concurrent orders serialize: result is identical in either arrival order", async () => {
    for (const arrival of [["order-weekly", "order-monthly"], ["order-monthly", "order-weekly"]]) {
      const { state, fulfilModel } = makeDb([weekly(), monthly()], null);
      await Promise.all(arrival.map((id) => fulfilModel(id)));
      assert.strictEqual(state.sub!.plan_id, "monthly", `arrival ${arrival.join(">")}`);
      assert.strictEqual(state.sub!.metadata.payment_order_id, "order-monthly", `arrival ${arrival.join(">")}`);
      assert.strictEqual(state.sub!.current_period_end, NOW + 37 * DAY, `arrival ${arrival.join(">")}`);
      assert.ok([...state.orders.values()].every((o) => o.status === "paid"));
    }
  });

  await check("2.5 missing metadata on the active subscription keeps the existing label but still extends", async () => {
    const sub: Sub = { plan_id: "quarterly", currency: "INR", amount: 99900, status: "active", current_period_start: NOW - DAY, current_period_end: NOW + 10 * DAY, metadata: {} };
    const { state, fulfilModel } = makeDb([weekly()], sub);
    await fulfilModel("order-weekly");
    assert.strictEqual(state.sub!.plan_id, "quarterly");
    assert.strictEqual(state.sub!.amount, 99900);
    assert.deepStrictEqual(state.sub!.metadata, {});
    assert.strictEqual(state.sub!.current_period_end, NOW + 17 * DAY);
  });

  await check("2.6 equal created_at timestamps keep the existing label", async () => {
    const a = { ...weekly(), created_at: NOW - DAY };
    const b = { ...monthly(), created_at: NOW - DAY };
    const { state, fulfilModel } = makeDb([a, b], null);
    await fulfilModel("order-weekly");
    await fulfilModel("order-monthly");
    assert.strictEqual(state.sub!.plan_id, "weekly");
    assert.strictEqual(state.sub!.metadata.payment_order_id, "order-weekly");
    assert.strictEqual(state.sub!.current_period_end, NOW + 37 * DAY);
  });

  await check("2.7 expired subscription (status no longer active) is replaced by the new order, period restarts from now", async () => {
    const sub: Sub = { plan_id: "quarterly", currency: "INR", amount: 99900, status: "expired", current_period_start: NOW - 100 * DAY, current_period_end: NOW - DAY, metadata: { payment_order_id: "order-weekly" } };
    const { state, fulfilModel } = makeDb([weekly(), monthly()], sub);
    await fulfilModel("order-monthly");
    assert.strictEqual(state.sub!.plan_id, "monthly");
    assert.strictEqual(state.sub!.metadata.payment_order_id, "order-monthly");
    assert.strictEqual(state.sub!.current_period_start, NOW);
    assert.strictEqual(state.sub!.current_period_end, NOW + 30 * DAY);
  });

  await check("2.8 active row with a past period end extends from now (not from the past end) and takes the newer label", async () => {
    const sub: Sub = { plan_id: "weekly", currency: "INR", amount: 14900, status: "active", current_period_start: NOW - 100 * DAY, current_period_end: NOW - DAY, metadata: { payment_order_id: "order-weekly" } };
    const { state, fulfilModel } = makeDb([weekly(), monthly()], sub);
    await fulfilModel("order-monthly");
    assert.strictEqual(state.sub!.plan_id, "monthly");
    assert.strictEqual(state.sub!.current_period_end, NOW + 30 * DAY);
  });
}

(async () => {
  await textChecks();
  await modelChecks();
  console.log(`\nTEST RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
