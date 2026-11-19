import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import crypto from "crypto";

// Launch scope: free vs Pro through the REAL route handlers (listing, detail, payment verify)
// and the REAL getServerEntitlement. Only the Supabase client is replaced by an in-memory
// fake whose `subscriptions` table is the single source of entitlement, as in production.

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
  fulfilCalls: 0,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const run = () => {
      const data = (state.tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v));
      return { data, count: data.length, error: null };
    };
    const b: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
          if (prop === "eq") return (c: string, v: unknown) => (filters.push([c, v]), b);
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({ data: run().data[0] ?? null, error: null });
          }
          return () => b;
        },
      },
    );
    return b;
  }
  const client = {
    auth: {
      getUser: async (token: string) => {
        const user = state.users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
    rpc: async (fn: string, args: any) => {
      if (fn !== "fulfil_payment_order") return { data: { allowed: true, retry_after: 0, current_count: 1 }, error: null };
      state.fulfilCalls++;
      const order = (state.tables.payment_orders || []).find(
        (o) => o.provider_order_id === args.p_provider_order_id && o.user_id === args.p_user_id,
      );
      if (order.status !== "paid") {
        order.status = "paid";
        state.tables.subscriptions.push({
          user_id: order.user_id,
          status: "active",
          plan_id: order.plan_code,
          current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
          grace_period_end: null,
          created_at: new Date().toISOString(),
        });
      }
      return { data: { success: true, is_pro: true }, error: null };
    },
  };
  return { createClient: () => client };
});

vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

const KEY_ID = "rzp_live_launchtestkey123";
const KEY_SECRET = "launch_test_secret_123456";
const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Senior Engineer",
  company: "Acme Corp",
  location: "Remote",
  category: "engineering",
  remote: true,
  remote_scope: "worldwide",
  country_code: "US",
  job_type: "full-time",
  verified: true,
  posted_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  salary_min: 100000,
  salary_max: 150000,
  currency: "USD",
  salary_period: "year",
  salary_text: "$100k - $150k",
  apply_url: "https://careers.acme.com/apply/1",
  description: "Build things",
  skills: ["TypeScript"],
  company_id: "co_1",
  status: "active",
  is_active: true,
  companies: { name: "Acme Corp", logo_url: null },
};

const req = (url: string, token?: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });

let search: (r: Request) => Promise<Response>;
let proDetail: (r: Request) => Promise<Response>;
let verify: (r: Request) => Promise<Response>;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "group-secret-for-tests-0123456789",
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    NEXT_PUBLIC_RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  search = (await import("@/app/api/jobs/search/route")).GET;
  proDetail = (await import("@/app/api/jobs/pro/route")).GET;
  verify = (await import("@/app/api/billing/razorpay/verify/route")).POST;
}, 30000);

beforeEach(() => {
  state.fulfilCalls = 0;
  state.users = {
    "tok-free": { id: "u_free", email: "free@example.com", user_metadata: {} },
    // client-editable metadata claiming Pro must never unlock anything
    "tok-new": { id: "u_new", email: "new@example.com", user_metadata: { is_pro: true, pro_granted: true } },
    "tok-pro": { id: "u_pro", email: "pro@example.com", user_metadata: {} },
  };
  state.tables = {
    jobs: [{ ...JOB }],
    jobs_public: [{ ...JOB }],
    subscriptions: [
      {
        user_id: "u_pro",
        status: "active",
        plan_id: "monthly",
        current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(),
        grace_period_end: null,
        created_at: new Date().toISOString(),
      },
    ],
    payment_orders: [],
  };
});

