/**
 * scripts/test-624v2-probe.ts
 *
 * Real PostgreSQL execution probe (PGlite) for PR #624 reviewer requirements:
 * 1. no payment_orders.metadata: NULL metadata does not throw JSON operator errors and fulfills cleanly.
 * 2. paise amount: plan price mismatch rejected with PLAN_AMOUNT_MISMATCH, matching paise amount succeeds.
 * 3. NULL mode: NULL order/subscription mode defaults to 'live' cleanly without false mismatch.
 * 4. old-mandate rebind: old/abandoned mandate does NOT overwrite active subscription_id or extend access (OLD_MANDATE_IGNORED).
 * 5. delayed cancel: out-of-order lifecycle event is rejected (OUT_OF_ORDER_EVENT) based on durable last_event_time; in-order event applies.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

let passed = 0;
let failed = 0;

async function probe(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function run() {
  console.log("================================================================================");
  console.log("     PR #624v2 REAL SQL PROBE SUITE (PGlite PostgreSQL Execution)                ");
  console.log("================================================================================");

  const pg = new PGlite();

  // 1. Setup baseline schema required for 20261115a_autorenew.sql
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (
      id UUID PRIMARY KEY,
      email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
    END;
    $$;

    CREATE TABLE public.plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      price_paise INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO public.plans (code, name, price_paise, duration_days, is_active) VALUES
      ('weekly', 'Weekly', 69200, 7, true),
      ('monthly', 'Monthly', 149900, 30, true),
      ('quarterly', 'Quarterly', 399900, 90, true);

    CREATE TABLE public.subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      subscription_id TEXT,
      plan_id TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN DEFAULT false,
      grace_period_end TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'::jsonb,
      currency TEXT DEFAULT 'INR',
      amount NUMERIC,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE public.payment_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      provider_order_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'razorpay',
      mode TEXT DEFAULT 'live',
      status TEXT NOT NULL DEFAULT 'created',
      plan_code TEXT,
      amount_paise INTEGER,
      paid_at TIMESTAMPTZ,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE public.blocked_users (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      blocked_at TIMESTAMPTZ DEFAULT NOW(),
      reason TEXT
    );

    CREATE TABLE public.user_addon_credits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      addon_code TEXT NOT NULL,
      sets_remaining INTEGER NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE public.webhook_events (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 2. Execute migration 20261115a_autorenew.sql
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261115a_autorenew.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  await pg.exec(migrationSql);
  console.log("✓ Migration 20261115a_autorenew.sql successfully applied to real PostgreSQL.\n");

  // Helper UUIDs
  const u1 = "11111111-1111-4111-8111-111111111111";
  const u2 = "22222222-2222-4222-8222-222222222222";
  const u3 = "33333333-3333-4333-8333-333333333333";
  const u4 = "44444444-4444-4444-8444-444444444444";
  const u5 = "55555555-5555-4555-8555-555555555555";

  for (const uid of [u1, u2, u3, u4, u5]) {
    await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING;`, [
      uid,
      `user_${uid}@test.local`,
    ]);
  }

  // ---------------------------------------------------------------------------
  // PROBE 1: no payment_orders.metadata
  // ---------------------------------------------------------------------------
  await probe("Probe 1: no payment_orders.metadata (NULL metadata safely updated and fulfilled)", async () => {
    // Create order with metadata = NULL
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, metadata)
      VALUES ($1, 'sub_probe1', 'razorpay', 'live', 'created', 'monthly', 149900, NULL);
    `, [u1]);

    const res = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe1', 'pay_probe1_initial', 'live', 149900) AS fulfil_subscription_renewal;
    `);

    const result = res.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(result.success, true, "Must return success: true");
    assert.strictEqual(result.is_pro, true, "Must grant is_pro: true");
    assert.strictEqual(result.duration_days, 30, "Monthly duration must be 30 days");

    // Verify payment_orders metadata was populated safely without null pointer exception
    const orderCheck = await pg.query<{ status: string; metadata: any }>(`
      SELECT status, metadata FROM public.payment_orders WHERE provider_order_id = 'sub_probe1';
    `);
    assert.strictEqual(orderCheck.rows[0].status, "paid");
    assert.strictEqual(orderCheck.rows[0].metadata?.payment_id, "pay_probe1_initial");

    // Verify subscription was created and bound
    const subCheck = await pg.query<{ status: string; plan_id: string; subscription_id: string }>(`
      SELECT status, plan_id, subscription_id FROM public.subscriptions WHERE user_id = $1;
    `, [u1]);
    assert.strictEqual(subCheck.rows[0].status, "active");
    assert.strictEqual(subCheck.rows[0].subscription_id, "sub_probe1");
    assert.strictEqual(subCheck.rows[0].plan_id, "monthly");
  });

  // ---------------------------------------------------------------------------
  // PROBE 2: paise amount
  // ---------------------------------------------------------------------------
  await probe("Probe 2: paise amount validation (mismatched paise rejected, exact paise fulfilled)", async () => {
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, metadata)
      VALUES ($1, 'sub_probe2', 'razorpay', 'live', 'created', 'monthly', 149900, '{}'::jsonb);
    `, [u2]);

    // 2a. Mismatched amount: 99900 instead of 149900
    const failRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_bad', 'live', 99900) AS fulfil_subscription_renewal;
    `);
    const failResult = failRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(failResult.success, false, "Mismatched amount must return success: false");
    assert.strictEqual(failResult.code, "PLAN_AMOUNT_MISMATCH", "Code must be PLAN_AMOUNT_MISMATCH");

    // Verify order remains created and no subscription exists
    const orderCheckBefore = await pg.query<{ status: string }>(`
      SELECT status FROM public.payment_orders WHERE provider_order_id = 'sub_probe2';
    `);
    assert.strictEqual(orderCheckBefore.rows[0].status, "created");
    const subCheckBefore = await pg.query(`SELECT 1 FROM public.subscriptions WHERE user_id = $1;`, [u2]);
    assert.strictEqual(subCheckBefore.rows.length, 0);

    // 2b. Matching amount: 149900 succeeds
    const okRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_good', 'live', 149900) AS fulfil_subscription_renewal;
    `);
    const okResult = okRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(okResult.success, true, "Matching amount must return success: true");
    assert.strictEqual(okResult.is_pro, true);

    const subCheckAfter = await pg.query<{ status: string; plan_id: string }>(`
      SELECT status, plan_id FROM public.subscriptions WHERE user_id = $1;
    `, [u2]);
    assert.strictEqual(subCheckAfter.rows[0].status, "active");
    assert.strictEqual(subCheckAfter.rows[0].plan_id, "monthly");
  });

  // ---------------------------------------------------------------------------
  // PROBE 3: NULL mode
  // ---------------------------------------------------------------------------
  await probe("Probe 3: NULL mode (defaults to 'live' cleanly without mode mismatch error)", async () => {
    // Create order with mode = NULL
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, metadata)
      VALUES ($1, 'sub_probe3', 'razorpay', NULL, 'created', 'weekly', 69200, '{}'::jsonb);
    `, [u3]);

    // Fulfill with expected mode = 'live'
    const res = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe3', 'pay_probe3_initial', 'live', 69200) AS fulfil_subscription_renewal;
    `);
    const result = res.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(result.success, true, "NULL mode must default to live and succeed");
    assert.strictEqual(result.is_pro, true);
    assert.strictEqual(result.duration_days, 7, "Weekly duration must be 7 days");

    // Lifecycle event on subscription with null mode in metadata
    const lifeRes = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe3', 'subscription.pending', 1700000050, 'live') AS handle_subscription_lifecycle_event;
    `);
    const lifeResult = lifeRes.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(lifeResult.success, true, "Lifecycle event with default live mode must succeed");
    assert.strictEqual(lifeResult.status, "in_grace_period");
  });

  // ---------------------------------------------------------------------------
  // PROBE 4: old-mandate rebind
  // ---------------------------------------------------------------------------
  await probe("Probe 4: old-mandate rebind (active mandate preserved, old mandate rejected with OLD_MANDATE_IGNORED)", async () => {
    const activeFutureEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

    // User 4 has an active bound subscription
    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, current_period_start, current_period_end, metadata)
      VALUES ($1, 'sub_active_current_4', 'monthly', 'razorpay', 'active', NOW(), $2, '{"mode": "live", "initial_payment_id": "pay_curr"}'::jsonb);
    `, [u4, activeFutureEnd]);

    // Active order was created earlier today
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, created_at)
      VALUES ($1, 'sub_active_current_4', 'razorpay', 'live', 'paid', 'monthly', 149900, NOW() - INTERVAL '2 days');
    `, [u4]);

    // Old abandoned order created 10 days ago with status 'cancelled'
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, created_at)
      VALUES ($1, 'sub_old_abandoned_4', 'razorpay', 'live', 'cancelled', 'monthly', 149900, NOW() - INTERVAL '10 days');
    `, [u4]);

    // Attempt to fulfill renewal for the old mandate
    const res = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_old_abandoned_4', 'pay_late_abandoned', 'live', 149900) AS fulfil_subscription_renewal;
    `);
    const result = res.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(result.success, true, "Must return success: true");
    assert.strictEqual(result.ignored, true, "Must return ignored: true");
    assert.strictEqual(result.reason, "OLD_MANDATE_IGNORED", "Reason must be OLD_MANDATE_IGNORED");
    assert.strictEqual(result.current_mandate, "sub_active_current_4", "Must report current mandate");

    // Assert that public.subscriptions was NOT touched or overwritten
    const subCheck = await pg.query<{ subscription_id: string; current_period_end: string; status: string }>(`
      SELECT subscription_id, current_period_end, status FROM public.subscriptions WHERE user_id = $1;
    `, [u4]);
    assert.strictEqual(subCheck.rows[0].subscription_id, "sub_active_current_4", "Active subscription_id must NOT be overwritten");
    assert.strictEqual(subCheck.rows[0].status, "active", "Status must remain active");
    assert.strictEqual(
      new Date(subCheck.rows[0].current_period_end).getTime(),
      new Date(activeFutureEnd).getTime(),
      "current_period_end must NOT be extended by old mandate"
    );
  });

  // ---------------------------------------------------------------------------
  // PROBE 5: delayed cancel
  // ---------------------------------------------------------------------------
  await probe("Probe 5: delayed cancel (out-of-order event rejected with OUT_OF_ORDER_EVENT, in-order applies)", async () => {
    // User 5 has an active subscription with durable last_event_time = 1700000500
    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, cancel_at_period_end, metadata)
      VALUES ($1, 'sub_probe5_mandate', 'monthly', 'razorpay', 'active', false, '{"mode": "live", "last_event_time": 1700000500}'::jsonb);
    `, [u5]);

    // 5a. Out-of-order event arrives: timestamp 1700000100 < 1700000500
    const delayedRes = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe5_mandate', 'subscription.cancelled', 1700000100, 'live') AS handle_subscription_lifecycle_event;
    `);
    const delayedResult = delayedRes.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(delayedResult.success, true, "Out-of-order event returns success: true");
    assert.strictEqual(delayedResult.ignored, true, "Out-of-order event returns ignored: true");
    assert.strictEqual(delayedResult.reason, "OUT_OF_ORDER_EVENT", "Reason must be OUT_OF_ORDER_EVENT");

    // Verify subscription was NOT cancelled
    const subCheckBefore = await pg.query<{ cancel_at_period_end: boolean }>(`
      SELECT cancel_at_period_end FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subCheckBefore.rows[0].cancel_at_period_end, false, "cancel_at_period_end must remain false");

    // 5b. In-order event arrives: timestamp 1700000600 > 1700000500
    const inOrderRes = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe5_mandate', 'subscription.cancelled', 1700000600, 'live') AS handle_subscription_lifecycle_event;
    `);
    const inOrderResult = inOrderRes.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(inOrderResult.success, true);
    assert.strictEqual(inOrderResult.applied, true, "In-order event must return applied: true");
    assert.strictEqual(inOrderResult.cancel_at_period_end, true);

    // Verify subscription was updated and last_event_time was persisted
    const subCheckAfter = await pg.query<{ cancel_at_period_end: boolean; metadata: any }>(`
      SELECT cancel_at_period_end, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subCheckAfter.rows[0].cancel_at_period_end, true, "cancel_at_period_end must now be true");
    assert.strictEqual(subCheckAfter.rows[0].metadata?.last_event_time, 1700000600, "Durable last_event_time must be updated to 1700000600");
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`RESULTS: ${passed}/${passed + failed} probes passed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    console.error(`VERDICT: FAIL (${failed} probes failed)\n`);
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All 5 reviewer probe tests passed against real PostgreSQL engine)\n");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Unhandled probe error:", err);
  process.exit(1);
});
