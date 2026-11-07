/**
 * Read-only payment reconciliation report (docs/payment-reconciliation.md).
 * GET requests only. Never writes, never calls a payment provider. Not run by CI.
 *
 * Usage: npx tsx scripts/report-payment-reconciliation.ts --stale-created-hours <n>
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Exit codes: 0 = no findings, 1 = findings, 2 = env or argument missing.
 */
import { reconcilePayments, parseContentRangeTotal, pagingDone } from "../src/lib/billing/reconcile";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const idx = process.argv.indexOf("--stale-created-hours");
const staleHours = idx >= 0 ? Number(process.argv[idx + 1]) : NaN;

if (!url || !serviceKey) {
  console.error("Supabase env not configured; cannot read billing tables.");
  process.exit(2);
}
if (!isFinite(staleHours) || staleHours <= 0) {
  console.error("--stale-created-hours <positive number> is required (no default; owner to confirm).");
  process.exit(2);
}

async function readAll(table: string, select: string): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000; // PostgREST default max rows per request
  let total: number | null = null;
  // Stable order (primary key) so offset pages do not skip or repeat rows; the exact
  // count lets the loop keep going if the server caps a page below PAGE.
  for (let from = 0; ; ) {
    const res = await fetch(`${url}/rest/v1/${table}?select=${select}&order=id.asc`, {
      method: "GET",
      headers: {
        apikey: serviceKey as string,
        Authorization: `Bearer ${serviceKey}`,
        Range: `${from}-${from + PAGE - 1}`,
        "Range-Unit": "items",
        Prefer: "count=exact",
      },
    });
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as any[];
    total = parseContentRangeTotal(res.headers.get("content-range"));
    out.push(...rows);
    from += rows.length;
    if (pagingDone(from, rows.length, total, PAGE)) break;
  }
  if (total !== null && out.length !== total) {
    throw new Error(`${table}: read ${out.length} rows but the server reports ${total}; rows changed during the read, rerun`);
  }
  return out;
}

async function main() {
  const [orders, subscriptions, credits] = await Promise.all([
    readAll("payment_orders", "id,user_id,plan_code,addon_code,status,created_at,paid_at"),
    readAll("subscriptions", "user_id,plan_id,status"),
    readAll("user_addon_credits", "id,user_id,order_id"),
  ]);
  const findings = reconcilePayments({ orders, subscriptions, credits, nowMs: Date.now(), staleCreatedHours: staleHours });
  console.log(`orders=${orders.length} subscriptions=${subscriptions.length} credits=${credits.length} findings=${findings.length}`);
  findings.forEach((f) => console.log(`${f.kind} order=${f.orderId} user=${f.userId} ${f.detail}`));
  console.log("Scope: DB orders vs DB entitlements only; provider settlement is not compared.");
  process.exit(findings.length > 0 ? 1 : 0);
}
main().catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(2); });
