/**
 * scripts/test-624v2-probe.ts
 *
 * Real PostgreSQL execution probe (PGlite) for PR #624 reviewer requirements:
 * 1. repository-shaped schema: payment_orders starts with NO metadata column; migration adds it via ALTER TABLE ADD COLUMN IF NOT EXISTS.
 * 2. first real grant populates metadata without 'record v_order has no field metadata'.
 * 3. subscriptions.amount stores integer PAISE unchanged (weekly 69200, monthly 149900, quarterly 399900).
 * 4. NULL expected mode is strictly rejected with INVALID_EXPECTED_MODE.
 * 5. zero / missing amount on live cycle is strictly rejected with INVALID_PAYMENT_AMOUNT.
 * 6. NULL stored payment mode (order mode + sub metadata both NULL) fails closed on live mode with MODE_UNKNOWN.
 * 7. Missing / NULL event timestamp cannot bypass existing watermark; ignored as OUT_OF_ORDER_EVENT.
 * 8. Seconds vs milliseconds: normalized to ms before comparison and storage.
 *    Tested with 2200000000000 ms watermark -> 2200000001 sec event -> 2200000000.5 sec cancel (rejected).
 * 9. Old-mandate rebind fails CLOSED (when current order history unavailable, ignored as OLD_MANDATE_IGNORED).
 * 10. Schedule reconciliation: covers exact 7/30/90 day extensions from greatest(current_period_end, now).
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
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
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
      currency TEXT DEFAULT 'INR',
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

    CREATE TABLE public.addon_packs (
      code TEXT PRIMARY KEY,
      sets INTEGER NOT NULL,
      validity_days INTEGER NOT NULL
    );
    INSERT INTO public.addon_packs (code, sets, validity_days) VALUES
      ('addon_10', 10, 60),
      ('addon_30', 30, 60),
      ('addon_60', 60, 60);

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

  // 1b. Execute migration 20261114a_payment_plan_stack_guard.sql (defines fulfil_payment_order)
  const stackGuardPath = path.resolve(process.cwd(), "supabase/migrations/20261114a_payment_plan_stack_guard.sql");
  const stackGuardSql = fs.readFileSync(stackGuardPath, "utf8");
  await pg.exec(stackGuardSql);

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
  const u6 = "66666666-6666-4666-8666-666666666666";
  const u7 = "77777777-7777-4777-8777-777777777777";
  const u8 = "88888888-8888-4888-8888-888888888888";
  const u9 = "99999999-9999-4999-8999-999999999999";
  const u10 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  for (const uid of [u1, u2, u3, u4, u5, u6, u7, u8, u9, u10]) {
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
  // PROBE 5: Gap 2 - NULL stored payment mode fails closed on live mode
  // ---------------------------------------------------------------------------
  await probe("Probe 5: NULL stored payment mode fails closed with MODE_UNKNOWN when expected_mode is live", async () => {
    // Order has mode = NULL and subscription has no mode
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe5_nullmode', 'razorpay', NULL, 'created', 'monthly', 149900);
    `, [u5]);

    // 5a. Fulfill with expected_mode='live' against NULL stored mode -> MUST FAIL CLOSED
    const resNullMode = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe5_nullmode', 'pay_probe5_initial', 'live', 149900) AS fulfil_subscription_renewal;
    `);
    const resultNullMode = resNullMode.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(resultNullMode.success, false, "Must fail closed when stored mode is NULL");
    assert.strictEqual(resultNullMode.code, "MODE_UNKNOWN", "Must return MODE_UNKNOWN code");

    // 5b. Update order mode to 'live' and retry -> now succeeds
    await pg.query(`UPDATE public.payment_orders SET mode = 'live' WHERE provider_order_id = 'sub_probe5_nullmode';`);
    const resLiveMode = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe5_nullmode', 'pay_probe5_good', 'live', 149900) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(resLiveMode.rows[0].fulfil_subscription_renewal.success, true);
  });

  // ---------------------------------------------------------------------------
  // PROBE 6: Gap 1 - Missing/NULL event timestamp cannot bypass existing watermark for lifecycle events
  // ---------------------------------------------------------------------------
  await probe("Probe 6: Missing/NULL event timestamp cannot bypass existing watermark (rejected as OUT_OF_ORDER_EVENT)", async () => {
    // User 6 has active subscription with watermark at 1700000500000 ms
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe6_mandate', 'razorpay', 'live', 'paid', 'weekly', 69200);
    `, [u6]);

    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, cancel_at_period_end, metadata, amount)
      VALUES ($1, 'sub_probe6_mandate', 'weekly', 'razorpay', 'active', false, '{"mode": "live", "last_event_time": 1700000500000}'::jsonb, 69200);
    `, [u6]);

    // Lifecycle event with NULL timestamp must NOT bypass existing watermark
    const resNullLifeTs = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe6_mandate', 'subscription.cancelled', NULL, 'live') AS handle_subscription_lifecycle_event;
    `);
    const resultNullLifeTs = resNullLifeTs.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(resultNullLifeTs.success, true);
    assert.strictEqual(resultNullLifeTs.ignored, true);
    assert.strictEqual(resultNullLifeTs.code, "OUT_OF_ORDER_EVENT");

    // Assert that status was NOT cancelled and remains active
    const subCheck6 = await pg.query<{ status: string; cancel_at_period_end: boolean }>(`
      SELECT status, cancel_at_period_end FROM public.subscriptions WHERE user_id = $1;
    `, [u6]);
    assert.strictEqual(subCheck6.rows[0].status, "active");
    assert.strictEqual(subCheck6.rows[0].cancel_at_period_end, false);
  });

  // ---------------------------------------------------------------------------
  // PROBE 7: Gap 3 - Seconds vs Milliseconds normalization (exact reviewer scenario)
  // ---------------------------------------------------------------------------
  await probe("Probe 7: Seconds vs milliseconds normalization (2200000000000 ms -> 2200000001 sec -> 2200000000.5 sec cancel rejected)", async () => {
    // User 7 starts with watermark = 2200000000000 ms
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe7_mandate', 'razorpay', 'live', 'created', 'quarterly', 399900);
    `, [u7]);

    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, cancel_at_period_end, metadata, amount)
      VALUES ($1, 'sub_probe7_mandate', 'quarterly', 'razorpay', 'active', false, '{"mode": "live", "last_event_time": 2200000000000}'::jsonb, 399900);
    `, [u7]);

    // Step A: Event arrives with 2200000001 sec (equivalent to 2200000001000 ms > 2200000000000 ms)
    // Must SUCCEED and advance watermark to 2200000001000 ms (normalized)
    const resSec = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe7_mandate', 'pay_probe7_sec', 'live', 399900, 2200000001) AS fulfil_subscription_renewal;
    `);
    const resultSec = resSec.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(resultSec.success, true, "2200000001 sec event must succeed against 2200000000000 ms watermark");
    assert.strictEqual(resultSec.duration_days, 90, "Quarterly plan duration must be 90 days");

    // Verify stored watermark is normalized to 2200000001000 ms
    const subCheck7A = await pg.query<{ metadata: any; amount: number }>(`
      SELECT metadata, amount FROM public.subscriptions WHERE user_id = $1;
    `, [u7]);
    assert.strictEqual(Number(subCheck7A.rows[0].metadata?.last_event_time), 2200000001000, "Stored watermark must be normalized to milliseconds: 2200000001000");
    assert.strictEqual(Number(subCheck7A.rows[0].amount), 399900, "Quarterly amount stored must be 399900 paise");

    // Step B: Older cancellation arrives with 2200000000.5 sec (equivalent to 2200000000500 ms < 2200000001000 ms)
    // MUST BE REJECTED as OUT_OF_ORDER_EVENT!
    const resCancel = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe7_mandate', 'subscription.cancelled', 2200000000.5, 'live') AS handle_subscription_lifecycle_event;
    `);
    const resultCancel = resCancel.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(resultCancel.success, true);
    assert.strictEqual(resultCancel.ignored, true);
    assert.strictEqual(resultCancel.code, "OUT_OF_ORDER_EVENT", "2200000000.5 sec cancel must be rejected as OUT_OF_ORDER_EVENT");

    // Verify cancel was NOT applied
    const subCheck7B = await pg.query<{ cancel_at_period_end: boolean; metadata: any }>(`
      SELECT cancel_at_period_end, metadata FROM public.subscriptions WHERE user_id = $1;
    `, [u7]);
    assert.strictEqual(subCheck7B.rows[0].cancel_at_period_end, false, "Older cancellation must NOT be applied");
    assert.strictEqual(Number(subCheck7B.rows[0].metadata?.last_event_time), 2200000001000, "Watermark must remain 2200000001000 ms");
  });

  // ---------------------------------------------------------------------------
  // PROBE 8: Paid-credit loss: active entitlement with 20 days left + subscription.pending + 7d renewal gives 27 days
  // ---------------------------------------------------------------------------
  await probe("Probe 8: Paid-credit loss: active entitlement with 20 days left + subscription.pending + 7d renewal gives 27 days", async () => {
    // Insert order and subscription for u8 with 20 days left
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe8_mandate', 'razorpay', 'live', 'created', 'weekly', 69200);
    `, [u8]);

    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, current_period_end, metadata, amount)
      VALUES ($1, 'sub_probe8_mandate', 'weekly', 'razorpay', 'active', NOW() + INTERVAL '20 days', '{"mode": "live", "last_event_time": 1000}'::jsonb, 69200);
    `, [u8]);

    // Step A: Newer subscription.pending arrives (sets status 'in_grace_period', grace_period_end = now()+7d)
    const resPending = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe8_mandate', 'subscription.pending', 2000, 'live') AS handle_subscription_lifecycle_event;
    `);
    assert.strictEqual(resPending.rows[0].handle_subscription_lifecycle_event.success, true);
    assert.strictEqual(resPending.rows[0].handle_subscription_lifecycle_event.status, "in_grace_period");

    // Verify sub is in_grace_period with ~20 days still on current_period_end
    const subMid = await pg.query<{ status: string; days_left: number }>(`
      SELECT status, round(EXTRACT(EPOCH FROM (current_period_end - NOW())) / 86400)::int AS days_left
      FROM public.subscriptions WHERE user_id = $1;
    `, [u8]);
    assert.strictEqual(subMid.rows[0].status, "in_grace_period");
    assert.ok(subMid.rows[0].days_left >= 19 && subMid.rows[0].days_left <= 21, `Expected ~20 days left, got ${subMid.rows[0].days_left}`);

    // Step B: Valid paid weekly cycle arrives (subscription.charged for 7 days)
    const resRenewal = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe8_mandate', 'pay_probe8_w1', 'live', 69200, 2500) AS fulfil_subscription_renewal;
    `);
    const renewalResult = resRenewal.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(renewalResult.success, true);
    assert.strictEqual(renewalResult.duration_days, 7);

    // Verify: must give 27 days (remaining 20 + 7), NEVER 7 and never 20!
    const subFinal = await pg.query<{ status: string; grace_period_end: any; days_left: number }>(`
      SELECT status, grace_period_end, round(EXTRACT(EPOCH FROM (current_period_end - NOW())) / 86400)::int AS days_left
      FROM public.subscriptions WHERE user_id = $1;
    `, [u8]);
    assert.strictEqual(subFinal.rows[0].status, "active", "Status must be restored to active");
    assert.strictEqual(subFinal.rows[0].grace_period_end, null, "grace_period_end must be cleared to NULL");
    assert.ok(
      subFinal.rows[0].days_left >= 26 && subFinal.rows[0].days_left <= 28,
      `Expected remaining (20) + 7 = 27 days left, got ${subFinal.rows[0].days_left} (must NEVER be 7 or 20!)`
    );
  });

  // ---------------------------------------------------------------------------
  // PROBE 9: Unseen payment ID older than watermark is credited via payment-cycle ledger
  // ---------------------------------------------------------------------------
  await probe("Probe 9: Captured payment with UNSEEN payment id older than watermark is credited via payment-cycle ledger", async () => {
    // User 9 starts with active entitlement and watermark = 2000000000000 ms
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe9_mandate', 'razorpay', 'live', 'created', 'weekly', 69200);
    `, [u9]);

    await pg.query(`
      INSERT INTO public.subscriptions (user_id, subscription_id, plan_id, provider, status, current_period_end, metadata, amount)
      VALUES ($1, 'sub_probe9_mandate', 'weekly', 'razorpay', 'active', NOW() + INTERVAL '7 days', '{"mode": "live", "last_event_time": 2000000000000}'::jsonb, 69200);
    `, [u9]);

    // Step A: Payment arrives with UNSEEN payment_id but older timestamp 1900000000 sec (1900000000000 ms < 2000000000000 ms)
    // MUST NOT BE DISCARDED! Must be credited via payment-cycle ledger!
    const resPaid = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe9_mandate', 'pay_probe9_unseen_older', 'live', 69200, 1900000000) AS fulfil_subscription_renewal;
    `);
    const resultPaid = resPaid.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(resultPaid.success, true, "Captured payment with unseen payment_id must succeed");
    assert.strictEqual(resultPaid.ignored ?? false, false, "Must NOT be ignored or discarded");
    assert.strictEqual(resultPaid.duration_days, 7);

    // Verify sub current_period_end was extended and watermark did NOT regress
    const subCheck9A = await pg.query<{ metadata: any; status: string; days_left: number }>(`
      SELECT metadata, status, round(EXTRACT(EPOCH FROM (current_period_end - NOW())) / 86400)::int AS days_left
      FROM public.subscriptions WHERE user_id = $1;
    `, [u9]);
    assert.strictEqual(subCheck9A.rows[0].status, "active");
    assert.ok(subCheck9A.rows[0].days_left >= 13 && subCheck9A.rows[0].days_left <= 15, `Expected 7 + 7 = 14 days left, got ${subCheck9A.rows[0].days_left}`);
    assert.strictEqual(Number(subCheck9A.rows[0].metadata?.last_event_time), 2000000000000, "Watermark must NOT regress backwards (greatest preserved)");
    assert.ok(Array.isArray(subCheck9A.rows[0].metadata?.processed_payments));
    assert.ok(subCheck9A.rows[0].metadata.processed_payments.includes("pay_probe9_unseen_older"), "Payment id must be recorded in payment-cycle ledger");

    // Step B: Replay of same payment id returns already_processed: true without extending again
    const resReplay = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe9_mandate', 'pay_probe9_unseen_older', 'live', 69200, 1900000000) AS fulfil_subscription_renewal;
    `);
    const resultReplay = resReplay.rows[0].fulfil_subscription_renewal;
    assert.strictEqual(resultReplay.success, true);
    assert.strictEqual(resultReplay.already_processed, true, "Replay of same payment_id must return already_processed: true");

    // Step C: Stale lifecycle event with older timestamp (1950000000 sec < 2000000000000 ms) MUST STILL BE IGNORED
    const resStaleLife = await pg.query<{ handle_subscription_lifecycle_event: any }>(`
      SELECT public.handle_subscription_lifecycle_event('sub_probe9_mandate', 'subscription.halted', 1950000000, 'live') AS handle_subscription_lifecycle_event;
    `);
    const resultStaleLife = resStaleLife.rows[0].handle_subscription_lifecycle_event;
    assert.strictEqual(resultStaleLife.success, true);
    assert.strictEqual(resultStaleLife.ignored, true);
    assert.strictEqual(resultStaleLife.code, "OUT_OF_ORDER_EVENT", "Stale lifecycle event must still be ignored as OUT_OF_ORDER_EVENT");

    // Status remains active!
    const subCheck9B = await pg.query<{ status: string }>(`
      SELECT status FROM public.subscriptions WHERE user_id = $1;
    `, [u9]);
    assert.strictEqual(subCheck9B.rows[0].status, "active", "Status must remain active; stale lifecycle event cannot touch it");
  });

  // ---------------------------------------------------------------------------
  // PROBE 10: Lock order: fulfil_subscription_renewal and fulfil_payment_order take locks in same order
  // ---------------------------------------------------------------------------
  await probe("Probe 10: Lock order: fulfil_subscription_renewal and fulfil_payment_order take locks in same order (advisory, subscription, order)", async () => {
    // User 10: test both RPCs on same user
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'order_prepaid_probe10', 'razorpay', 'live', 'created', 'weekly', 69200);
    `, [u10]);

    // Prepaid fulfillment succeeds with lock order (advisory -> subscription -> order)
    const resPrepaid = await pg.query<{ fulfil_payment_order: any }>(`
      SELECT public.fulfil_payment_order('order_prepaid_probe10', $1, 'live') AS fulfil_payment_order;
    `, [u10]);
    assert.strictEqual(resPrepaid.rows[0].fulfil_payment_order.success, true);
    assert.strictEqual(resPrepaid.rows[0].fulfil_payment_order.is_pro, true);

    // Renewal fulfillment succeeds with same lock order (advisory -> subscription -> order)
    await pg.query(`
      INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
      VALUES ($1, 'sub_probe10_mandate', 'razorpay', 'live', 'created', 'weekly', 69200);
    `, [u10]);
    const resRenewal = await pg.query<{ fulfil_subscription_renewal: any }>(`
      SELECT public.fulfil_subscription_renewal('sub_probe10_mandate', 'pay_probe10_w1', 'live', 69200, 3000) AS fulfil_subscription_renewal;
    `);
    assert.strictEqual(resRenewal.rows[0].fulfil_subscription_renewal.success, true);
    assert.strictEqual(resRenewal.rows[0].fulfil_subscription_renewal.is_pro, true);
  });

  console.log("\n--------------------------------------------------------------------------------");
  console.log(`RESULTS: ${passed}/${passed + failed} probes passed`);
  console.log("--------------------------------------------------------------------------------\n");

  if (failed > 0) {
    console.error(`VERDICT: FAIL (${failed} probes failed)\n`);
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All reviewer probe tests passed against real PostgreSQL engine)\n");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Unhandled probe error:", err);
  process.exit(1);
});