describe("real listing + detail handlers: free vs Pro", () => {
  it("free user: listing masks company and hides salary/apply", async () => {
    const res = await search(req("http://localhost/api/jobs/search", "tok-free"));
    const job = (await res.json()).jobs[0];
    expect(job.company).toBe("Verified Employer");
    expect(job.salary).toBe("");
    expect(job.applyUrl).toBe("");
  });

  it("anonymous visitor gets the same masked listing", async () => {
    const job = (await (await search(req("http://localhost/api/jobs/search"))).json()).jobs[0];
    expect(job.company).toBe("Verified Employer");
    expect(job.applyUrl).toBe("");
  });

  it("free user: search detail is masked and Pro detail endpoint is 403", async () => {
    const detail = (await (await search(req("http://localhost/api/jobs/search?id=11111111-1111-4111-8111-111111111111", "tok-free"))).json()).jobs[0];
    expect(detail.company).toBe("Verified Employer");
    expect(detail.applyUrl).toBe("");
    const pro = await proDetail(req("http://localhost/api/jobs/pro?id=11111111-1111-4111-8111-111111111111", "tok-free"));
    expect(pro.status).toBe(403);
  });

  it("user_metadata claiming Pro does not unlock anything", async () => {
    const job = (await (await search(req("http://localhost/api/jobs/search?id=11111111-1111-4111-8111-111111111111", "tok-new"))).json()).jobs[0];
    expect(job.company).toBe("Verified Employer");
    expect((await proDetail(req("http://localhost/api/jobs/pro?id=11111111-1111-4111-8111-111111111111", "tok-new"))).status).toBe(403);
  });

  it("Pro user (subscriptions row): listing and detail show company, salary and apply", async () => {
    const listed = (await (await search(req("http://localhost/api/jobs/search", "tok-pro"))).json()).jobs[0];
    expect(listed.company).toBe("Acme Corp");
    expect(listed.applyUrl).toBe(JOB.apply_url);
    expect(listed.salary).not.toBe("");
    const pro = await proDetail(req("http://localhost/api/jobs/pro?id=11111111-1111-4111-8111-111111111111", "tok-pro"));
    expect(pro.status).toBe(200);
    const body = await pro.json();
    expect(body.isPro).toBe(true);
    expect(body.job.apply_url).toBe(JOB.apply_url);
    expect(body.job.company).toBe("Acme Corp");
  });

  it("expired subscription is not Pro", async () => {
    state.tables.subscriptions[0].status = "expired";
    state.tables.subscriptions[0].current_period_end = new Date(Date.now() - 864e5).toISOString();
    const job = (await (await search(req("http://localhost/api/jobs/search?id=11111111-1111-4111-8111-111111111111", "tok-pro"))).json()).jobs[0];
    expect(job.company).toBe("Verified Employer");
  });
});

describe("payment verify -> refresh unlocks Pro (real verify route)", () => {
  const orderId = "order_live_1";
  const paymentId = "pay_live_1";
  const sig = () => crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  const verifyReq = (providerPayment: any) => {
    const r = req("http://localhost/api/billing/razorpay/verify", "tok-free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId, payment_id: paymentId, razorpay_signature: sig() }),
    });
    (r as any).__testDeps = { fetchRazorpayPayment: async () => providerPayment };
    return r;
  };
  const captured = { id: paymentId, order_id: orderId, status: "captured", amount: 49900, currency: "INR" };

  beforeEach(() => {
    state.tables.payment_orders = [
      {
        id: "po_1",
        user_id: "u_free",
        provider: "razorpay",
        mode: "live",
        provider_order_id: orderId,
        plan_code: "monthly",
        addon_code: null,
        amount_paise: 49900,
        currency: "INR",
        status: "created",
      },
    ];
  });

  const asFree = async () => (await (await search(req("http://localhost/api/jobs/search?id=11111111-1111-4111-8111-111111111111", "tok-free"))).json()).jobs[0];

  it("captured payment fulfils once, refresh unlocks Pro, retry is idempotent", async () => {
    expect((await asFree()).company).toBe("Verified Employer");

    const first = await verify(verifyReq(captured));
    expect(first.status).toBe(200);
    expect(state.fulfilCalls).toBe(1);

    const unlocked = await asFree();
    expect(unlocked.company).toBe("Acme Corp");
    expect(unlocked.applyUrl).toBe(JOB.apply_url);
    expect((await proDetail(req("http://localhost/api/jobs/pro?id=11111111-1111-4111-8111-111111111111", "tok-free"))).status).toBe(200);

    const retry = await verify(verifyReq(captured));
    expect(retry.status).toBe(200);
    expect((await retry.json()).alreadyPaid).toBe(true);
    expect(state.fulfilCalls).toBe(1);
  });

  it.each([
    ["not captured", { ...captured, status: "authorized" }],
    ["wrong amount", { ...captured, amount: 100 }],
    ["wrong currency", { ...captured, currency: "USD" }],
    ["wrong order", { ...captured, order_id: "order_other" }],
    ["wrong payment id", { ...captured, id: "pay_other" }],
    ["payment missing", null],
  ])("provider %s -> 400, no fulfilment, user stays free", async (_label, providerPayment) => {
    const res = await verify(verifyReq(providerPayment));
    expect(res.status).toBe(400);
    expect(state.fulfilCalls).toBe(0);
    expect((await asFree()).company).toBe("Verified Employer");
  });
});
