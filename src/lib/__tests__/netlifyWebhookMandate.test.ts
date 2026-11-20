import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const recordFailedEvent = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/events/failedEvents", () => ({ recordFailedEvent: (...args: any[]) => (recordFailedEvent as any)(...args) }));

import { createHandler } from "../../../netlify/functions/billing-razorpay-webhook";

const SECRET = "whsec_netlify_mandate_test";

function mockDb(order: any, rpcResult: any) {
  const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: table === "payment_orders" ? order : null, error: null }),
      update: (u: any) => {
        if (table === "payment_orders" && order.status === "created") Object.assign(order, u);
        return chain;
      },
      upsert: async () => ({ error: null }),
      insert: async () => ({ error: null }),
      then: (resolve: any) => resolve({ data: null, error: null }),
    };
    return chain;
  };
  return { client: { from, rpc }, rpc };
}

function signed(body: object) {
  const raw = JSON.stringify(body);
  return { raw, sig: crypto.createHmac("sha256", SECRET).update(raw).digest("hex") };
}

describe("Netlify webhook: paid events that grant nothing leave no chargeable mandate", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_AUTORENEW_ENABLED: "true",
      RAZORPAY_WEBHOOK_SECRET: SECRET,
      NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_netlify_key",
      RAZORPAY_KEY_SECRET: "rzp_test_netlify_secret",
    });
    recordFailedEvent.mockClear();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const cancelRecorder = () => {
    const cancelled: string[] = [];
    const fetchFn = vi.fn(async (url: any) => {
      const id = String(url).match(/\/subscriptions\/(\w+)\/cancel$/)?.[1];
      if (id) cancelled.push(id);
      return new Response(JSON.stringify({ id, status: "cancelled" }), { status: 200 });
    });
    return { cancelled, fetchFn: fetchFn as unknown as typeof fetch };
  };

  const charge = (subId: string, amount: number) =>
    signed({
      event: "subscription.charged",
      payload: { subscription: { entity: { id: subId } }, payment: { entity: { id: `pay_${subId}`, amount } } },
    });

  it("older weekly charged after quarterly is bound: RPC ignores it, Netlify cancels it at Razorpay and records the refund", async () => {
    const order = { id: "po_w", provider: "razorpay", mode: "test", user_id: "u1", status: "created", plan_code: "weekly", amount_paise: 39900 };
    const { client, rpc } = mockDb(order, { success: true, ignored: true, reason: "OLD_MANDATE_IGNORED" });
    const { cancelled, fetchFn } = cancelRecorder();
    const handler = createHandler({ getSupabaseAdmin: () => client, verifyUserNotBanned: async () => ({ isBlocked: false }), fetchFn });

    const { raw, sig } = charge("sub_w_old", 39900);
    const res = await handler({ httpMethod: "POST", headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_n1" }, body: raw });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ignored: true, reason: "OLD_MANDATE_IGNORED", razorpayCancelled: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual(["sub_w_old"]);
    expect(order.status).toBe("expired");
    expect(recordFailedEvent).toHaveBeenCalledTimes(1);
  });

  it("charge on an expired pending mandate: no grant RPC, cancelled and recorded", async () => {
    const order = { id: "po_x", provider: "razorpay", mode: "test", user_id: "u2", status: "expired", plan_code: "weekly", amount_paise: 39900 };
    const { client, rpc } = mockDb(order, null);
    const { cancelled, fetchFn } = cancelRecorder();
    const handler = createHandler({ getSupabaseAdmin: () => client, verifyUserNotBanned: async () => ({ isBlocked: false }), fetchFn });

    const { raw, sig } = charge("sub_expired", 39900);
    const res = await handler({ httpMethod: "POST", headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_n2" }, body: raw });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reason).toBe("EXPIRED_MANDATE");
    expect(rpc).not.toHaveBeenCalled();
    expect(cancelled).toEqual(["sub_expired"]);
    expect(recordFailedEvent).toHaveBeenCalledTimes(1);
  });
});
