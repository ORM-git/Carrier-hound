/**
 * Offline test for the payment reconciliation report (Backend sheet row
 * "Payment Reconciliation"). Covers src/lib/billing/reconcile.ts and static
 * checks that the report script is read-only and that every column it selects
 * exists in the migrations. Live data behavior is unproven here.
 * Run: npx tsx scripts/test-payment-reconciliation.ts
 */
import * as fs from "fs";
import { reconcilePayments, parseContentRangeTotal, pagingDone, OrderRow } from "../src/lib/billing/reconcile";

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
f = reconcilePayments({ orders: [order({ id: "o8", user_id: "u1", addon_code: "addon_30" })], subscriptions: [], credits: [{ id: "c9", user_id: "u2", order_id: "o8" }], nowMs: NOW, staleCreatedHours: 24 });
check("credit whose user differs from its order's user is reported", kinds(f) === "credit_user_mismatch" && f[0].userId === "u2" && f[0].orderId === "o8");
f = reconcilePayments({ orders: [order({ id: "o8", user_id: "u1", addon_code: "addon_30" })], subscriptions: [], credits: [{ id: "c9", user_id: "u1", order_id: "o8" }], nowMs: NOW, staleCreatedHours: 24 });
check("matching user gives no mismatch finding", f.length === 0);
f = reconcilePayments({ orders: [order({ id: "o9", user_id: "u1", status: "failed", addon_code: "addon_30" })], subscriptions: [], credits: [{ id: "c9", user_id: "u2", order_id: "o9" }], nowMs: NOW, staleCreatedHours: 24 });
check("unpaid order with another user's credit reports both findings", kinds(f) === "credit_linked_to_unpaid_order,credit_user_mismatch");
check("content-range total parsing", parseContentRangeTotal("0-999/2500") === 2500 && parseContentRangeTotal("*/0") === 0 && parseContentRangeTotal("0-9/*") === null && parseContentRangeTotal(null) === null);
check("paging: known total keeps reading past a server cap below the page size", pagingDone(500, 500, 2500, 1000) === false && pagingDone(2500, 500, 2500, 1000) === true);
check("paging: empty page always stops, unknown total falls back to short page", pagingDone(10, 0, 2500, 1000) === true && pagingDone(1000, 1000, null, 1000) === false && pagingDone(1200, 200, null, 1000) === true);
let threw = 0;
[undefined as any, 0, -1, NaN].forEach((v) => { try { reconcilePayments({ orders: [], subscriptions: [], credits: [], nowMs: NOW, staleCreatedHours: v }); } catch { threw++; } });
check("staleCreatedHours is required and positive (no default)", threw === 4);

// static checks
const script = fs.readFileSync("scripts/report-payment-reconciliation.ts", "utf8");
const code = script.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
check("script is read-only: GET only, no write verbs, no provider calls", /method: "GET"/.test(code) && !/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(code) && !/razorpay\.com|api\.stripe|\.rpc\(|\.insert\(|\.update\(|\.delete\(/i.test(code));
check("script requires --stale-created-hours and has no numeric default for it", /--stale-created-hours/.test(code) && /process\.exit\(2\)/.test(code) && !/staleHours\s*=\s*[^N]*\|\|\s*\d/.test(code));
const sqlAll = fs.readdirSync("supabase/migrations").map((n) => fs.readFileSync("supabase/migrations/" + n, "utf8")).join("\n").toLowerCase();
check("script reads in stable primary-key order with an exact count", /order=id\.asc/.test(code) && /Prefer: "count=exact"/.test(code) && /pagingDone\(/.test(code) && /rows changed during the read/.test(code));
const cols = ["id", "user_id", "plan_code", "addon_code", "status", "created_at", "paid_at", "plan_id", "order_id"];
check("every column the script selects exists in the migrations", cols.every((c) => new RegExp(`\\b${c}\\b`).test(sqlAll)) && /create table if not exists public\.payment_orders/.test(sqlAll) && /create table if not exists public\.user_addon_credits/.test(sqlAll) && /create table if not exists subscriptions/.test(sqlAll));
const sel = script.match(/readAll\("payment_orders", "([^"]+)"\)/);
check("payment_orders select list matches the OrderRow fields", !!sel && sel[1] === "id,user_id,plan_code,addon_code,status,created_at,paid_at");
check("script states its scope (provider settlement not compared)", /provider settlement is not compared/.test(script));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
