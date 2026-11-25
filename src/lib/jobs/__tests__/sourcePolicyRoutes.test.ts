// JobSpy (LinkedIn/Indeed/Naukri via python-jobspy) rows are hidden from every app read: lists, counts,
// direct details and hydration, incl. both /api/jobs/recommended branches. Read-side only: no writes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";
import { HIDDEN_SOURCE_TYPE, VISIBLE_SOURCE_FILTER, isHiddenSource } from "@/lib/jobs/sourcePolicy";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  queries: [] as Array<{ table: string; method: string; ors: string[] }>,
  users: {} as Record<string, { id: string; user_metadata: Record<string, unknown> }>,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const ors: string[] = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let head = false;
    let method = "select";
    const orders: Array<{ col: string; asc: boolean }> = [];
    const run = () => {
      db.queries.push({ table, method, ors: [...ors] });
      if (method !== "select") return { data: [], error: null, count: 0 };
      let rows = (db.tables[table] || []).filter((r) => preds.every((p) => p(r)));
      for (const o of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1)));
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return { data: head ? null : rows, error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { const r = run(); return { data: r.data?.[0] ?? null, error: null }; };
        if (p === "select") return (_c?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b; };
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") return () => { method = String(p); return b; };
        if (p === "eq") return (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; };
        if (p === "neq") return (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return b; };
        if (p === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
        if (p === "or") return (e: string) => { ors.push(e); preds.push((r) => matchesPostgrestOr(e, r)); return b; };
        if (p === "ilike") return (c: string, pat: string) => { const t = pat.replace(/^%|%$/g, "").toLowerCase(); preds.push((r) => String(r[c] ?? "").toLowerCase().includes(t)); return b; };
        if (p === "gte") return (c: string, v: any) => { preds.push((r) => r[c] != null && r[c] >= v); return b; };
        if (p === "order") return (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; };
        if (p === "range") return (f: number, t: number) => { range = [f, t]; return b; };
        if (p === "limit") return (n: number) => { limit = n; return b; };
        return () => b;
      },
    });
    return b;
  }
  const client = {
    from,
    rpc: async () => ({ data: null, error: { message: "no rpc in this fake" } }),
    auth: {
      getUser: async (token?: string) => ({ data: { user: db.users[token || ""] ?? null }, error: db.users[token || ""] ? null : { message: "no session" } }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };
  return { createClient: () => client, __client: client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
vi.mock("@/lib/billing/serverEntitlement", () => ({ getServerEntitlement: async (id: string) => ({ isPro: id.startsWith("pro") }) }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));

const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3600e3).toISOString();
const job = (id: string, source_type: string | null, hoursAgo: number) => ({
  id, title: "Frontend Engineer", company: `Co ${id}`, company_id: `co-${id}`, location: "Remote (Worldwide)", remote: true,
  remote_scope: "worldwide", remote_eligibility: "worldwide", job_type: "full-time", category: "engineering", country: "United States",
  country_code: "US", description: "React TypeScript", skills: ["React"], apply_url: `https://jobs.example.com/${id}`, source_type,
  status: "active", is_active: true, posted_at: iso(hoursAgo), created_at: iso(hoursAgo), first_seen_at: iso(hoursAgo), discovered_at: iso(hoursAgo),
  last_seen_at: iso(0), salary_min: null, salary_max: null, salary_text: null, currency: null, salary_period: null, verified: true,
  logo_url: null, companies: { logo_url: null, domain: null, name: `Co ${id}` },
});
const GH = "11111111-1111-4111-8111-111111111111";
const SPY = "22222222-2222-4222-8222-222222222222";
const NUL = "33333333-3333-4333-8333-333333333333";
const ARB = "44444444-4444-4444-8444-444444444444";

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-fake",
  COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
  NEXT_PUBLIC_BILLING_ENABLED: "true",
  __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
};

let client: any;
beforeAll(async () => {
  client = (await import("@supabase/supabase-js") as any).__client;
});
beforeEach(() => {
  Object.assign(process.env, baseEnv, { SUPABASE_SERVICE_ROLE_KEY: "service-role-fake" });
  // JobSpy row is the NEWEST, so any unfiltered read would surface it first.
  const rows = [job(SPY, HIDDEN_SOURCE_TYPE, 1), job(GH, "greenhouse", 2), job(NUL, null, 3), job(ARB, "arbeitnow", 4)];
  db.tables = { jobs: rows, jobs_public: rows };
  db.queries = [];
  db.users = { "tok-pro": { id: "pro-1", user_metadata: {} }, "tok-free": { id: "free-1", user_metadata: {} } };
  (globalThis as any).__mockSupabaseClient = client;
});
afterEach(() => {
  delete (globalThis as any).__mockSupabaseClient;
  vi.resetModules();
});

const jobReads = () => db.queries.filter((q) => (q.table === "jobs" || q.table === "jobs_public") && q.method === "select");
const ids = (body: any) => (body.jobs || []).map((j: any) => j.id);
const req = (url: string, token?: string, init: RequestInit = {}) =>
  new Request(`http://localhost${url}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });

describe("source policy filter", () => {
  it("keeps NULL and every other source, drops only jobspy", () => {
    const keep = (source_type: string | null) => matchesPostgrestOr(VISIBLE_SOURCE_FILTER, { source_type });
    expect([null, "greenhouse", "lever", "arbeitnow", "adzuna", "workday"].every(keep)).toBe(true);
    expect(keep("jobspy")).toBe(false);
    expect(isHiddenSource({ source_type: "jobspy" })).toBe(true);
    expect(isHiddenSource({ source_type: null })).toBe(false);
  });
});

describe("/api/jobs/recommended", () => {
  it("service-key branch (jobs) + Pro hydration: no jobspy row, every jobs read carries the filter", async () => {
    const { GET } = await import("@/app/api/jobs/recommended/route");
    const body = await (await GET(req("/api/jobs/recommended?pageSize=10", "tok-pro"))).json();
    expect(body.isPro).toBe(true);
    expect(ids(body)).toEqual([GH, NUL, ARB]);
    expect(body.totalCount).toBe(3);
    const reads = jobReads();
    expect(reads.map((q) => q.table)).toEqual(["jobs", "jobs"]); // candidates + Pro hydration
    expect(reads.every((q) => q.ors.includes(VISIBLE_SOURCE_FILTER))).toBe(true);
  });

  it("anon branch (jobs_public, no service key): no jobspy row", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("@/app/api/jobs/recommended/route");
    const body = await (await GET(req("/api/jobs/recommended?pageSize=10"))).json();
    expect(ids(body)).toEqual([GH, NUL, ARB]);
    expect(jobReads().map((q) => q.table)).toEqual(["jobs_public"]);
    expect(jobReads()[0].ors).toContain(VISIBLE_SOURCE_FILTER);
  });
});

describe("/api/jobs/search", () => {
  it("list and count exclude jobspy", async () => {
    const { GET } = await import("@/app/api/jobs/search/route");
    const body = await (await GET(req("/api/jobs/search?limit=10"))).json();
    expect(ids(body)).not.toContain(SPY);
    expect(ids(body)).toEqual(expect.arrayContaining([GH, NUL, ARB]));
    expect(jobReads().every((q) => q.ors.includes(VISIBLE_SOURCE_FILTER))).toBe(true);
  });

  it("direct detail of a jobspy id is not found (route's not-found shape: jobs []); a visible id is returned", async () => {
    const { GET } = await import("@/app/api/jobs/search/route");
    expect(ids(await (await GET(req(`/api/jobs/search?id=${SPY}`))).json())).toEqual([]);
    expect(ids(await (await GET(req(`/api/jobs/search?id=${GH}`))).json())).toEqual([GH]);
  });
});

describe("/api/jobs/pro", () => {
  it("Pro direct detail of a jobspy id is not found", async () => {
    const { GET } = await import("@/app/api/jobs/pro/route");
    expect((await GET(req(`/api/jobs/pro?id=${SPY}`, "tok-pro"))).status).toBe(404);
    expect((await GET(req(`/api/jobs/pro?id=${GH}`, "tok-pro"))).status).toBe(200);
  });

  it("unlock hydration by ids returns only visible jobs", async () => {
    const { POST } = await import("@/app/api/jobs/pro/route");
    const res = await POST(req("/api/jobs/pro", "tok-pro", {
      method: "POST", body: JSON.stringify({ ids: [SPY, GH, NUL] }), headers: { "content-type": "application/json" },
    }));
    const body = await res.json();
    expect(ids(body).sort()).toEqual([GH, NUL].sort());
  });
});

describe("counts and other lists", () => {
  it("/api/stats active count excludes jobspy", async () => {
    const { GET } = await import("@/app/api/stats/route");
    await GET(req("/api/stats"));
    const counts = jobReads();
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((q) => q.ors.includes(VISIBLE_SOURCE_FILTER))).toBe(true);
  });

  it("service.getLiveJobById: jobspy id is not found, visible id is", async () => {
    const { getLiveJobById } = await import("@/lib/jobs/service");
    expect(await getLiveJobById(SPY)).toBeNull();
    expect((await getLiveJobById(GH))?.id).toBe(GH);
  });
});
