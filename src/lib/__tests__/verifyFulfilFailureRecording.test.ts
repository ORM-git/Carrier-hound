/**
 * Verify-route fulfilment failure recording (payment durability gap, v2/v4 contract).
 * Both verify mirrors (Next /api/billing/razorpay/verify + netlify billing-razorpay-verify)
 * must record fulfilment failures of captured payments into failed_events as record-only
 * incidents (source "razorpay_verify"), and must NEVER record genuinely-paid states or any
 * pre-fulfilment rejection. The recorder is mocked; guard behavior of the real recorder is
 * covered in failedEventsVerifyGuards.test.ts. Synthetic fixtures only: no DB, no network,
 * no provider calls, no production data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const recordFailedEvent = vi.fn(async (..._args: any[]) => ({ ok: true, status: "pending", idempotent: false }));
vi.mock("@/lib/events/failedEvents", () => ({
  recordFailedEvent: (...args: any[]) => (recordFailedEvent as any)(...args),
}));
vi.mock("@/lib/db/rpcRetry", () => ({ rpcWithRetry: (fn: any) => fn() }));
vi.mock("@/lib/monitoring/sentryErrorReporter", () => ({ reportRequestErrorToSentry: () => {} }));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

import { POST as verifyPOST } from "@/app/api/billing/razorpay/verify/route";
import { createHandler as createNetlifyVerifyHandler } from "../../../netlify/functions/billing-razorpay-verify";

const SECRET = "rzp_test_verify_secret";
const KEY_ID = "rzp_test_verify_key";
const ORDER_ID = "order_test_abc123";
const PAYMENT_ID = "pay_test_xyz789";
const USER_ID = "u1";

const ORDER_ROW = {
  id: "po_1", provider: "razorpay", mode: "test", provider_order_id: ORDER_ID,
  plan_code: "monthly", addon_code: null, amount_paise: 39900, currency: "INR", status: "created",
};
const RZP_PAYMENT = { id: PAYMENT_ID, order_id: ORDER_ID, status: "captured", amount: 39900, currency: "INR" };

function makeClient(orderRow: any, rpcImpl: any) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === "tok-u1"
          ? { data: { user: { id: USER_ID, email: "u1@example.com", user_metadata: {} } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
    from: (_table: string) => {
      const chain: any = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: orderRow, error: null });
      return chain;
    },
    rpc: rpcImpl,
  };
}

const signature = () => crypto.createHmac("sha256", SECRET).update(`${ORDER_ID}|${PAYMENT_ID}`).digest("hex");

interface RunResult { status: number; body: any; raw: string }

async function runNext(client: any, payment: any = RZP_PAYMENT, sig: string = signature()): Promise<RunResult> {
  const req = new Request("http://localhost/api/billing/razorpay/verify", {
    method: "POST",
    headers: { authorization: "Bearer tok-u1", "content-type": "application/json" },
    body: JSON.stringify({ order_id: ORDER_ID, payment_id: PAYMENT_ID, razorpay_signature: sig }),
  });
  (req as any).__testDeps = { getSupabaseAdmin: () => client, fetchRazorpayPayment: async () => payment };
  const res = await verifyPOST(req);
  const raw = JSON.stringify(await res.json());
  return { status: res.status, body: JSON.parse(raw), raw };
}

async function runNetlify(client: any, payment: any = RZP_PAYMENT, sig: string = signature()): Promise<RunResult> {
  const handler = createNetlifyVerifyHandler({ getSupabaseAdmin: () => client, fetchRazorpayPayment: async () => payment });
  const res = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer tok-u1" },
    body: JSON.stringify({ order_id: ORDER_ID, payment_id: PAYMENT_ID, razorpay_signature: sig }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body };
}

const MIRRORS = [
  ["next", runNext],
  ["netlify", runNetlify],
] as const;

const FULFIL_FAILURE_CODES = [
  "INVALID_EXPECTED_MODE",
  "INVALID_PROVIDER",
  "MODE_MISMATCH",
  "ORDER_INVALID_STATE",
  "ORDER_ITEM_MISSING",
  "ORDER_NOT_FOUND",
  "PRO_REQUIRED",
];

function expectRecordedOnce() {
  expect(recordFailedEvent).toHaveBeenCalledTimes(1);
  const call = recordFailedEvent.mock.calls[0][0];
  expect(call.source).toBe("razorpay_verify");
  expect(call.eventId).toBe(`verify:test:${PAYMENT_ID}`);
  expect(call.payload).toEqual({
    order_id: ORDER_ID,
    user_id: USER_ID,
    mode: "test",
    plan_code: "monthly",
    addon_code: null,
  });
}

describe.each(MIRRORS)("verify fulfil failure recording (%s mirror)", (_name, run) => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NEXT_PUBLIC_BILLING_ENABLED: "true",
      NEXT_PUBLIC_RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: SECRET,
      NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    });
    recordFailedEvent.mockClear();
    recordFailedEvent.mockImplementation(async () => ({ ok: true, status: "pending", idempotent: false }));
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fulfil RPC error: 500 FULFILLMENT_FAILED and the incident is recorded", async () => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({ data: null, error: { message: "connection reset" } })));
    const res = await run(client);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("FULFILLMENT_FAILED");
    expectRecordedOnce();
  });

  it.each(FULFIL_FAILURE_CODES)("fulfil failure code %s: recorded, response contract unchanged", async (code) => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({
      data: { success: false, error: `failed with ${code}`, code }, error: null,
    })));
    const res = await run(client);
    expect(res.status).toBe(code === "PRO_REQUIRED" ? 403 : 400);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toBe(`failed with ${code}`);
    expectRecordedOnce();
  });

  it("fulfil success: 200 and nothing recorded", async () => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({ data: { success: true, is_pro: true }, error: null })));
    const res = await run(client);
    expect(res.status).toBe(200);
    expect(recordFailedEvent).not.toHaveBeenCalled();
  });

  it("fulfil already_paid (idempotent success): nothing recorded", async () => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({ data: { success: true, already_paid: true, is_pro: true }, error: null })));
    const res = await run(client);
    expect(res.status).toBe(200);
    expect(recordFailedEvent).not.toHaveBeenCalled();
  });

  it("order row already paid: 200 alreadyPaid short-circuit BEFORE the RPC, nothing recorded", async () => {
    // The route returns early for paid orders, so ORDER_INVALID_STATE on a paid row never
    // occurs in practice; the recorder exclusion for that combination is defensive-only.
    const rpc = vi.fn(async () => ({ data: { success: true }, error: null }));
    const client = makeClient({ ...ORDER_ROW, status: "paid" }, rpc);
    const res = await run(client);
    expect(res.status).toBe(200);
    expect(res.body.alreadyPaid).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(recordFailedEvent).not.toHaveBeenCalled();
  });

  it("pre-fulfilment rejection (bad signature): 400 INVALID_SIGNATURE, recorder never reached", async () => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({ data: { success: true }, error: null })));
    const res = await run(client, RZP_PAYMENT, "deadbeef".repeat(8));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SIGNATURE");
    expect(recordFailedEvent).not.toHaveBeenCalled();
  });

  it("pre-fulfilment rejection (amount mismatch): 400 AMOUNT_MISMATCH, recorder never reached", async () => {
    const client = makeClient({ ...ORDER_ROW }, vi.fn(async () => ({ data: { success: true }, error: null })));
    const res = await run(client, { ...RZP_PAYMENT, amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("AMOUNT_MISMATCH");
    expect(recordFailedEvent).not.toHaveBeenCalled();
  });

  it("recorder throw leaves the original failure response byte-identical", async () => {
    const rpcImpl = vi.fn(async () => ({ data: null, error: { message: "connection reset" } }));
    const okRes = await run(makeClient({ ...ORDER_ROW }, rpcImpl));
    recordFailedEvent.mockClear();
    recordFailedEvent.mockImplementation(async () => { throw new Error("recorder exploded"); });
    const throwRes = await run(makeClient({ ...ORDER_ROW }, rpcImpl));
    expect(throwRes.status).toBe(okRes.status);
    expect(throwRes.raw).toBe(okRes.raw);
  });
});
