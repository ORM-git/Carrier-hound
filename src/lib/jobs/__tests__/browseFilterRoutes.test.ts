// Browse-only filters through the REAL /api/jobs/recommended and /api/jobs/search handlers and getLiveJobs.
// client serializer (getLiveJobs). The fake supabase client evaluates every filter the handlers send
// against fixture rows; pattern operators (ilike/imatch, plain or negated) are evaluated by REAL Postgres
// (PGlite), so SQL wildcards and regex escapes behave as in production.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// The first test of each describe cold-imports a full route module; under load that alone can pass 5s.
vi.setConfig({ testTimeout: 30000 });

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  users: {} as Record<string, { id: string; user_metadata: Record<string, unknown> }>,
  pg: null as any,
}));

vi.mock("@supabase/supabase-js", () => {
  const SQL_OP: Record<string, string> = { ilike: "ILIKE", like: "LIKE", imatch: "~*", match: "~" };
  // Real Postgres decides the pattern operators. PostgREST turns like-`*` into `%`.
  const pgMatch = async (value: unknown, op: string, pattern: string) => {
    if (value == null) return null; // SQL NULL: neither the condition nor its negation passes
    const pat = op === "ilike" || op === "like" ? pattern.replace(/\*/g, "%") : pattern;
    const r = await db.pg.query(`select ($1::text ${SQL_OP[op]} $2::text) as m`, [String(value), pat]);
    return r.rows[0].m as boolean;
  };
  function from(table: string) {
    const preds: Array<(r: any) => boolean | Promise<boolean>> = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let method = "select";
    const orders: Array<{ col: string; asc: boolean }> = [];
    const run = async () => {
      if (method !== "select") return { data: [], error: null, count: 0 };
      const keep: any[] = [];
      for (const r of db.tables[table] || []) {
        let ok = true;
        for (const p of preds) if (!(await p(r))) { ok = false; break; }
        if (ok) keep.push(r);
      }
      let rows = keep;
      for (const o of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1)));
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return { data: rows, error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => ({ data: (await run()).data?.[0] ?? null, error: null });
        if (p === "select") return () => b;
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") return () => { method = String(p); return b; };
        if (p === "eq") return (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; };
        if (p === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
        if (p === "is") return (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return b; };
        if (p === "or") return (e: string) => { preds.push((r) => matchesPostgrestOr(e, r)); return b; };
        if (p === "ilike") return (c: string, pat: string) => { preds.push(async (r) => (await pgMatch(r[c], "ilike", pat)) === true); return b; };
        if (p === "filter") return (c: string, op: string, v: any) => {
          if (!(op in SQL_OP)) throw new Error(`fake: filter op ${op} not modelled`);
          preds.push(async (r) => (await pgMatch(r[c], op, v)) === true);
          return b;
        };
        if (p === "not") return (c: string, op: string, v: any) => {
          if (op in SQL_OP) preds.push(async (r) => (await pgMatch(r[c], op, v)) === false);
          else if (op === "is") preds.push((r) => (r[c] ?? null) !== v);
          else throw new Error(`fake: not.${op} not modelled`);
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
  const { PGlite } = await import("@electric-sql/pglite");
  db.pg = new PGlite();
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
    job("Editor", "O'Reilly Media", 7),
    job("Writer", "OZReilly Media", 8),
    job("C++ Developer", "Under_score Co", 9),
    job("CX Developer", "UnderXscore Co", 10),
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

const ALL = [
  "Backend Engineer", "C++ Developer", "CX Developer", "Data Engineer", "Editor", "Frontend Engineer", "Platform Engineer", "Sales Engineer",
  "Software Intern", "Unknown Date Engineer", "Writer",
];

// --- Browse filters (harness above copied verbatim from feedConstraintRoutes.test.ts) ---------------
// Fixture columns for the new predicates. NULL role_category / salary / period rows exercise the unknown rule.
const EXTRA: Record<string, Partial<{ role_category: string | null; salary_min: number | null; currency: string | null; salary_period: string | null }>> = {
  "Frontend Engineer": { role_category: "SDE", salary_min: 130000, currency: "USD", salary_period: "yearly" },
  "Sales Engineer": { role_category: "OTHER", salary_min: 90000, currency: "USD", salary_period: "yearly" },
  "Backend Engineer": { role_category: "SDE", salary_min: 9000000, currency: "INR", salary_period: "yearly" }, // ~107k USD
  "Software Intern": { role_category: "SDE", salary_min: 60, currency: "USD", salary_period: "hourly" }, // 124,800/yr
  "Platform Engineer": { role_category: "CLOUD", salary_min: 9000, currency: "EUR", salary_period: "monthly" }, // ~117k USD
  "Data Engineer": { role_category: "DATA", salary_min: 200000, currency: null, salary_period: "yearly" }, // unknown currency
  "Unknown Date Engineer": { role_category: null, salary_min: 150000, currency: "USD", salary_period: null }, // unknown period
};
beforeEach(() => {
  for (const r of rows) Object.assign(r, { role_category: null }, EXTRA[r.title] || {});
});

describe.each([
  ["recommended", recommended],
  ["search", search],
])("/api/jobs/%s browse filters", (_name, call) => {
  it("jobFunction: OR over role_category; NULL role_category never matches (PROPOSED rule)", async () => {
    expect(titles((await call("pageSize=50&jobFunction=SDE")).body)).toEqual(["Backend Engineer", "Frontend Engineer", "Software Intern"]);
    expect(titles((await call("pageSize=50&jobFunction=SDE&jobFunction=data")).body)).toEqual(["Backend Engineer", "Data Engineer", "Frontend Engineer", "Software Intern"]);
    expect(titles((await call("pageSize=50&jobFunction=SDE")).body)).not.toContain("Unknown Date Engineer");
  });

  it("jobFunction AND excluded title AND included company", async () => {
    expect(titles((await call("pageSize=50&jobFunction=SDE&excludeTitle=intern&includeCompany=globex")).body)).toEqual(["Backend Engineer"]);
  });

  it("invalid input is a 400 naming the field, never a silently broadened feed", async () => {
    const bad = await call("pageSize=50&jobFunction=SDE&jobFunction=marketing");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "invalid_filter", field: "jobFunctions", reason: 'unknown value "marketing"' });
    expect((await call("pageSize=50&minAnnualSalary=100000")).status).toBe(400);
    expect((await call("pageSize=50&minAnnualSalary=100000&minAnnualSalaryCurrency=XYZ")).status).toBe(400);
  });

  it("annual salary minimum compares across currencies and periods; NULL currency/period never match (PROPOSED)", async () => {
    const { status, body } = await call("pageSize=50&minAnnualSalary=100000&minAnnualSalaryCurrency=USD");
    expect(status).toBe(200);
    expect(titles(body)).toEqual(["Backend Engineer", "Frontend Engineer", "Platform Engineer", "Software Intern"]);
    expect(body.salaryFx).toMatchObject({ source: "static_fallback", baseCurrency: "USD", rates: { USD: 1, INR: 84 } });
  });

  it("the same threshold in INR gives the same set", async () => {
    expect(titles((await call("pageSize=50&minAnnualSalary=8400000&minAnnualSalaryCurrency=INR")).body)).toEqual(
      ["Backend Engineer", "Frontend Engineer", "Platform Engineer", "Software Intern"]
    );
  });

  it("no browse filter: salaryFx is null and every job is returned (no-op)", async () => {
    const { body } = await call("pageSize=50&jobFunction=&minAnnualSalary=");
    expect(titles(body)).toEqual(ALL);
    expect(body.salaryFx ?? null).toBeNull();
  });

  it("pagination covers the filtered set only", async () => {
    const qs = "jobFunction=SDE";
    const pages = [];
    for (const p of [1, 2, 3]) pages.push(...titles((await call(`pageSize=1&page=${p}&${qs}`)).body));
    expect(pages.sort()).toEqual(["Backend Engineer", "Frontend Engineer", "Software Intern"]);
    expect((await call(`pageSize=1&page=4&${qs}`)).body.jobs).toEqual([]);
  });

  it("needs the full jobs table: 503 without the service key, never jobs_public", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    expect((await call("pageSize=50&jobFunction=SDE", "")).status).toBe(503);
    expect((await call("pageSize=50&minAnnualSalary=1&minAnnualSalaryCurrency=USD", "")).status).toBe(503);
  });
});

describe("client serializer (getLiveJobs): browse filters", () => {
  async function capture(opts: Record<string, unknown>, status = 200, body: unknown = { jobs: [], totalCount: 0 }) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }));
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const result = await getLiveJobs({ page: 1, pageSize: 25, baseUrl: "http://x", ...opts } as any);
    return { url: urls[0] ? new URL(urls[0]) : null, result, calls: urls.length };
  }
  const browse = { jobFunctions: ["sde", "DATA"], excludedTitles: ["Sales"], includedCompanies: ["Acme"], excludedCompanies: ["Globex"], minAnnualSalary: 100000, minAnnualSalaryCurrency: "usd" };

  it("sends every browse field on the search path, without saved-constraint enforcement", async () => {
    const { url } = await capture({ sortBy: "newest", browse });
    expect(url!.pathname).toBe("/api/jobs/search");
    expect(url!.searchParams.getAll("jobFunction")).toEqual(["SDE", "DATA"]);
    expect(url!.searchParams.getAll("excludeTitle")).toEqual(["Sales"]);
    expect(url!.searchParams.getAll("includeCompany")).toEqual(["Acme"]);
    expect(url!.searchParams.getAll("excludeCompany")).toEqual(["Globex"]);
    expect(url!.searchParams.get("minAnnualSalary")).toBe("100000");
    expect(url!.searchParams.get("minAnnualSalaryCurrency")).toBe("USD");
  });

  it("sends the same fields on the recommended path", async () => {
    const { url } = await capture({ sortBy: "match", preferences: null, browse });
    expect(url!.pathname).toBe("/api/jobs/recommended");
    expect(url!.searchParams.getAll("jobFunction")).toEqual(["SDE", "DATA"]);
    expect(url!.searchParams.getAll("includeCompany")).toEqual(["Acme"]);
    expect(url!.searchParams.get("minAnnualSalaryCurrency")).toBe("USD");
  });

  it("a resume candidate with browse filters is routed to the server, never the direct jobs_public scan", async () => {
    const candidate = { skills: ["React", "TypeScript"], titles: ["Frontend Engineer"], updatedAt: "2026-11-25T00:00:00Z" };
    const { url } = await capture({ sortBy: "match", candidate, preferences: null, browse: { jobFunctions: ["SDE"] } });
    expect(url!.pathname).toBe("/api/jobs/search");
  });

  it("a 400 becomes error 'invalid_filter' with the server body (not degraded, no fallback query)", async () => {
    const body = { error: "invalid_filter", field: "jobFunctions", reason: 'unknown value "x"' };
    const { result, calls } = await capture({ sortBy: "newest", browse: { jobFunctions: ["x"] } }, 400, body);
    expect(result).toMatchObject({ error: "invalid_filter", jobs: [], filterError: body });
    expect(result.isDegraded).toBeFalsy();
    expect(calls).toBe(1);
  });

  it("salaryFx from the server is passed through to the caller", async () => {
    const salaryFx = { source: "static_fallback", fetchedAt: null, rates: { USD: 1 }, baseCurrency: "USD" };
    const { result } = await capture({ sortBy: "newest", browse: { minAnnualSalary: 1, minAnnualSalaryCurrency: "USD" } }, 200, { jobs: [], totalCount: 0, salaryFx });
    expect(result.salaryFx).toEqual(salaryFx);
  });

  it("empty browse object is a no-op: no browse params", async () => {
    const { url } = await capture({ sortBy: "newest", search: "react", browse: { jobFunctions: [], excludedTitles: [] } });
    expect(Array.from(url!.searchParams.keys()).filter((k) => /jobFunction|minAnnual|excludeTitle|Company/.test(k))).toEqual([]);
  });
});
