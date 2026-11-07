/**
 * Offline test for the payment reconciliation report (Backend sheet row
 * "Payment Reconciliation"). Covers src/lib/billing/reconcile.ts and static
 * checks that the report script is read-only and that every column it selects
 * exists in the migrations. Live data behavior is unproven here.
 * Run: npx tsx scripts/test-payment-reconciliation.ts
 */
import * as fs from "fs";
import { reconcilePayments, OrderRow } from "../src/lib/billing/reconcile";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}
const NOW = Date.parse("2026-11-07T12:00:00Z");
const H = 3600000;
function order(p: Partial<OrderRow> & { id: string }): OrderRow {
  return { user_id: "u1", plan_code: null, addon_code: null, status: "paid", created_at: new Date(NOW - H).toISOString(), paid_at: null, ...p };
}
const kinds = (f: any[]) => f.map((x) => x.kind).join(",");

// clean data
check("clean: paid plan with subscription, paid addon with credit, fresh created order give no findings",
  reconcilePayments({
    orders: [order({ id: "o1", plan_code: "weekly" }), order({ id: "o2", addon_code: "addon_30" }), order({ id: "o3", status: "created" })],
    subscriptions: [{ user_id: "u1", plan_id: "weekly", status: "active" }],
    credits: [{ id: "c1", user_id: "u1", order_id: "o2" }],
    nowMs: NOW, staleCreatedHours: 24,
  }).length === 0);

let f = reconcilePayments({ orders: [order({ id: "o1", plan_code: "weekly" })], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: 24 });
check("paid plan order without a subscription row is reported", kinds(f) === "paid_plan_order_without_subscription" && f[0].orderId === "o1");
f = reconcilePayments({ orders: [order({ id: "o1", plan_code: "weekly" })], subscriptions: [{ user_id: null, plan_id: "x", status: "active" }], credits: [], nowMs: NOW, staleCreatedHours: 24 });
check("a subscription with null user_id does not satisfy the check", kinds(f) === "paid_plan_order_without_subscription");
f = reconcilePayments({ orders: [order({ id: "o2", addon_code: "addon_30" })], subscriptions: [], credits: [{ id: "c9", user_id: "u1", order_id: "other" }], nowMs: NOW, staleCreatedHours: 24 });
check("paid add-on order with no credit row linked by order_id is reported", kinds(f) === "paid_addon_order_without_credit");
f = reconcilePayments({ orders: [order({ id: "o4", status: "failed", addon_code: "addon_30" })], subscriptions: [], credits: [{ id: "c1", user_id: "u1", order_id: "o4" }], nowMs: NOW, staleCreatedHours: 24 });
check("credit linked to a non-paid order is reported", kinds(f) === "credit_linked_to_unpaid_order");
f = reconcilePayments({ orders: [], subscriptions: [], credits: [{ id: "c1", user_id: "u1", order_id: "gone" }, { id: "c2", user_id: "u1", order_id: null }], nowMs: NOW, staleCreatedHours: 24 });
check("credit with missing order (FK set null) or no order is not reported", f.length === 0);
const old = new Date(NOW - 25 * H).toISOString();
f = reconcilePayments({ orders: [order({ id: "o5", status: "created", created_at: old })], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: 24 });
check("created order older than the threshold is reported", kinds(f) === "stale_created_order");
f = reconcilePayments({ orders: [order({ id: "o5", status: "created", created_at: old })], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: 48 });
check("threshold is respected (25h old, 48h threshold: not reported)", f.length === 0);
f = reconcilePayments({ orders: [order({ id: "o6", status: "failed", created_at: old }), order({ id: "o7", status: "expired", created_at: old })], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: 1 });
check("failed and expired orders are not reported as stale", f.length === 0);
let threw = 0;
[undefined as any, 0, -1, NaN].forEach((v) => { try { reconcilePayments({ orders: [], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: v }); } catch { threw++; } });
check("staleCreatedHours is required and positive (no default)", threw === 4);

// static checks
const script = fs.readFileSync("scripts/report-payment-reconciliation.ts", "utf8");
const code = script.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
check("script is read-only: GET only, no write verbs, no provider calls", /method: "GET"/.test(code) && !/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(code) && !/razorpay\.com|api\.stripe|\.rpc\(|\.insert\(|\.update\(|\.delete\(/i.test(code));
check("script requires --stale-created-hours and has no numeric default for it", /--stale-created-hours/.test(code) && /process\.exit\(2\)/.test(code) && !/staleHours\s*=\s*[^N]*\|\|\s*\d/.test(code));
const sqlAll = fs.readdirSync("supabase/migrations").map((n) => fs.readFileSync("supabase/migrations/" + n, "utf8")).join("\n").toLowerCase();
const cols = ["id", "user_id", "plan_code", "addon_code", "status", "created_at", "paid_at", "plan_id", "order_id"];
check("every column the script selects exists in the migrations", cols.every((c) => new RegExp(`\\b${c}\\b`).test(sqlAll)) && /create table if not exists public\.payment_orders/.test(sqlAll) && /create table if not exists public\.user_addon_credits/.test(sqlAll) && /create table if not exists subscriptions/.test(sqlAll));
const sel = script.match(/readAll\("payment_orders", "([^"]+)"\)/);
check("payment_orders select list matches the OrderRow fields", !!sel && sel[1] === "id,user_id,plan_code,addon_code,status,created_at,paid_at");
check("script states its scope (provider settlement not compared)", /provider settlement is not compared/.test(script));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
