import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as nextSubscriptionPOST, DELETE as nextSubscriptionDELETE } from "@/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../../../netlify/functions/billing-razorpay-subscription";
import { openRazorpaySubscription as openGatewaySubscription } from "@/lib/billing/razorpay";
import { openRazorpaySubscription as openCheckoutSubscription } from "@/lib/billing/checkout";

const mockUser = {
  id: "user_autorenew_test_123",
  email: "candidate@careermonke.com",
  user_metadata: { full_name: "Autorenew Candidate" },
};

const validConsent = {
  agreed: true,
  version: "2026-11-autorenew-v1",
  timestamp: new Date().toISOString(),
};

const validPlanResponse = {
  id: "plan_monthly_rzp_499",
  entity: "plan",
  interval: 1,
  period: "monthly",
  item: {
    id: "item_monthly_499",
    amount: 49900,
    currency: "INR",
  },
};

function createMockSupabase(
  initialSub?: any,
  opts: { orders?: any[]; insertConflict?: boolean; failOrderUpdate?: boolean } = {}
) {
  let sub = initialSub ? { ...initialSub } : null;
  const orders: any[] = (opts.orders || []).map((o) => ({ ...o }));

  const mockClient = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") {
          return { data: { user: mockUser }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      },
      getSession: async () => {
        return { data: { session: { access_token: "valid-token", user: mockUser } }, error: null };
      },
    },
    from: (table: string) => {
      let filterUserId: string | null = null;
      let filterStatus: string | null = null;
      let filterPlanCode: string | null = null;

      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, val: any) => {
          if (col === "user_id") filterUserId = val;
          if (col === "status") filterStatus = val;
          if (col === "plan_code") filterPlanCode = val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "subscriptions") {
            return { data: sub ? { ...sub } : null, error: null };
          }
          if (table === "payment_orders") {
            const match = orders.find((o) => {
              if (filterUserId && o.user_id !== filterUserId) return false;
              if (filterStatus && o.status !== filterStatus) return false;
              if (filterPlanCode && o.plan_code !== filterPlanCode) return false;
              return true;
            });
            return { data: match || null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (row: any) => {
          if (table === "payment_orders" && opts.insertConflict) {
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          if (table === "payment_orders") {
            orders.push({ ...row, id: `po_${Date.now()}` });
          } else if (table === "subscriptions") {
            sub = { ...row, id: `sub_db_${Date.now()}` };
          }
          return { error: null };
        },
        update: (updates: any) => {
          const filters: Record<string, any> = {};
          const q: any = {
            eq: (col: string, val: any) => {
              filters[col] = val;
              return q;
            },
            then: (resolve: any, reject: any) => {
              if (table === "payment_orders" && opts.failOrderUpdate) {
                return Promise.resolve({ error: { message: "write failed" } }).then(resolve, reject);
              }
              if (table === "subscriptions" && sub) {
                sub = { ...sub, ...updates };
              }
              if (table === "payment_orders") {
                orders.forEach((o, i) => {
                  if (Object.entries(filters).every(([k, v]) => o[k] === v)) orders[i] = { ...o, ...updates };
                });
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return q;
        },
      };
      return chain;
    },
    _getSub: () => sub,
    _getOrders: () => orders,
  };

  return mockClient;
}


describe("review: multi-plan pending mandate safety", () => {
  it("refuses a second different-plan mandate while one is pending", async () => {
    const oldEnv = {...process.env};
    try {
      Object.assign(process.env, {
        RAZORPAY_MODE: "test", NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_fixture_key_123456",
        RAZORPAY_KEY_SECRET: "fixture", NEXT_PUBLIC_AUTORENEW_ENABLED: "true", NEXT_PUBLIC_BILLING_ENABLED: "true",
        RAZORPAY_AUTORENEW_PLAN_WEEKLY: "plan_weekly", RAZORPAY_AUTORENEW_PLAN_QUARTERLY: "plan_quarterly",
      });
      for (const platform of ["next", "netlify"]) {
        const db = createMockSupabase(); let count=0;
        const gateway = vi.fn(async (url:any) => {
          if (String(url).includes("/plans/")) {
            const weekly = String(url).endsWith("plan_weekly");
            return new Response(JSON.stringify({period: weekly ? "weekly":"monthly", interval: weekly?1:3,
              item:{amount:weekly?39900:219900,currency:"INR"}}),{status:200});
          }
          return new Response(JSON.stringify({id:`sub_review_${++count}`,status:"created"}),{status:200});
        });
        const deps={getSupabaseAdmin:()=>db,verifyUserNotBanned:async()=>({isBlocked:false}),fetchFn:gateway};
        const call = async (code:string) => {
          if(platform==="next") {
            const req = new Request("http://localhost:3000/api/billing/razorpay/subscription",{method:"POST",
              headers:{"Content-Type":"application/json",Authorization:"Bearer valid-token"},
              body:JSON.stringify({planCode:code,consent:validConsent})});
            (req as any).__testDeps=deps;
            const r=await nextSubscriptionPOST(req);return {status:r.status,body:await r.json()};
          }
          const r=await createNetlifySubscriptionHandler(deps)({httpMethod:"POST",headers:{authorization:"Bearer valid-token"},body:JSON.stringify({planCode:code,consent:validConsent})});
          return {status:r.statusCode,body:JSON.parse(r.body)};
        }
        const a=await call("weekly"), b=await call("quarterly");
        console.log("REVIEW",platform,JSON.stringify({a,b,orders:db._getOrders().map((o:any)=>({plan:o.plan_code,sub:o.provider_order_id}))}));
        expect.soft(b.status, platform+": must not open a second independently chargeable mandate").toBe(409);
      }
    } finally { process.env=oldEnv; }
  });
});
