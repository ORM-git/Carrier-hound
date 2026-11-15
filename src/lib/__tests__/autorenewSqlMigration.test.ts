import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import path from "path";

describe("PostgreSQL Migration & Actual SQL Mandate Safety (Requirement 7 & PR #627 Review)", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();

    // 1. Create standard Supabase roles if not present
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text
      );

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;

      CREATE TABLE public.plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text UNIQUE NOT NULL,
        name text NOT NULL,
        price_paise int NOT NULL,
        duration_days int NOT NULL,
        currency text NOT NULL DEFAULT 'INR',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      INSERT INTO public.plans (code, name, price_paise, duration_days)
      VALUES
        ('weekly', 'Weekly Pro', 69200, 7),
        ('monthly', 'Monthly Pro', 149900, 30),
        ('quarterly', 'Quarterly Pro', 399900, 90);

      CREATE TABLE public.subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        provider text NOT NULL,
        subscription_id text,
        plan_id text,
        currency text DEFAULT 'INR',
        amount integer,
        status text DEFAULT 'active',
        current_period_start timestamptz DEFAULT now(),
        current_period_end timestamptz,
        grace_period_end timestamptz,
        cancel_at_period_end boolean DEFAULT false,
        updated_at timestamptz,
        created_at timestamptz DEFAULT now(),
        metadata jsonb DEFAULT '{}'::jsonb
      );

      -- REAL REPO BASELINE SCHEMA:
      -- payment_orders has NO updated_at and NO recurring_kind originally!
      CREATE TABLE public.payment_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        provider text NOT NULL DEFAULT 'razorpay',
        provider_order_id text UNIQUE,
        plan_code text REFERENCES public.plans(code),
        addon_code text,
        amount_paise int NOT NULL,
        currency text NOT NULL DEFAULT 'INR',
        status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired')),
        created_at timestamptz NOT NULL DEFAULT now(),
        paid_at timestamptz,
        mode text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE public.user_addon_credits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        addon_code text NOT NULL,
        sets_remaining int NOT NULL DEFAULT 1,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE public.blocked_users (
        user_id uuid PRIMARY KEY,
        reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }, 30000);

  afterEach(async () => {
    if (pg) {
      await pg.close();
    }
  });

  it("Reviewer 1: payment_orders.updated_at does not exist in baseline schema; migration adds it and runs create/cancel end-to-end", async () => {
    const testUserId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    // Verify baseline table has NO updated_at column before migration
    const colsBefore = await pg.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = 'updated_at';
    `);
    expect(colsBefore.rows.length).toBe(0);

    // Apply migration 20261115b
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Verify updated_at column was added
    const colsAfter = await pg.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = 'updated_at';
    `);
    expect(colsAfter.rows.length).toBe(1);

    // End-to-end reservation create and cancel test on real table
    const reservationId = `sub_pending_${testUserId}_attempt1`;
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
      VALUES ('${testUserId}', 'razorpay', '${reservationId}', 'monthly', 149900, 'reserved', 'live', 'recurring');
    `);

    // Complete CAS to 'created'
    const realSubId = "sub_rzp_e2e_real_001";
    await pg.exec(`
      UPDATE public.payment_orders
      SET provider_order_id = '${realSubId}', status = 'created', updated_at = now()
      WHERE provider_order_id = '${reservationId}' AND user_id = '${testUserId}' AND status = 'reserved';
    `);

    // Seed subscription row
    await pg.exec(`
      INSERT INTO public.subscriptions (user_id, provider, subscription_id, plan_id, status)
      VALUES ('${testUserId}', 'razorpay', '${realSubId}', 'monthly', 'active');
    `);

    // Call cancel_autorenew_subscription RPC end to end
    const cancelResult = await pg.query<{ cancel_autorenew_subscription: boolean }>(`
      SELECT public.cancel_autorenew_subscription(
        '${testUserId}'::uuid,
        '${realSubId}',
        '{"canceled_by": "customer"}'::jsonb
      );
    `);
    expect(cancelResult.rows[0].cancel_autorenew_subscription).toBe(true);

    // Verify updated_at and status in payment_orders
    const orderCheck = await pg.query<any>(`
      SELECT status, updated_at FROM public.payment_orders WHERE provider_order_id = '${realSubId}';
    `);
    expect(orderCheck.rows[0].status).toBe("cancelled");
    expect(orderCheck.rows[0].updated_at).not.toBeNull();

    // Verify subscriptions record
    const subCheck = await pg.query<any>(`
      SELECT cancel_at_period_end, updated_at FROM public.subscriptions WHERE user_id = '${testUserId}';
    `);
    expect(subCheck.rows[0].cancel_at_period_end).toBe(true);
    expect(subCheck.rows[0].updated_at).not.toBeNull();
  });

  it("Reviewer 2: cancel_autorenew_subscription(sub_old) must NOT mark a newer bound subscription as canceled", async () => {
    const testUserId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
    const oldPendingMandate = "sub_old_pending_mandate";
    const newBoundMandate = "sub_new_active_mandate";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Seed active bound subscription with subscription_id = sub_new
    // and metadata containing pending_subscription_id = sub_old
    await pg.exec(`
      INSERT INTO public.subscriptions (
        user_id,
        provider,
        subscription_id,
        status,
        cancel_at_period_end,
        metadata
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${newBoundMandate}',
        'active',
        false,
        '{"pending_subscription_id": "${oldPendingMandate}", "processed_payments": ["pay_001"]}'::jsonb
      );

      -- Old pending mandate has its own payment_order
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
      VALUES ('${testUserId}', 'razorpay', '${oldPendingMandate}', 'weekly', 69200, 'created', 'live', 'recurring');

      -- New mandate also has its own payment_order
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
      VALUES ('${testUserId}', 'razorpay', '${newBoundMandate}', 'monthly', 149900, 'paid', 'live', 'recurring');
    `);

    // Cancel old mandate
    const cancelRes = await pg.query<{ cancel_autorenew_subscription: boolean }>(`
      SELECT public.cancel_autorenew_subscription(
        '${testUserId}'::uuid,
        '${oldPendingMandate}',
        '{"canceled_by": "customer"}'::jsonb
      );
    `);
    expect(cancelRes.rows[0].cancel_autorenew_subscription).toBe(true);

    // Verify subscription row:
    // The newer bound subscription MUST NOT be canceled!
    const subCheck = await pg.query<any>(`
      SELECT subscription_id, cancel_at_period_end FROM public.subscriptions WHERE user_id = '${testUserId}';
    `);
    expect(subCheck.rows[0].subscription_id).toBe(newBoundMandate);
    expect(subCheck.rows[0].cancel_at_period_end).toBe(false);

    // The old pending payment order MUST be cancelled
    const oldOrderCheck = await pg.query<any>(`
      SELECT status FROM public.payment_orders WHERE provider_order_id = '${oldPendingMandate}';
    `);
    expect(oldOrderCheck.rows[0].status).toBe("cancelled");
  });

  it("Reviewer 6: merge_subscription_metadata merges JSON keys transactionally without overwriting concurrent ledger entries", async () => {
    const testUserId = "c1eebc99-9c0b-4ef8-bb6d-6bb9bd380c33";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Seed subscription with existing webhook ledger entry
    await pg.exec(`
      INSERT INTO public.subscriptions (user_id, provider, subscription_id, status, metadata)
      VALUES (
        '${testUserId}',
        'razorpay',
        'sub_active_123',
        'active',
        '{"processed_payments": ["pay_001", "pay_002"], "ledger_seq": 42}'::jsonb
      );
    `);

    // Call merge_subscription_metadata with new pending mandate data
    await pg.exec(`
      SELECT public.merge_subscription_metadata(
        '${testUserId}'::uuid,
        '{"pending_subscription_id": "sub_next_456", "provider_current_start": "2026-11-15T00:00:00Z"}'::jsonb
      );
    `);

    const subCheck = await pg.query<any>(`
      SELECT metadata FROM public.subscriptions WHERE user_id = '${testUserId}';
    `);
    const meta = subCheck.rows[0].metadata;

    // Both old ledger entries and new pending keys must be present!
    expect(meta.processed_payments).toEqual(["pay_001", "pay_002"]);
    expect(meta.ledger_seq).toBe(42);
    expect(meta.pending_subscription_id).toBe("sub_next_456");
    expect(meta.provider_current_start).toBe("2026-11-15T00:00:00Z");
  });

  it("Reviewer 7: fulfil_subscription_renewal consumes provider period bounds from order metadata and grants exact 7/30/90 days", async () => {
    const testUserId = "d1eebc99-9c0b-4ef8-bb6d-6bb9bd380d44";
    const subId = "sub_rzp_renewal_test_777";
    const payId = "pay_rzp_renewal_test_888";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Brand-new subscription order with provider period bounds persisted in metadata
    const providerStart = "2026-11-15T12:00:00Z";
    const providerEnd = "2026-12-16T12:00:00Z"; // 31 days calendar month from provider
    await pg.exec(`
      INSERT INTO public.payment_orders (
        user_id,
        provider,
        provider_order_id,
        plan_code,
        amount_paise,
        status,
        mode,
        recurring_kind,
        metadata
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${subId}',
        'monthly',
        149900,
        'created',
        'live',
        'recurring',
        '{"provider_current_start": "${providerStart}", "provider_current_end": "${providerEnd}"}'::jsonb
      );
    `);

    // Fulfil renewal payment
    const fulfilRes = await pg.query<any>(`
      SELECT public.fulfil_subscription_renewal(
        '${subId}',
        '${payId}',
        'live',
        149900,
        1700000000
      ) as res;
    `);

    const result = fulfilRes.rows[0].res;
    expect(result.success).toBe(true);
    expect(result.is_pro).toBe(true);
    // Strict fixed 7/30/90-day rule: duration is exact 30 days, not calendar 31
    expect(result.duration_days).toBe(30);

    // Verify subscription row consumed provider period bounds
    const subCheck = await pg.query<any>(`
      SELECT current_period_start, current_period_end, metadata FROM public.subscriptions WHERE user_id = '${testUserId}';
    `);
    expect(new Date(subCheck.rows[0].current_period_start).toISOString()).toBe(new Date(providerStart).toISOString());
    expect(subCheck.rows[0].metadata.provider_current_start).toBe(providerStart);
    expect(subCheck.rows[0].metadata.provider_current_end).toBe(providerEnd);
  });

  it("Reviewer 7 & 8: enforces valid-mode NOT NULL constraint, rejects literal NULL mode insert, and enforces unique index under concurrent sessions", async () => {
    const testUserId = "e1eebc99-9c0b-4ef8-bb6d-6bb9bd380e55";

    // Seed order with literal NULL mode before migration
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES ('${testUserId}', 'razorpay', 'sub_legacy_null_mode', 'weekly', 69200, 'created', NULL);
    `);

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Verify legacy NULL mode was normalized to 'live'
    const modeCheck = await pg.query<any>(`
      SELECT mode FROM public.payment_orders WHERE provider_order_id = 'sub_legacy_null_mode';
    `);
    expect(modeCheck.rows[0].mode).toBe("live");

    // Reviewer 7: Make the NULL-mode test really insert NULL after migration and assert rejection
    let nullInsertErr: any = null;
    try {
      await pg.exec(`
        INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
        VALUES ('${testUserId}', 'razorpay', 'sub_null_mode_rejected', 'monthly', 149900, 'reserved', NULL, 'recurring');
      `);
    } catch (err: any) {
      nullInsertErr = err;
    }
    expect(nullInsertErr).not.toBeNull();
    expect(String(nullInsertErr)).toMatch(/null value in column "mode".*violates not-null constraint/i);

    // Also assert invalid mode value rejection
    let invalidModeErr: any = null;
    try {
      await pg.exec(`
        INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
        VALUES ('${testUserId}', 'razorpay', 'sub_invalid_mode_rejected', 'monthly', 149900, 'reserved', 'staging', 'recurring');
      `);
    } catch (err: any) {
      invalidModeErr = err;
    }
    expect(invalidModeErr).not.toBeNull();
    expect(String(invalidModeErr)).toMatch(/check_payment_orders_mode_valid|violates check constraint/i);

    // Mark previous order expired so user can start fresh reservation
    await pg.exec(`
      UPDATE public.payment_orders SET status = 'expired' WHERE provider_order_id = 'sub_legacy_null_mode';
    `);

    // Concurrent-session test simulation:
    // Session 1 reserves mandate (succeeds)
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
      VALUES ('${testUserId}', 'razorpay', 'sub_concurrent_session_1', 'monthly', 149900, 'reserved', 'live', 'recurring');
    `);

    // Session 2 concurrent attempt for same user/provider/mode must fail with unique collision
    let session2Error: any = null;
    try {
      await pg.exec(`
        INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind)
        VALUES ('${testUserId}', 'razorpay', 'sub_concurrent_session_2', 'monthly', 149900, 'reserved', 'live', 'recurring');
      `);
    } catch (err: any) {
      session2Error = err;
    }
    expect(session2Error).not.toBeNull();
    expect(String(session2Error)).toContain("duplicate key value violates unique constraint");
  });

  it("Item 4: equal-timestamp paid event must NOT reset cancel_at_period_end to false", async () => {
    const testUserId = "c1eebc99-9c0b-4ef8-bb6d-6bb9bd380c44";
    const subId = "sub_equal_watermark_001";
    const payId = "pay_equal_watermark_001";
    const watermarkMs = 1710000000000;

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Seed subscription with cancel_at_period_end = true and watermark
    await pg.exec(`
      INSERT INTO public.subscriptions (
        user_id, provider, subscription_id, plan_id, status,
        current_period_start, current_period_end, cancel_at_period_end, metadata
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${subId}',
        'monthly',
        'active',
        now() - interval '10 days',
        now() + interval '20 days',
        true,
        '{"last_event_time": ${watermarkMs}}'::jsonb
      );
    `);

    // Seed created order
    await pg.exec(`
      INSERT INTO public.payment_orders (
        user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${subId}',
        'monthly',
        149900,
        'created',
        'live',
        'recurring'
      );
    `);

    // Fulfil renewal with EXACT SAME watermark timestamp
    const fulfilRes = await pg.query<any>(`
      SELECT public.fulfil_subscription_renewal(
        '${subId}',
        '${payId}',
        'live',
        149900,
        ${watermarkMs}
      ) as result;
    `);

    const resJson = fulfilRes.rows[0].result;
    expect(resJson.success).toBe(true);

    // Assert cancel_at_period_end remains TRUE!
    const subCheck = await pg.query<any>(`
      SELECT cancel_at_period_end, metadata FROM public.subscriptions WHERE subscription_id = '${subId}';
    `);
    expect(subCheck.rows[0].cancel_at_period_end).toBe(true);
    expect(subCheck.rows[0].metadata.processed_payments).toContain(payId);
  });

  it("Item 8: entitlement duration guarantees fixed 30 days floor against calendar months (e.g. Feb 28 days)", async () => {
    const testUserId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b33";
    const subId = "sub_calendar_feb_001";
    const payId = "pay_calendar_feb_001";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Set base time as Feb 1, 2026 00:00:00 UTC (a 28-day month)
    const feb1 = "2026-02-01T00:00:00.000Z";
    // Calendar month end would be March 1 (28 days)
    const providerFebEnd = "2026-03-01T00:00:00.000Z";

    await pg.exec(`
      INSERT INTO public.subscriptions (
        user_id, provider, subscription_id, plan_id, status,
        current_period_start, current_period_end, cancel_at_period_end, metadata
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${subId}',
        'monthly',
        'active',
        '${feb1}'::timestamptz,
        '${feb1}'::timestamptz,
        false,
        '{}'::jsonb
      );
    `);

    await pg.exec(`
      INSERT INTO public.payment_orders (
        user_id, provider, provider_order_id, plan_code, amount_paise, status, mode, recurring_kind, metadata
      ) VALUES (
        '${testUserId}',
        'razorpay',
        '${subId}',
        'monthly',
        149900,
        'created',
        'live',
        'recurring',
        '{"provider_current_start": "${feb1}", "provider_current_end": "${providerFebEnd}"}'::jsonb
      );
    `);

    const fulfilRes = await pg.query<any>(`
      SELECT public.fulfil_subscription_renewal(
        '${subId}',
        '${payId}',
        'live',
        149900,
        1706745600
      ) as result;
    `);

    expect(fulfilRes.rows[0].result.success).toBe(true);

    const subCheck = await pg.query<any>(`
      SELECT current_period_end, metadata FROM public.subscriptions WHERE subscription_id = '${subId}';
    `);

    // The subscription period must be at least 30 days from now (or base), extending past the 28-day calendar month
    const endMs = new Date(subCheck.rows[0].current_period_end).getTime();
    const nowMs = Date.now();
    // Guarantee at least 30 days (minus 5 seconds execution delta)
    expect(endMs - nowMs).toBeGreaterThanOrEqual((30 * 86400 - 5) * 1000);
  });

  it("Reviewer 5: record_subscription_reconciliation persists durable reconciliation record", async () => {
    const testUserId = "f1eebc99-9c0b-4ef8-bb6d-6bb9bd380f66";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    await pg.exec(`
      INSERT INTO auth.users (id) VALUES ('${testUserId}') ON CONFLICT DO NOTHING;
    `);

    const recIdRes = await pg.query<any>(`
      SELECT public.record_subscription_reconciliation(
        '${testUserId}'::uuid,
        'sub_orphan_123',
        'sub_pending_res_456',
        'resolved',
        'CAS_PREEMPTED',
        'cancelled_at_provider_cas_preempted',
        '{"plan_code": "monthly"}'::jsonb
      ) as id;
    `);
    const recordId = recIdRes.rows[0].id;
    expect(recordId).not.toBeNull();

    const recordCheck = await pg.query<any>(`
      SELECT * FROM public.subscription_reconciliations WHERE id = '${recordId}';
    `);
    expect(recordCheck.rows[0].user_id).toBe(testUserId);
    expect(recordCheck.rows[0].provider_subscription_id).toBe("sub_orphan_123");
    expect(recordCheck.rows[0].reconciliation_state).toBe("resolved");
    expect(recordCheck.rows[0].recovery_outcome).toBe("cancelled_at_provider_cas_preempted");
  });
});
