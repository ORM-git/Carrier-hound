/**
 * scripts/audit-crosslinked-mandates.ts
 *
 * Read-only data audit query for cross-linked mandates and orphaned obligations.
 * Checks:
 * 1. Duplicate subscription_id attached to multiple users in subscriptions.
 * 2. Duplicate customer_id attached to multiple users in subscriptions.
 * 3. payment_orders.provider_order_id attached to multiple users.
 * 4. payment_orders metadata userId/user_id mismatching payment_orders.user_id.
 * 5. Cross-table mismatch: payment_orders provider_order_id matching subscriptions.subscription_id with a different user_id.
 * 6. Cross-table mismatch: payment_orders provider_customer_id matching subscriptions.customer_id with a different user_id.
 * 7. Count of pending/unknown reconciliation records.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

function loadEnvIfAvailable() {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve("d:/Carrer-hound/.env.local"),
    path.resolve("d:/Carrer-hound/.env"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

loadEnvIfAvailable();

interface AuditResult {
  timestamp: string;
  crossLinkedSubscriptionIds: number;
  crossLinkedCustomerIds: number;
  crossLinkedPaymentOrderIds: number;
  metadataUserIdMismatches: number;
  orderVsSubscriptionUserMismatches: number;
  orderVsCustomerUserMismatches: number;
  pendingReconciliations: number;
  details: {
    crossLinkedSubscriptionIds: any[];
    crossLinkedCustomerIds: any[];
    metadataUserIdMismatches: any[];
    orderVsSubscriptionUserMismatches: any[];
    orderVsCustomerUserMismatches: any[];
  };
}

export async function runMandateAudit(supabaseClient?: any): Promise<AuditResult> {
  const supabase =
    supabaseClient ||
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co",
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ""
    );

  const result: AuditResult = {
    timestamp: new Date().toISOString(),
    crossLinkedSubscriptionIds: 0,
    crossLinkedCustomerIds: 0,
    crossLinkedPaymentOrderIds: 0,
    metadataUserIdMismatches: 0,
    orderVsSubscriptionUserMismatches: 0,
    orderVsCustomerUserMismatches: 0,
    pendingReconciliations: 0,
    details: {
      crossLinkedSubscriptionIds: [],
      crossLinkedCustomerIds: [],
      metadataUserIdMismatches: [],
      orderVsSubscriptionUserMismatches: [],
      orderVsCustomerUserMismatches: [],
    },
  };

  // 1. Check duplicate subscription_id in subscriptions
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("user_id, subscription_id, customer_id, metadata, status");

  if (subs && subs.length > 0) {
    const subIdMap = new Map<string, string[]>();
    const custIdMap = new Map<string, string[]>();

    for (const s of subs) {
      if (s.subscription_id) {
        const users = subIdMap.get(s.subscription_id) || [];
        if (!users.includes(s.user_id)) users.push(s.user_id);
        subIdMap.set(s.subscription_id, users);
      }
      if (s.customer_id) {
        const users = custIdMap.get(s.customer_id) || [];
        if (!users.includes(s.user_id)) users.push(s.user_id);
        custIdMap.set(s.customer_id, users);
      }
    }

    for (const [subId, users] of subIdMap.entries()) {
      if (users.length > 1) {
        result.crossLinkedSubscriptionIds++;
        result.details.crossLinkedSubscriptionIds.push({ subId, users });
      }
    }

    for (const [custId, users] of custIdMap.entries()) {
      if (users.length > 1) {
        result.crossLinkedCustomerIds++;
        result.details.crossLinkedCustomerIds.push({ custId, users });
      }
    }
  }

  // 2. Check payment_orders
  const { data: orders } = await supabase
    .from("payment_orders")
    .select("id, user_id, provider_order_id, metadata, status");

  if (orders && orders.length > 0) {
    const orderIdMap = new Map<string, string[]>();

    for (const o of orders) {
      if (o.provider_order_id) {
        const users = orderIdMap.get(o.provider_order_id) || [];
        if (!users.includes(o.user_id)) users.push(o.user_id);
        orderIdMap.set(o.provider_order_id, users);
      }

      // Check metadata userId / user_id
      const metaUserId = o.metadata?.user_id || o.metadata?.userId;
      if (metaUserId && metaUserId !== o.user_id) {
        result.metadataUserIdMismatches++;
        result.details.metadataUserIdMismatches.push({
          orderId: o.id,
          orderUserId: o.user_id,
          metaUserId,
        });
      }

      // Cross-table check: order provider_order_id vs subscriptions.subscription_id
      if (subs && o.provider_order_id) {
        const matchingSub = subs.find(
          (s: any) =>
            s.subscription_id === o.provider_order_id ||
            s.metadata?.razorpay_subscription_id === o.provider_order_id ||
            s.metadata?.pending_subscription_id === o.provider_order_id
        );
        if (matchingSub && matchingSub.user_id !== o.user_id) {
          result.orderVsSubscriptionUserMismatches++;
          result.details.orderVsSubscriptionUserMismatches.push({
            providerOrderId: o.provider_order_id,
            orderUserId: o.user_id,
            subUserId: matchingSub.user_id,
          });
        }
      }

      // Cross-table check: order provider_customer_id vs subscriptions.customer_id
      const providerCustId = o.metadata?.provider_customer_id;
      if (subs && providerCustId) {
        const matchingCust = subs.find((s: any) => s.customer_id === providerCustId);
        if (matchingCust && matchingCust.user_id !== o.user_id) {
          result.orderVsCustomerUserMismatches++;
          result.details.orderVsCustomerUserMismatches.push({
            customerId: providerCustId,
            orderUserId: o.user_id,
            subUserId: matchingCust.user_id,
          });
        }
      }
    }

    for (const [orderId, users] of orderIdMap.entries()) {
      if (users.length > 1) {
        result.crossLinkedPaymentOrderIds++;
      }
    }
  }

  // 3. Count pending reconciliations
  try {
    const { count } = await supabase
      .from("subscription_reconciliations")
      .select("id", { count: "exact", head: true })
      .in("reconciliation_state", ["pending", "unknown"]);
    result.pendingReconciliations = count ?? 0;
  } catch {
    result.pendingReconciliations = 0;
  }

  return result;
}

if (process.argv[1]?.includes("audit-crosslinked-mandates")) {
  console.log("=== Running Mandate Ownership & Cross-Link Data Audit ===");
  runMandateAudit().then((res) => {
    console.log(JSON.stringify(res, null, 2));
    console.log("\nSummary of findings:");
    console.log(`- Cross-linked Subscription IDs: ${res.crossLinkedSubscriptionIds}`);
    console.log(`- Cross-linked Customer IDs: ${res.crossLinkedCustomerIds}`);
    console.log(`- Cross-linked Payment Order IDs: ${res.crossLinkedPaymentOrderIds}`);
    console.log(`- Metadata User ID Mismatches: ${res.metadataUserIdMismatches}`);
    console.log(`- Order vs Subscription User Mismatches: ${res.orderVsSubscriptionUserMismatches}`);
    console.log(`- Order vs Customer User Mismatches: ${res.orderVsCustomerUserMismatches}`);
    console.log(`- Pending Reconciliations in Queue: ${res.pendingReconciliations}`);
  }).catch((err) => {
    console.error("Audit error:", err);
    process.exit(1);
  });
}
