import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// Rows 5/9/10: the netlify jobs-search function and the client service fallback must give guest/Free
// title-only keywords (stored top_keywords derive from the locked description) and no numeric score.
// Same in-memory Supabase fake shape as paidGatingMatrix (#786); synthetic data only.

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  sessionToken: null as string | null,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let head = false;
    let write = false;
    const run = () => {
      if (write) return { data: [], error: null, count: 0 };
      let rows = (db.tables[table] || []).filter((r) => preds.every((p) => p(r)));
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return { data: head ? null : rows.map((r) => structuredClone(r)), error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => ({ data: run().data?.[0] ?? null, error: null });
        if (p === "select") return (_c?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b; };
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") return () => { write = true; return b; };
        if (p === "eq") return (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; };
        if (p === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
        if (p === "or") return (e: string) => { preds.push((r) => matchesPostgrestOr(e, r)); return b; };
        if (p === "range") return (f: number, t: number) => { range = [f, t]; return b; };
        return () => b;
      },
    });
    return b;
  }
  const client = {
    from,
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
    auth: {
      getUser: async (token?: string) => {
        const user = db.users[token || ""];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
      getSession: async () => ({ data: { session: db.sessionToken ? { access_token: db.sessionToken } : null }, error: null }),
    },
  };
  return { createClient: () => client, __client: client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));

// Lives only in the locked description and the stored keywords derived from it, never in a title.
const SENTINEL = "desckwsentinelqx";
const ID = "11111111-1111-4111-8111-111111111111";
const iso = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const job = {
  id: ID, title: "Backend Engineer", company: "Zqxv Holdings", company_id: "co-1", location: "Remote (Worldwide)",
  remote: true, is_remote: true, remote_scope: "worldwide", job_type: "full-time", category: "engineering",
  country_code: "US", verified: true, source_type: "greenhouse", status: "active", is_active: true,
  role_category: "backend", top_keywords: ["backend", SENTINEL], posted_at: iso(1), created_at: iso(1), first_seen_at: iso(1),
  description: `Build ${SENTINEL} services.`, skills: ["Node.js"], apply_url: "https://apply.example/1",
  companies: { name: "Zqxv Holdings", logo_url: null, domain: null, canonical_domain: null, category: null },
};
const viewRow = { ...job, company: "Verified Employer", description: null, skills: [], apply_url: null, companies: undefined, company_id: undefined };
const prefs = { roles: ["Backend Engineer"], experienceLevel: "mid", remotePreference: "any", locations: [], employmentTypes: [], categories: ["engineering"] } as any;

const event = (token: string | undefined, query: Record<string, string>) => ({
  httpMethod: "GET", queryStringParameters: query, body: null,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-forwarded-for": `10.0.1.${Math.floor(Math.random() * 250)}` },
});

let client: any;
beforeAll(async () => {
  client = ((await import("@supabase/supabase-js")) as any).__client;
  await Promise.all([import("@/lib/jobs/service"), import("../../../../netlify/functions/jobs-search"), import("@/app/api/jobs/pro/route")]);
}, 60000);

beforeEach(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-fake",
    SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890", __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  db.users = {
    "tok-free": { id: "free-1", email: "f@example.com", user_metadata: { is_pro: true } },
    "tok-pro": { id: "pro-1", email: "p@example.com", user_metadata: {} },
  };
  db.sessionToken = null;
  db.tables = {
    jobs: [structuredClone(job)],
    jobs_public: [structuredClone(viewRow)],
    subscriptions: [{ user_id: "pro-1", status: "active", plan_id: "monthly", current_period_end: new Date(Date.now() + 864e6).toISOString(), grace_period_end: null, created_at: iso(24) }],
    user_preferences: [],
    job_descriptions: [],
  };
  (globalThis as any).__mockSupabaseClient = client;
  (await import("../../../../netlify/functions/jobs-search"))._resetSearchRateLimitStore();
  // Route the service's /api/jobs/pro unlock to the real handler, so server entitlement decides.
  const pro = await import("@/app/api/jobs/pro/route");
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/jobs/pro") throw new Error(`unexpected fetch ${url.pathname}`);
    const r = new Request(url, init);
    return (init.method || "GET").toUpperCase() === "POST" ? pro.POST(r) : pro.GET(r);
  });
});
afterEach(() => {
  delete (globalThis as any).__mockSupabaseClient;
  vi.unstubAllGlobals();
});

describe("netlify jobs-search: non-Pro keywords are title-only", () => {
  it.each([["guest", undefined], ["Free", "tok-free"]] as const)("%s list and detail never carry the description keyword", async (_who, token) => {
    const { handler } = await import("../../../../netlify/functions/jobs-search");
    for (const query of [{ limit: "10" }, { id: ID }] as Array<Record<string, string>>) {
      const body = (await handler(event(token, query) as any)).body;
      expect(body).toContain(ID);
      expect(body).not.toContain(SENTINEL);
    }
  });

  it("Pro control: stored keywords still served", async () => {
    const { handler } = await import("../../../../netlify/functions/jobs-search");
    expect((await handler(event("tok-pro", { limit: "10" }) as any)).body).toContain(SENTINEL);
  });
});

describe("service.getLiveJobs masked fallback: title-only keywords, no numeric score", () => {
  const ranked = () => ({ pageSize: 10, sortBy: "match" as const, preferences: prefs });

  it("guest: browser-ranked rows carry no score and no description keyword", async () => {
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs(ranked());
    expect(res.jobs.map((j) => j.id)).toEqual([ID]);
    expect(res.jobs[0].matchScore).toBeNull();
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("client-claimed isPro with a Free session: unlock refused, still no score or keyword", async () => {
    db.sessionToken = "tok-free";
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs({ ...ranked(), isPro: true });
    expect(res.jobs.map((j) => j.id)).toEqual([ID]);
    expect(res.jobs[0].matchScore).toBeNull();
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it("Pro control: server unlock restores a numeric score and the stored keywords", async () => {
    db.sessionToken = "tok-pro";
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs({ ...ranked(), isPro: true });
    expect(typeof res.jobs[0].matchScore).toBe("number");
    expect(res.jobs[0].top_keywords).toContain(SENTINEL);
  });
});
