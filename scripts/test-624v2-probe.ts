/**
 * scripts/test-624v2-probe.ts
 *
 * Real PostgreSQL execution probe (PGlite) for PR #624 reviewer requirements:
 * 1. repository-shaped schema: payment_orders starts with NO metadata column; migration adds it via ALTER TABLE ADD COLUMN IF NOT EXISTS.
 * 2. first real grant populates metadata without 'record v_order has no field metadata'.
 * 3. subscriptions.amount stores integer PAISE unchanged (weekly 69200, monthly 149900).
 * 4. NULL expected mode is strictly rejected with INVALID_EXPECTED_MODE.
 * 5. zero / missing amount on live cycle is strictly rejected with INVALID_PAYMENT_AMOUNT.
 * 6. old-mandate rebind fails CLOSED (when current order history is unavailable, old mandate is ignored with OLD_MANDATE_IGNORED).
 * 7. lock-order deadlock prevention: advisory lock on user first, then row lock everywhere.
 * 8. interleaved paid + lifecycle events keep the watermark monotonic (greatest(), never moves backwards; out-of-order paid events are ignored).
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

  // 1. Setup repository-shaped baseline schema (NOTE: payment_orders has NO metadata column!)
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
      amount INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Repository-shaped payment_orders schema: NO metadata column initially!
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

  // Verify baseline payment_orders does not have metadata
  const preCheck = await pg.query<{ count: string }>(`
    SELECT count(*)::text FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = 'metadata';
  `);
  assert.strictEqual(preCheck.rows[0].count, "0", "Baseline payment_orders must NOT have metadata column before migration");

  // 2. Execute migration 20261115a_autorenew.sql
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261115a_autorenew.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  await pg.exec(migrationSql);
  console.log("✓ Migration 20261115a_autorenew.sql successfully applied to real PostgreSQL.\n");

  // Verify migration added metadata column to payment_orders
  const postCheck = await pg.query<{ count: string }>(`
    SELECT count(*)::text FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = 'metadata';
  `);
  assert.strictEqual(postCheck.rows[0].count, "1", "Migration must add metadata column to payment_orders via ALTER TABLE ADD COLUMN IF NOT EXISTS");

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
  // PROBE 1: repository-shaped payment_orders + metadata population
  // ---------------------------------------------------------------------------
  await probe("Probe 1: repository-shaped schema + first real grant populates metadata and stores paise amount", async () => {
    // Insert order into table that was upgraded by migration
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe1', 'razorpay', 'live', 'created', 'monthly', 149900);
    `, [u1]);

    const res = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe1', 'pay_probe1_initial', 'live', 149900) AS fulfil_subscription_renewal;
    `);

    const result = res.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(result.success, true, "Must return success: true");
    assert.strictEqual(result.is_pro, true, "Must grant is_pro: true");
    assert.strictEqual(result.duration_days, 30, "Monthly duration must be 30 days");
    assert.strictEqual(result.amount, 149900, "Result payload amount must be integer paise 149900");

    // Verify payment_orders metadata was populated safely without null pointer exception
    const orderCheck = await pg.query<{ status: string; metadata: any }>(`
      SELECT status, metadata FROM public.payment_orders WHERE provider_order_id = 'sub_probe1';
    `);
    assert.strictEqual(orderCheck.rows[0].status, "paid");
    assert.strictEqual(orderCheck.rows[0].metadata?.payment_id, "pay_probe1_initial");

    // Verify subscription was created with exact PAISE amount
    const subCheck = await pg.query<{ status: string; plan_id: string; subscription_id: string; amount: number }>(`
      SELECT status, plan_id, subscription_id, amount FROM public.subscriptions WHERE user_id = $1;
    `, [u1]);
    assert.strictEqual(subCheck.rows[0].status, "active");
    assert.strictEqual(subCheck.rows[0].subscription_id, "sub_probe1");
    assert.strictEqual(subCheck.rows[0].plan_id, "monthly");
    assert.strictEqual(Number(subCheck.rows[0].amount), 149900, "Stored subscriptions.amount must be integer paise (149900), not rupees (1499)");
  });

  // ---------------------------------------------------------------------------
  // PROBE 2: paise amount & zero/missing amount rejection
  // ---------------------------------------------------------------------------
  await probe("Probe 2: paise amount validation (zero/missing rejected, mismatched rejected, exact paise fulfilled)", async () => {
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe2', 'razorpay', 'live', 'created', 'monthly', 149900);
    `, [u2]);

    // 2a. NULL amount on live cycle rejected
    const nullAmtRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_null', 'live', NULL) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(nullAmtRes.rows[0].fulfil_subscription_renewal.success, false);
    assert.strictEqual(nullAmtRes.rows[0].fulfil_subscription_renewal.code, "INVALID_PAYMENT_AMOUNT");

    // 2b. Zero amount on live cycle rejected
    const zeroAmtRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_zero', 'live', 0) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(zeroAmtRes.rows[0].fulfil_subscription_renewal.success, false);
    assert.strictEqual(zeroAmtRes.rows[0].fulfil_subscription_renewal.code, "INVALID_PAYMENT_AMOUNT");

    // 2c. Mismatched amount: 99900 instead of 149900 rejected
    const failRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_bad', 'live', 99900) AS fulfil_subscription_renewal;
    `);
    const failResult = failRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(failResult.success, false);
    assert.strictEqual(failResult.code, "PLAN_AMOUNT_MISMATCH");

    // 2d. Matching amount: 149900 succeeds and stores exact paise
    const okRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe2', 'pay_probe2_good', 'live', 149900) AS fulfil_subscription_renewal;
    `);
    const okResult = okRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(okResult.success, true);
    assert.strictEqual(okResult.is_pro, true);

    const subCheckAfter = await pg.query<{ status: string; plan_id: string; amount: number }>(`
      SELECT status, plan_id, amount FROM public.subscriptions WHERE user_id = $1;
    `, [u2]);
    assert.strictEqual(subCheckAfter.rows[0].status, "active");
    assert.strictEqual(subCheckAfter.rows[0].plan_id, "monthly");
    assert.strictEqual(Number(subCheckAfter.rows[0].amount), 149900, "Stored amount must be 149900 paise");
  });

  // ---------------------------------------------------------------------------
  // PROBE 3: NULL expected mode rejected & weekly 69200 paise stored
  // ---------------------------------------------------------------------------
  await probe("Probe 3: NULL expected mode rejected (RPC strictly rejects NULL or unknown mode)", async () => {
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe3', 'razorpay', 'live', 'created', 'weekly', 69200);
    `, [u3]);

    // 3a. NULL mode in fulfil_subscription_renewal must be rejected
    const nullModeRenewal = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe3', 'pay_probe3_null_mode', NULL, 69200) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(nullModeRenewal.rows[0].fulfil_subscription_renewal.success, false);
    assert.strictEqual(nullModeRenewal.rows[0].fulfil_subscription_renewal.code, "INVALID_EXPECTED_MODE");

    // 3b. Invalid string mode must be rejected
    const badModeRenewal = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe3', 'pay_probe3_bad_mode', 'sandbox', 69200) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(badModeRenewal.rows[0].fulfil_subscription_renewal.success, false);
    assert.strictEqual(badModeRenewal.rows[0].fulfil_subscription_renewal.code, "INVALID_EXPECTED_MODE");

    // 3c. Valid mode 'live' succeeds and stores 69200 paise
    const validRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe3', 'pay_probe3_valid', 'live', 69200) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(validRes.rows[0].fulfil_subscription_renewal.success, true);
    assert.strictEqual(validRes.rows[0].fulfil_subscription_renewal.duration_days, 7);

    const subCheckWeekly = await pg.query<{ amount: number }>(`
      SELECT amount FROM public.subscriptions WHERE user_id = $1;
    `, [u3]);
    assert.strictEqual(Number(subCheckWeekly.rows[0].amount), 69200, "Weekly plan must store 69200 paise, not 692");

    // 3d. NULL mode in handle_subscription_lifecycle_event must be rejected
    const nullModeLife = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe3', 'subscription.pending', 1700000050, NULL) AS handle_subscription_lifecycle_event;
    `);
    assert.strictEqual(nullModeLife.rows[0].handle_subscription_lifecycle_event.success, false);
    assert.strictEqual(nullModeLife.rows[0].handle_subscription_lifecycle_event.code, "INVALID_EXPECTED_MODE");
  });

  // ---------------------------------------------------------------------------
  // PROBE 4: old-mandate rebind (Fail CLOSED when current order history unavailable)
  // ---------------------------------------------------------------------------
  await probe("Probe 4: old-mandate rebind (fails CLOSED: without verifiable current order history, old mandate is ignored)", async () => {
    const activeFutureEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

    // User 4 has an active bound subscription 'sub_active_current_4', BUT NO payment_orders row for it!
    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, current_period_start, current_period_end, amount, metadata)
      VALUES ($1, 'sub_active_current_4', 'monthly', 'razorpay', 'active', NOW(), $2, 149900, '{"mode": "live", "initial_payment_id": "pay_curr"}'::jsonb);
    `, [u4, activeFutureEnd]);

    // Abandoned old order for 'sub_old_abandoned_4' exists with status 'created'
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise, created_at)
      VALUES ($1, 'sub_old_abandoned_4', 'razorpay', 'live', 'created', 'monthly', 149900, NOW() - INTERVAL '10 days');
    `, [u4]);

    // Attempt to fulfill renewal for the old mandate when current order timestamp is unavailable
    // MUST FAIL CLOSED: ignore old mandate, do NOT overwrite active subscription!
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
  // PROBE 5: interleaved paid + lifecycle events keep watermark monotonic
  // ---------------------------------------------------------------------------
  await probe("Probe 5: interleaved paid + lifecycle events keep watermark monotonic (never rewind, ignore older paid events)", async () => {
    // User 5 starts with an active subscription at watermark ts = 1700000100
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe5_mandate', 'razorpay', 'live', 'created', 'monthly', 149900);
    `, [u5]);

    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, cancel_at_period_end, metadata, amount)
      VALUES ($1, 'sub_probe5_mandate', 'monthly', 'razorpay', 'active', false, '{"mode": "live", "last_event_time": 1700000100}'::jsonb, 149900);
    `, [u5]);

    // 5a. Lifecycle event (subscription.pending) arrives at ts 2000000000 -> applies, sets in_grace_period
    const pendingRes = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe5_mandate', 'subscription.pending', 2000000000, 'live') AS handle_subscription_lifecycle_event;
    `);
    const pendingResult = pendingRes.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(pendingResult.success, true);
    assert.strictEqual(pendingResult.applied, true);
    assert.strictEqual(pendingResult.status, "in_grace_period");

    const subAfterPending = await pg.query<{ status: string; metadata: any }>(`
      SELECT status, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subAfterPending.rows[0].status, "in_grace_period");
    assert.strictEqual(Number(subAfterPending.rows[0].metadata?.last_event_time), 2000000000);

    // 5b. Older charged event arrives at 1900000000 (< 2000000000)
    // MUST NOT set status active, MUST NOT rewind last_event_time! MUST be ignored as OUT_OF_ORDER_EVENT.
    const olderPaidRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe5_mandate', 'pay_probe5_older', 'live', 149900, 1900000000) AS fulfil_subscription_renewal;
    `);
    const olderPaidResult = olderPaidRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(olderPaidResult.success, true);
    assert.strictEqual(olderPaidResult.ignored, true);
    assert.strictEqual(olderPaidResult.code, "OUT_OF_ORDER_EVENT");

    // Verify subscription status and watermark are NOT rewound
    const subAfterOlderPaid = await pg.query<{ status: string; metadata: any }>(`
      SELECT status, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subAfterOlderPaid.rows[0].status, "in_grace_period", "Status must remain in_grace_period; older paid event must not overwrite it");
    assert.strictEqual(Number(subAfterOlderPaid.rows[0].metadata?.last_event_time), 2000000000, "Watermark must remain 2000000000; never moves backwards");

    // 5c. In-order charged event arrives at 2100000000 (> 2000000000) -> applies and sets active, advances watermark
    const inOrderPaidRes = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe5_mandate', 'pay_probe5_newer', 'live', 149900, 2100000000) AS fulfil_subscription_renewal;
    `);
    const inOrderPaidResult = inOrderPaidRes.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(inOrderPaidResult.success, true);
    assert.strictEqual(inOrderPaidResult.is_pro, true);

    const subAfterNewerPaid = await pg.query<{ status: string; metadata: any }>(`
      SELECT status, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subAfterNewerPaid.rows[0].status, "active", "Status must now be active from newer paid event");
    assert.strictEqual(Number(subAfterNewerPaid.rows[0].metadata?.last_event_time), 2100000000, "Watermark must advance to 2100000000");

    // 5d. Delayed cancel event arrives at 2050000000 (< 2100000000) -> ignored
    const delayedCancelRes = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe5_mandate', 'subscription.cancelled', 2050000000, 'live') AS handle_subscription_lifecycle_event;
    `);
    const delayedCancelResult = delayedCancelRes.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(delayedCancelResult.success, true);
    assert.strictEqual(delayedCancelResult.ignored, true);
    assert.strictEqual(delayedCancelResult.code, "OUT_OF_ORDER_EVENT");

    const subFinal = await pg.query<{ status: string; cancel_at_period_end: boolean; metadata: any }>(`
      SELECT status, cancel_at_period_end, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u5]);
    assert.strictEqual(subFinal.rows[0].cancel_at_period_end, false, "Delayed cancel must be ignored");
    assert.strictEqual(Number(subFinal.rows[0].metadata?.last_event_time), 2100000000, "Watermark must stay 2100000000");
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
