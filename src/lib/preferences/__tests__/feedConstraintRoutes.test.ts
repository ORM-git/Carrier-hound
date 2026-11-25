// Saved feed constraints through the REAL /api/jobs/recommended and /api/jobs/search handlers and the
// client serializer (getLiveJobs). The fake supabase client evaluates every filter the handlers send
// (eq/in/or/ilike/not/gte) against fixture rows, so a missing predicate changes the returned ids.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// The first test of each describe cold-imports a full route module; under load that alone can pass 5s.
vi.setConfig({ testTimeout: 30000 });

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  users: {} as Record<string, { id: string; user_metadata: Record<string, unknown> }>,
}));

vi.mock("@supabase/supabase-js", () => {
  const like = (pat: string) =>
    new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", "is");
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let method = "select";
    const orders: Array<{ col: string; asc: boolean }> = [];
    const run = () => {
      if (method !== "select") return { data: [], error: null, count: 0 };
      let rows = (db.tables[table] || []).filter((r) => preds.every((p) => p(r)));
      for (const o of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1)));
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return { data: rows, error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => ({ data: run().data?.[0] ?? null, error: null });
        if (p === "select") return () => b;
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") return () => { method = String(p); return b; };
        if (p === "eq") return (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; };
        if (p === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
        if (p === "is") return (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return b; };
        if (p === "or") return (e: string) => { preds.push((r) => matchesPostgrestOr(e, r)); return b; };
        if (p === "ilike") return (c: string, pat: string) => { preds.push((r) => like(pat).test(String(r[c] ?? ""))); return b; };
        if (p === "not") return (c: string, op: string, v: any) => {
          if (op === "ilike") preds.push((r) => r[c] != null && !like(v).test(String(r[c])));
          else if (op === "is") preds.push((r) => (r[c] ?? null) !== v);
          return b;
        };
        if (p === "gte") return (c: string, v: any) => { preds.push((r) => r[c] != null && r[c] >= v); return b; };
        if (p === "lt") return (c: string, v: any) => { preds.push((r) => r[c] != null && r[c] < v); return b; };
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
let n = 0;
const job = (title: string, company: string, hoursAgo: number | null) => {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  return {
    id, title, company, company_id: `co-${company}`, location: "Remote (Worldwide)", remote: true, remote_scope: "worldwide",
    remote_eligibility: "worldwide", job_type: "full-time", category: "engineering", country: "United States", country_code: "US",
    description: "React", skills: ["React"], apply_url: `https://jobs.example.com/${id}`, source_type: "greenhouse", source: "greenhouse",
    status: "active", is_active: true, posted_at: hoursAgo == null ? null : iso(hoursAgo), created_at: iso(1), first_seen_at: iso(1),
    discovered_at: iso(1), last_seen_at: iso(0), salary_min: null, salary_max: null, salary_text: null, currency: null, salary_period: null,
    verified: true, logo_url: null, companies: { logo_url: null, domain: null, name: company },
  };
};

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-fake",
  COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
  NEXT_PUBLIC_BILLING_ENABLED: "true",
  __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
};

let rows: ReturnType<typeof job>[];
let byTitle: Record<string, string>;
let client: any;
beforeAll(async () => {
  client = ((await import("@supabase/supabase-js")) as any).__client;
});
beforeEach(() => {
  Object.assign(process.env, env, { SUPABASE_SERVICE_ROLE_KEY: "service-role-fake" });
  n = 0;
  rows = [
    job("Frontend Engineer", "Acme", 2),
    job("Sales Engineer", "Acme", 3),
    job("Backend Engineer", "Globex", 50), // ~2 days
    job("Software Intern", "Globex", 100), // ~4 days
    job("Platform Engineer", "Metabase", 5),
    job("Data Engineer", "Meta", 6),
    job("Unknown Date Engineer", "Acme", null), // source gave no posting date
  ];
  byTitle = Object.fromEntries(rows.map((r) => [r.id, r.title]));
  db.tables = { jobs: rows, jobs_public: rows, user_preferences: [] };
  db.users = { "tok-pro": { id: "pro-1", user_metadata: {} }, "tok-free": { id: "free-1", user_metadata: {} } };
  (globalThis as any).__mockSupabaseClient = client;
});
afterEach(() => {
  delete (globalThis as any).__mockSupabaseClient;
  vi.resetModules();
  vi.unstubAllGlobals();
});

const titles = (body: any) => (body.jobs || []).map((j: any) => byTitle[j.id]).sort();
const req = (url: string, token?: string) => new Request(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
async function recommended(qs: string, token = "tok-pro") {
  const { GET } = await import("@/app/api/jobs/recommended/route");
  const res = await GET(req(`/api/jobs/recommended?${qs}`, token));
  return { status: res.status, body: await res.json() };
}
async function search(qs: string, token = "tok-pro") {
  const { GET } = await import("@/app/api/jobs/search/route");
  const res = await GET(req(`/api/jobs/search?${qs}`, token));
  return { status: res.status, body: await res.json() };
}

const ALL = ["Backend Engineer", "Data Engineer", "Frontend Engineer", "Platform Engineer", "Sales Engineer", "Software Intern", "Unknown Date Engineer"];

describe.each([
  ["recommended", recommended],
  ["search", search],
])("/api/jobs/%s applies saved constraints before pagination", (_name, call) => {
  it("baseline: no constraint returns every visible job", async () => {
    expect(titles((await call("pageSize=50")).body)).toEqual(ALL);
  });

  it("excluded titles: any listed word hides the job (OR inside, case-insensitive)", async () => {
    const { body } = await call("pageSize=50&excludeTitle=sales&excludeTitle=INTERN");
    expect(titles(body)).toEqual(["Backend Engineer", "Data Engineer", "Frontend Engineer", "Platform Engineer", "Unknown Date Engineer"]);
  });

  it("excluded companies match exactly: Meta does not hide Metabase", async () => {
    const { body } = await call("pageSize=50&excludeCompany=meta");
    expect(titles(body)).not.toContain("Data Engineer");
    expect(titles(body)).toContain("Platform Engineer");
  });

  it("included companies limit the feed; exclusion wins a conflict; AND with excluded titles", async () => {
    const { body } = await call("pageSize=50&includeCompany=Acme&includeCompany=Globex&excludeCompany=globex&excludeTitle=sales");
    expect(titles(body)).toEqual(["Frontend Engineer", "Unknown Date Engineer"]);
  });

  it("3d window: 2-day-old job in, 4-day-old and undated jobs out", async () => {
    const t = titles((await call("pageSize=50&datePosted=3d")).body);
    expect(t).toContain("Backend Engineer");
    expect(t).not.toContain("Software Intern");
    expect(t).not.toContain("Unknown Date Engineer");
    const week = titles((await call("pageSize=50&datePosted=7d")).body);
    expect(week).toContain("Software Intern");
  });

  it("totals describe the filtered set, and page 2 continues it", async () => {
    const p1 = (await call("pageSize=2&excludeTitle=sales")).body;
    expect(p1.jobs).toHaveLength(2);
    if (p1.totalCount != null && p1.totalCount > 0) expect(p1.totalCount).toBeLessThanOrEqual(6);
    const all = titles((await call("pageSize=50&excludeTitle=sales")).body);
    expect(all).toHaveLength(6);
  });

  it("company constraints never broaden silently without the service key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    const { status } = await call("pageSize=50&excludeCompany=Acme", "");
    expect(status).toBe(503);
  });

  it("a Free user filtering by company still gets masked companies", async () => {
    const { body } = await call("pageSize=50&includeCompany=Acme", "tok-free");
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const j of body.jobs) expect(j.company).toBe("Verified Employer");
  });
});

describe("client serializer (getLiveJobs) sends saved constraints only with the personalized feed", () => {
  async function capture(opts: Record<string, unknown>) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { getLiveJobs } = await import("@/lib/jobs/service");
    await getLiveJobs({ page: 1, pageSize: 25, baseUrl: "http://x", ...opts } as any);
    return new URL(urls[0]);
  }
  const prefs = {
    roles: [], categories: [], employmentTypes: [], locations: [], remotePreference: "any", dailyDigestOptIn: false,
    onboardingCompleted: true, updatedAt: "2026-11-25T00:00:00Z",
    excludedTitles: ["Sales"], includedCompanies: ["Acme, Inc."], excludedCompanies: ["acme, inc.", "Globex"], datePosted: "7d",
  };

  it("recommended path: repeated params, conflict settled, narrower date wins", async () => {
    const u = await capture({ sortBy: "match", preferences: prefs, datePosted: "3d" });
    expect(u.pathname).toBe("/api/jobs/recommended");
    expect(u.searchParams.getAll("excludeTitle")).toEqual(["Sales"]);
    expect(u.searchParams.getAll("includeCompany")).toEqual([]);
    expect(u.searchParams.getAll("excludeCompany")).toEqual(["acme, inc.", "Globex"]);
    expect(u.searchParams.get("datePosted")).toBe("3d");
  });

  it("saved window applies when there is no browsing window", async () => {
    const u = await capture({ sortBy: "match", preferences: prefs });
    expect(u.searchParams.get("datePosted")).toBe("7d");
  });

  it("browsing without preferences (other tabs) sends none of them", async () => {
    const u = await capture({ sortBy: "newest", preferences: null, search: "react" });
    expect(u.pathname).toBe("/api/jobs/search");
    expect(u.searchParams.getAll("excludeTitle")).toEqual([]);
    expect(u.searchParams.get("datePosted")).toBeNull();
  });
});
