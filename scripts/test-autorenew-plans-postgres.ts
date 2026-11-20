/**
 * scripts/test-autorenew-plans-postgres.ts
 *
 * REAL PostgreSQL check of auto-renew for the Rs 399 weekly, Rs 499 monthly and Rs 2,199 quarterly plans:
 * applies 20261115a_autorenew.sql + 20261120b_autorenew_paused_resumed.sql to a disposable local cluster and
 * drives the two webhook RPCs the way the webhook does.
 *
 * Same safety posture as scripts/test-10m-schema-step1-postgres.ts: initdb into a fresh temp directory,
 * 127.0.0.1 only, random port, trust auth, deleted afterwards. Never takes a connection URL and ignores
 * PG* / DATABASE_URL. Nothing is ever applied to Supabase.
 *
 * Prerequisites (local only; nothing added to package.json):
 *   - PostgreSQL server binaries (initdb, pg_ctl) on PATH or in PG_BIN
 *   - node-postgres: npm install --no-save pg@8
 *
 * Exit: 0 all checks passed; 1 a check failed; 2 environment refused / prerequisites missing.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

const refuse = (msg: string): never => {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
};
if (process.argv.slice(2).some((a) => /^--(url|host|connection|database-url|dsn)\b/i.test(a) || /^postgres(ql)?:\/\//i.test(a))) {
  refuse("this runner never connects to a given database or URL; it only uses a cluster it creates itself.");
}
for (const k of ["DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE"]) delete process.env[k];

function findBin(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [process.env.PG_BIN, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean) as string[];
  for (const d of dirs) if (fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  return refuse(`${exe} not found. Put PostgreSQL server binaries on PATH or set PG_BIN.`);
}
let PgClient: any;
// pg is an optional local-only dependency, so it is loaded lazily instead of imported
// eslint-disable-next-line @typescript-eslint/no-var-requires
try { PgClient = require("pg").Client; } catch { refuse("node-postgres missing. Install it without touching package.json: npm install --no-save pg@8"); }
const INITDB = findBin("initdb");
const PG_CTL = findBin("pg_ctl");

const MIG_DIR = path.resolve(__dirname, "../supabase/migrations");
const BASE_MIGRATION = fs.readFileSync(path.join(MIG_DIR, "20261115a_autorenew.sql"), "utf8");
const TARGET_MIGRATION = fs.readFileSync(path.join(MIG_DIR, "20261120b_autorenew_paused_resumed.sql"), "utf8");

// Minimal shapes of the tables the two migrations read and write (columns per their pre-flight checks)
const BASELINE = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE TABLE public.plans (code text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, price_paise int NOT NULL, duration_days int NOT NULL);
  CREATE TABLE public.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE NOT NULL, subscription_id text, plan_id text,
    provider text, status text, current_period_start timestamptz, current_period_end timestamptz,
    cancel_at_period_end boolean DEFAULT false, grace_period_end timestamptz, metadata jsonb NOT NULL DEFAULT '{}',
    currency text, amount numeric, updated_at timestamptz, created_at timestamptz DEFAULT now());
  CREATE TABLE public.payment_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, provider_order_id text, provider text,
    mode text, status text, plan_code text, addon_code text, amount_paise int, currency text DEFAULT 'INR',
    paid_at timestamptz, created_at timestamptz DEFAULT now());
  CREATE TABLE public.blocked_users (user_id uuid PRIMARY KEY);
  CREATE TABLE public.user_addon_credits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, pack_code text,
    sets_total int, sets_remaining int, expires_at timestamptz, order_id uuid UNIQUE, created_at timestamptz);
  CREATE TABLE public.addon_packs (code text PRIMARY KEY, sets int, validity_days int);
  CREATE TABLE public.webhook_events (event_id text PRIMARY KEY, provider text, event_type text);
  INSERT INTO public.plans (code, price_paise, duration_days) VALUES ('weekly', 39900, 7), ('monthly', 49900, 30), ('quarterly', 219900, 90);
`;

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { failed++; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cm-autorenew-plans-"));
  const dataDir = path.join(base, "data");
  const init = spawnSync(INITDB, ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-instructions"], { encoding: "utf8" });
  if (init.status !== 0) refuse(`initdb failed: ${(init.stderr || init.stdout).slice(0, 400)}`);
  const port = await freePort();
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`;
  // stdio "ignore": otherwise spawnSync never returns on Windows (postmaster inherits the pipes)
  const start = spawnSync(PG_CTL, ["-D", dataDir, "-o", opts, "-l", path.join(base, "server.log"), "-w", "-t", "60", "start"], { stdio: "ignore" });
  if (start.status !== 0) refuse(`pg_ctl start failed (status ${start.status})`);
  const stop = () => {
    spawnSync(PG_CTL, ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
    fs.rmSync(base, { recursive: true, force: true }); // our own mkdtemp directory only
  };

  const db = new PgClient({ host: "127.0.0.1", port, user: "postgres", database: "postgres", application_name: "autorenew-plans" });
  try {
    await db.connect();
    const where = (await db.query(`SELECT current_setting('data_directory') d, inet_server_addr()::text a`)).rows[0];
    if (path.resolve(where.d).toLowerCase() !== path.resolve(dataDir).toLowerCase() || !String(where.a).startsWith("127.0.0.1")) {
      refuse("connected server is not the disposable cluster");
    }

    const rpc = async (fn: string, args: unknown[]) => {
      const ph = args.map((_, i) => `$${i + 1}`).join(", ");
      return (await db.query(`SELECT public.${fn}(${ph}) AS r`, args)).rows[0].r;
    };
    const renew = (subId: string, paymentId: string, amount: number | null, ts: number, mode = "live") =>
      rpc("fulfil_subscription_renewal", [subId, paymentId, mode, amount, ts]);
    const lifecycle = (subId: string, event: string, ts: number | null) =>
      rpc("handle_subscription_lifecycle_event", [subId, event, ts, "live"]);
    const subRow = async (userId: string) => (await db.query(`SELECT * FROM public.subscriptions WHERE user_id = $1`, [userId])).rows[0];
    const daysLeft = (end: Date) => Math.round((end.getTime() - Date.now()) / 86_400_000);
    const newUser = async (subId: string, planCode: string, amount: number, mode = "live") => {
      const user = (await db.query(`SELECT gen_random_uuid()::text id`)).rows[0].id;
      await db.query(
        `INSERT INTO public.payment_orders (user_id, provider_order_id, provider, mode, status, plan_code, amount_paise)
         VALUES ($1, $2, 'razorpay', $3, 'created', $4, $5)`,
        [user, subId, mode, planCode, amount]
      );
      return user;
    };

    await check("pre-check refuses 20261120b when 20261115a is not applied", async () => {
      await db.query(BASELINE);
      await assert.rejects(db.query(TARGET_MIGRATION), /apply 20261115a_autorenew\.sql first/);
      await db.query("ROLLBACK").catch(() => {});
    });

    await check("20261115a then 20261120b apply cleanly, and 20261120b re-applies as a no-op", async () => {
      await db.query(BASE_MIGRATION);
      await db.query(TARGET_MIGRATION);
      await db.query(TARGET_MIGRATION);
      const def = (await db.query(
        `SELECT pg_get_functiondef('public.handle_subscription_lifecycle_event(text, text, numeric, text)'::regprocedure) d`
      )).rows[0].d;
      assert.ok(def.includes("subscription.paused") && def.includes("subscription.resumed"));
    });

    await check("only service_role can execute the lifecycle RPC", async () => {
      const sig = "public.handle_subscription_lifecycle_event(text, text, numeric, text)";
      const r = (await db.query(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u,
                has_function_privilege('service_role', $1, 'EXECUTE') s`, [sig]
      )).rows[0];
      assert.deepStrictEqual([r.a, r.u, r.s], [false, false, true]);
    });

    const t0 = 1_800_000_000; // Razorpay created_at, seconds
    for (const plan of [
      { code: "weekly", amount: 39900, days: 7 },
      { code: "monthly", amount: 49900, days: 30 },
      { code: "quarterly", amount: 219900, days: 90 },
    ]) {
      await check(`${plan.code}: activated grants ${plan.days} days, charged adds ${plan.days} more, replays add nothing`, async () => {
        const subId = `sub_${plan.code}_cycle`;
        const user = await newUser(subId, plan.code, plan.amount);

        const first = await renew(subId, `pay_${plan.code}_1`, plan.amount, t0);
        assert.strictEqual(first.success, true, JSON.stringify(first));
        assert.strictEqual(first.duration_days, plan.days);
        let row = await subRow(user);
        assert.strictEqual(row.plan_id, plan.code);
        assert.strictEqual(Number(row.amount), plan.amount);
        assert.strictEqual(row.status, "active");
        assert.strictEqual(daysLeft(row.current_period_end), plan.days);

        const replay = await renew(subId, `pay_${plan.code}_1`, plan.amount, t0);
        assert.strictEqual(replay.already_processed, true);
        assert.strictEqual(daysLeft((await subRow(user)).current_period_end), plan.days);

        await renew(subId, `pay_${plan.code}_2`, plan.amount, t0 + 60);
        row = await subRow(user);
        assert.strictEqual(daysLeft(row.current_period_end), plan.days * 2);
        assert.deepStrictEqual(row.metadata.processed_payments, [`pay_${plan.code}_1`, `pay_${plan.code}_2`]);
      });

      await check(`${plan.code}: a charge for another plan's price is refused`, async () => {
        const subId = `sub_${plan.code}_wrong_amount`;
        const user = await newUser(subId, plan.code, plan.amount);
        const res = await renew(subId, `pay_${plan.code}_wrong`, plan.amount === 49900 ? 39900 : 49900, t0);
        assert.strictEqual(res.code, "PLAN_AMOUNT_MISMATCH");
        assert.strictEqual(await subRow(user), undefined);
      });
    }

    await check("test mode: a quarterly cycle marks the order paid and grants no access", async () => {
      const user = await newUser("sub_quarterly_test", "quarterly", 219900, "test");
      const res = await renew("sub_quarterly_test", "pay_q_test", 219900, t0, "test");
      assert.deepStrictEqual([res.success, res.test_mode, res.is_pro], [true, true, false]);
      assert.strictEqual(await subRow(user), undefined);
    });

    await check("paused keeps paid time and stops renewal; resumed turns renewal back on; replays and older events change nothing", async () => {
      const subId = "sub_quarterly_lifecycle";
      const user = await newUser(subId, "quarterly", 219900);
      await renew(subId, "pay_q_life_1", 219900, t0);
      const paidEnd = (await subRow(user)).current_period_end.getTime();

      const paused = await lifecycle(subId, "subscription.paused", t0 + 100);
      assert.strictEqual(paused.applied, true, JSON.stringify(paused));
      let row = await subRow(user);
      assert.deepStrictEqual([row.status, row.cancel_at_period_end], ["active", true]);
      assert.strictEqual(row.current_period_end.getTime(), paidEnd);

      const stale = await lifecycle(subId, "subscription.resumed", t0 + 50);
      assert.strictEqual(stale.reason, "OUT_OF_ORDER_EVENT");
      assert.strictEqual((await subRow(user)).cancel_at_period_end, true);

      await lifecycle(subId, "subscription.resumed", t0 + 200);
      row = await subRow(user);
      assert.deepStrictEqual([row.status, row.cancel_at_period_end], ["active", false]);
      assert.strictEqual(row.metadata.last_lifecycle_event, "subscription.resumed");

      // Next charge after resume extends from the existing end
      await renew(subId, "pay_q_life_2", 219900, t0 + 300);
      assert.strictEqual(daysLeft((await subRow(user)).current_period_end), 180);
    });

    await check("halted revokes access (past_due); cancelled and completed end renewal at period end", async () => {
      for (const [event, status, cancel] of [
        ["subscription.halted", "past_due", false],
        ["subscription.cancelled", "active", true],
        ["subscription.completed", "active", true],
      ] as const) {
        const subId = `sub_weekly_${event.split(".")[1]}`;
        const user = await newUser(subId, "weekly", 39900);
        await renew(subId, `pay_${subId}`, 39900, t0);
        const res = await lifecycle(subId, event, t0 + 10);
        assert.strictEqual(res.applied, true, `${event}: ${JSON.stringify(res)}`);
        const row = await subRow(user);
        assert.deepStrictEqual([row.status, row.cancel_at_period_end], [status, cancel], event);
      }
    });

    await check("an unbound mandate's pause is ignored and touches nothing", async () => {
      const res = await lifecycle("sub_never_seen", "subscription.paused", t0);
      assert.deepStrictEqual([res.ignored, res.reason], [true, "UNBOUND_MANDATE"]);
    });
  } finally {
    await db.end().catch(() => {});
    stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
