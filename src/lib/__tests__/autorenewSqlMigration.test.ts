import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import path from "path";

describe("PostgreSQL Migration & Actual SQL Mandate Safety (Requirement 7)", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();

    // 1. Set up base schema for subscriptions and payment_orders
    await pg.exec(`
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

      CREATE TABLE public.payment_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        provider text NOT NULL,
        provider_order_id text NOT NULL,
        plan_code text,
        amount_paise integer,
        currency text DEFAULT 'INR',
        status text NOT NULL,
        mode text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz,
        metadata jsonb DEFAULT '{}'::jsonb
      );
    `);
  });

  afterEach(async () => {
    if (pg) {
      await pg.close();
    }
  });

  it("applies migration cleanly when multiple existing prepaid created orders exist without blocking or failing", async () => {
    const testUserId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    // Seed multiple existing prepaid orders with status = 'created' for the same user and mode
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES
        ('${testUserId}', 'razorpay', 'order_prepaid_001', 'monthly', 149900, 'created', 'test'),
        ('${testUserId}', 'razorpay', 'order_prepaid_002', 'weekly', 69200, 'created', 'test'),
        ('${testUserId}', 'razorpay', 'order_prepaid_003', 'quarterly', 399900, 'created', 'test');
    `);

    // Verify multiple prepaid created orders exist
    const initialOrders = await pg.query<{ count: string }>(
      `SELECT count(*) FROM public.payment_orders WHERE user_id = $1 AND status = 'created';`,
      [testUserId]
    );
    expect(Number(initialOrders.rows[0].count)).toBe(3);

    // Read and execute the actual migration file
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );

    // Must execute cleanly without error
    await pg.exec(migrationSql);

    // 1. Verify prepaid orders are still intact and NOT deleted
    const postMigrateOrders = await pg.query<{ count: string }>(
      `SELECT count(*) FROM public.payment_orders WHERE user_id = $1 AND status = 'created';`,
      [testUserId]
    );
    expect(Number(postMigrateOrders.rows[0].count)).toBe(3);

    // 2. Verify inserting ANOTHER prepaid created order for the same user and mode still succeeds
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES ('${testUserId}', 'razorpay', 'order_prepaid_004', 'monthly', 149900, 'created', 'test');
    `);

    const updatedPrepaid = await pg.query<{ count: string }>(
      `SELECT count(*) FROM public.payment_orders WHERE user_id = $1 AND status = 'created';`,
      [testUserId]
    );
    expect(Number(updatedPrepaid.rows[0].count)).toBe(4);
  });

  it("enforces partial unique index on recurring reservations per user and mode, and allows retry after failed state", async () => {
    const testUserId = "b1ffcd88-8b1a-4ef8-bb6d-6bb9bd380b22";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // 1. Insert first reservation attempt in 'reserved' state
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES ('${testUserId}', 'razorpay', 'sub_pending_${testUserId}_attempt1', 'monthly', 149900, 'reserved', 'test');
    `);

    // 2. Attempting a concurrent second reservation in 'reserved' state must fail with unique collision
    let collisionError: any = null;
    try {
      await pg.exec(`
        INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
        VALUES ('${testUserId}', 'razorpay', 'sub_pending_${testUserId}_attempt2', 'monthly', 149900, 'reserved', 'test');
      `);
    } catch (err: any) {
      collisionError = err;
    }
    expect(collisionError).not.toBeNull();
    expect(String(collisionError)).toContain("duplicate key value violates unique constraint");

    // 3. Mark the first attempt failed
    await pg.exec(`
      UPDATE public.payment_orders
      SET status = 'failed'
      WHERE provider_order_id = 'sub_pending_${testUserId}_attempt1';
    `);

    // 4. Retry after failure: inserting attempt 2 in 'reserved' state now SUCCEEDS
    await pg.exec(`
      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES ('${testUserId}', 'razorpay', 'sub_pending_${testUserId}_attempt2', 'monthly', 149900, 'reserved', 'test');
    `);

    const reservations = await pg.query<{ provider_order_id: string; status: string }>(
      `SELECT provider_order_id, status FROM public.payment_orders WHERE user_id = $1 ORDER BY created_at ASC;`,
      [testUserId]
    );
    expect(reservations.rows.length).toBe(2);
    expect(reservations.rows[0].status).toBe("failed");
    expect(reservations.rows[1].status).toBe("reserved");
  });

  it("atomic cancel_autorenew_subscription merges metadata without clobbering concurrent ledger entries", async () => {
    const testUserId = "c2eebc99-7c0b-4ef8-bb6d-6bb9bd380c33";
    const mandateId = "sub_rzp_live_mandate_8888";

    // Apply migration
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/migrations/20261115b_autorenew_mandate_safety.sql"),
      "utf8"
    );
    await pg.exec(migrationSql);

    // Seed active subscription with existing processed ledger data
    await pg.exec(`
      INSERT INTO public.subscriptions (user_id, provider, subscription_id, status, metadata)
      VALUES (
        '${testUserId}',
        'razorpay',
        '${mandateId}',
        'active',
        '{"processed_payments": ["pay_001", "pay_002"], "renewal_seq": 2}'::jsonb
      );

      INSERT INTO public.payment_orders (user_id, provider, provider_order_id, plan_code, amount_paise, status, mode)
      VALUES ('${testUserId}', 'razorpay', '${mandateId}', 'monthly', 149900, 'created', 'live');
    `);

    // Call atomic CAS procedure
    const rpcRes = await pg.query<{ cancel_autorenew_subscription: boolean }>(`
      SELECT public.cancel_autorenew_subscription(
        '${testUserId}'::uuid,
        '${mandateId}',
        '{"canceled_by": "customer", "cancel_reason": "switched_job"}'::jsonb
      );
    `);
    expect(rpcRes.rows[0].cancel_autorenew_subscription).toBe(true);

    // Verify subscriptions record
    const subRes = await pg.query<any>(
      `SELECT cancel_at_period_end, metadata FROM public.subscriptions WHERE user_id = $1;`,
      [testUserId]
    );
    expect(subRes.rows[0].cancel_at_period_end).toBe(true);
    const meta = subRes.rows[0].metadata;

    // Must retain existing keys (no ledger clobbering)
    expect(meta.processed_payments).toEqual(["pay_001", "pay_002"]);
    expect(meta.renewal_seq).toBe(2);
    // Must contain new keys
    expect(meta.canceled_by).toBe("customer");
    expect(meta.cancel_reason).toBe("switched_job");

    // Verify payment_orders was marked cancelled
    const orderRes = await pg.query<any>(
      `SELECT status FROM public.payment_orders WHERE provider_order_id = $1;`,
      [mandateId]
    );
    expect(orderRes.rows[0].status).toBe("cancelled");
  });
});
