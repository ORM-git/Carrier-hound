// Saved feed constraints through the REAL /api/jobs/recommended and /api/jobs/search handlers and the
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
  rpcCalls: [] as any[],
  failPreferredRead: false,
  cfEnv: undefined as Record<string, any> | undefined,
  preferredReads: 0,
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
  function from(table: string, pre?: (r: any) => boolean) {
    const preds: Array<(r: any) => boolean | Promise<boolean>> = pre ? [pre] : [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let method = "select";
    let selectedCols = "";
    const orders: Array<{ col: string; asc: boolean }> = [];
    const run = async () => {
      if (method !== "select") return { data: [], error: null, count: 0 };
      if (table === "user_preferences" && selectedCols === "preferred_skills") {
        db.preferredReads++;
        if (db.failPreferredRead) return { data: null, error: { code: "40001", message: "transient" }, count: 0 };
      }
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
        if (p === "select") return (cols?: string) => { if (typeof cols === "string") selectedCols = cols; return b; };
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
    rpc: (name: string, args: any) => {
      if (name !== "jobs_without_excluded_skills") return Promise.resolve({ data: null, error: { message: "no rpc in this fake" } });
      db.rpcCalls.push(args);
      // Models the RPC contract (exact skillKey equality on jobs.skills, empty/NULL kept); the SQL itself is proven in PGlite.
      const ex = new Set((args.p_excluded as string[]) || []);
      return from("jobs", (r) => !(r.skills || []).some((x: string) => ex.has(x.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase()))));
    },
    auth: {
      getUser: async (token?: string) => ({ data: { user: db.users[token || ""] ?? null }, error: db.users[token || ""] ? null : { message: "no session" } }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };
  return { createClient: () => client, __client: client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: db.cfEnv }) }));
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

describe.each([
  ["recommended", recommended],
  ["search", search],
])("/api/jobs/%s applies saved constraints before pagination", (_name, call) => {
  it("baseline: no constraint returns every visible job", async () => {
    expect(titles((await call("pageSize=50")).body)).toEqual(ALL);
  });

  it("excluded titles: any listed word hides the job (OR inside, case-insensitive)", async () => {
    const { body } = await call("pageSize=50&excludeTitle=sales&excludeTitle=INTERN");
    expect(titles(body)).toEqual(ALL.filter((t) => !["Sales Engineer", "Software Intern"].includes(t)));
  });

  it("excluded companies match exactly: Meta does not hide Metabase", async () => {
    const { body } = await call("pageSize=50&excludeCompany=meta");
    expect(titles(body)).not.toContain("Data Engineer");
    expect(titles(body)).toContain("Platform Engineer");
  });

  it("partial conflict: exclusion wins, the remaining inclusion still limits; AND with excluded titles", async () => {
    const { body } = await call("pageSize=50&includeCompany=Acme&includeCompany=Globex&excludeCompany=globex&excludeTitle=sales");
    expect(titles(body)).toEqual(["Frontend Engineer", "Unknown Date Engineer"]);
  });

  it("sole conflict (include Acme, exclude Acme) is an honest empty result: no Globex/Meta, total 0, no next page", async () => {
    const { status, body } = await call("pageSize=2&includeCompany=Acme&excludeCompany=ACME");
    expect(status).toBe(200);
    expect(body.jobs).toEqual([]);
    expect(body.totalCount ?? 0).toBe(0);
    expect(Boolean(body.hasNextPage)).toBe(false);
  });

  it("partial conflict paginates over the filtered set only", async () => {
    // include Acme + Globex, exclude Acme -> Globex's two jobs only
    const qs = "includeCompany=Acme&includeCompany=Globex&excludeCompany=acme";
    const p1 = (await call(`pageSize=1&page=1&${qs}`)).body;
    const p2 = (await call(`pageSize=1&page=2&${qs}`)).body;
    expect([...titles(p1), ...titles(p2)].sort()).toEqual(["Backend Engineer", "Software Intern"]);
    if (p1.totalCount) expect(p1.totalCount).toBe(2);
    expect((await call(`pageSize=1&page=3&${qs}`)).body.jobs).toEqual([]);
  });

  it("punctuation is literal: O'Reilly is not OZReilly, Under_score is not UnderXscore, C++ is not CX", async () => {
    expect(titles((await call("pageSize=50&excludeCompany=O'Reilly Media")).body)).toEqual(ALL.filter((t) => t !== "Editor"));
    expect(titles((await call("pageSize=50&excludeCompany=under_score co")).body)).toEqual(ALL.filter((t) => t !== "C++ Developer"));
    expect(titles((await call("pageSize=50&excludeTitle=c%2B%2B")).body)).toEqual(ALL.filter((t) => t !== "C++ Developer"));
    expect(titles((await call("pageSize=50&includeCompany=O'Reilly Media")).body)).toEqual(["Editor"]);
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
    if (p1.totalCount != null && p1.totalCount > 0) expect(p1.totalCount).toBeLessThanOrEqual(ALL.length - 1);
    const all = titles((await call("pageSize=50&excludeTitle=sales")).body);
    expect(all).toHaveLength(ALL.length - 1);
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

describe("client serializer (getLiveJobs): saved constraints are policy-gated", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS;
  });
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

  it("default (no owner decision): saved titles/companies/date are NOT sent; the browsing window still is", async () => {
    const u = await capture({ sortBy: "match", preferences: prefs, datePosted: "3d" });
    expect(u.searchParams.getAll("excludeTitle")).toEqual([]);
    expect(u.searchParams.getAll("includeCompany")).toEqual([]);
    expect(u.searchParams.getAll("excludeCompany")).toEqual([]);
    expect(u.searchParams.get("datePosted")).toBe("3d");
    const u2 = await capture({ sortBy: "match", preferences: prefs });
    expect(u2.searchParams.get("datePosted")).toBeNull();
  });

  it("enabled: repeated params, the full inclusion set kept (conflict settled server-side), narrower date wins", async () => {
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    const u = await capture({ sortBy: "match", preferences: prefs, datePosted: "30d" });
    expect(u.pathname).toBe("/api/jobs/recommended");
    expect(u.searchParams.getAll("excludeTitle")).toEqual(["Sales"]);
    expect(u.searchParams.getAll("includeCompany")).toEqual(["Acme, Inc."]);
    expect(u.searchParams.getAll("excludeCompany")).toEqual(["acme, inc.", "Globex"]);
    expect(u.searchParams.get("datePosted")).toBe("7d");
  });

  it("browsing without preferences (other tabs) sends none of them", async () => {
    const u = await capture({ sortBy: "newest", preferences: null, search: "react" });
    expect(u.pathname).toBe("/api/jobs/search");
    expect(u.searchParams.getAll("excludeTitle")).toEqual([]);
    expect(u.searchParams.get("datePosted")).toBeNull();
  });
});

describe.each([
  ["recommended", recommended],
  ["search", search],
])("/api/jobs/%s applies the required-years range (inclusive overlap, unknown kept)", (_name, call) => {
  const years: Record<string, [number | null, number | null]> = {
    "Frontend Engineer": [2, 4],
    "Backend Engineer": [3, null],
    "Data Engineer": [null, 1],
    "Platform Engineer": [5, 8],
    "Editor": [0, 0],
  };
  beforeEach(() => {
    for (const r of rows as any[]) {
      const y = years[r.title];
      r.min_experience_years = y ? y[0] : null;
      r.max_experience_years = y ? y[1] : null;
    }
  });
  const UNKNOWN = ["C++ Developer", "CX Developer", "Sales Engineer", "Software Intern", "Unknown Date Engineer", "Writer"];

  it("0-2: touching 2-4 passes, 3+ and 5-8 do not, 'up to 1' and 0-0 pass, unknown stays", async () => {
    const { body } = await call("pageSize=50&yearsMin=0&yearsMax=2");
    expect(titles(body)).toEqual(["Data Engineer", "Editor", "Frontend Engineer", ...UNKNOWN].sort());
  });
  it("lower handle only (3, no upper bound): 3+ and 5-8 pass, 'up to 1' does not", async () => {
    const { body } = await call("pageSize=50&yearsMin=3");
    expect(titles(body)).toEqual(["Backend Engineer", "Frontend Engineer", "Platform Engineer", ...UNKNOWN].sort());
  });
  it("0..top (no params) is no filter; junk values are ignored, never turned into a filter", async () => {
    expect(titles((await call("pageSize=50&yearsMin=abc&yearsMax=Infinity")).body)).toEqual(ALL);
    expect(titles((await call("pageSize=50&yearsMin=-3")).body)).toEqual(ALL);
  });
  it("ANDs with other constraints", async () => {
    const { body } = await call("pageSize=50&yearsMin=3&excludeCompany=Globex");
    expect(titles(body)).toEqual(["Frontend Engineer", "Platform Engineer", ...UNKNOWN.filter((t) => !["Software Intern"].includes(t))].sort());
  });
  it("without the service key the range is refused (503), never silently broadened", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { status } = await call("pageSize=50&yearsMin=3");
    expect(status).toBe(503);
  });
});

describe.each([
  ["recommended", recommended],
  ["search", search],
])("/api/jobs/%s excluded skills (database RPC before paging; Free and Pro alike)", (_name, call) => {
  const ex = (...v: string[]) => `excludedSkills=${encodeURIComponent(JSON.stringify(v))}`;
  beforeEach(() => {
    db.rpcCalls.length = 0;
    process.env.CM_EXCLUDED_SKILLS_RPC = "1";
    const skills: Record<string, string[] | null> = { "Frontend Engineer": ["React", "CSS"], "Backend Engineer": [" react native "], "Data Engineer": ["SQL"], "Writer": [], "Editor": null };
    for (const r of rows as any[]) r.skills = skills[r.title] ?? ["Go"];
  });
  afterEach(() => { delete process.env.CM_EXCLUDED_SKILLS_RPC; });

  it("hides exact matches only; React does not hide React Native; empty and unknown skills are kept; ANDs with other filters", async () => {
    const t = titles((await call(`pageSize=50&${ex("react")}`)).body);
    expect(t).not.toContain("Frontend Engineer");
    expect(t).toContain("Backend Engineer");
    expect(t).toContain("Writer");
    expect(t).toContain("Editor");
    expect(titles((await call(`pageSize=50&${ex("REACT ", "react native")}`)).body)).not.toEqual(expect.arrayContaining(["Backend Engineer"]));
    expect(titles((await call(`pageSize=50&${ex("sql")}&excludeCompany=Globex`)).body)).not.toContain("Data Engineer");
    expect(db.rpcCalls[0]).toEqual({ p_excluded: ["react"] });
  });
  it("ABSENT or a valid empty list is a no-op and never calls the RPC", async () => {
    expect(titles((await call("pageSize=50")).body)).toEqual(ALL);
    expect(titles((await call(`pageSize=50&${ex()}`)).body)).toEqual(ALL);
    expect(db.rpcCalls).toEqual([]);
  });
  it("PRESENT but invalid is rejected with 400 before any query, even with the readiness flag off: never an unfiltered feed", async () => {
    const bad = [
      "notjson", "%7B%7D", "null", encodeURIComponent('[null]'), encodeURIComponent('[5]'), encodeURIComponent('["react",""]'),
      encodeURIComponent('["  "]'), encodeURIComponent(JSON.stringify(Array.from({ length: 51 }, (_, i) => `s${i}`))),
      encodeURIComponent(JSON.stringify(["a".repeat(101)])), encodeURIComponent('"react"'), "",
    ];
    for (const flag of ["1", undefined]) {
      if (flag) process.env.CM_EXCLUDED_SKILLS_RPC = flag; else delete process.env.CM_EXCLUDED_SKILLS_RPC;
      for (const b of bad) {
        const r = await call(`pageSize=50&excludedSkills=${b}`);
        expect([b, r.status]).toEqual([b, 400]);
        expect(titles(r.body)).toEqual([]);
      }
    }
    expect(db.rpcCalls).toEqual([]);
  });
  it("boundaries: 50 items and 100 characters are accepted", async () => {
    const ok = await call(`pageSize=50&${ex("a".repeat(100))}`);
    expect(ok.status).toBe(200);
    const fifty = await call(`pageSize=50&${ex(...Array.from({ length: 50 }, (_, i) => `s${i}`))}`);
    expect(fifty.status).toBe(200);
  });
  it("RPC not applied (readiness flag off) or no service key: refused with 503, never silently broadened", async () => {
    delete process.env.CM_EXCLUDED_SKILLS_RPC;
    expect((await call(`pageSize=50&${ex("react")}`)).status).toBe(503);
    process.env.CM_EXCLUDED_SKILLS_RPC = "1";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await call(`pageSize=50&${ex("react")}`)).status).toBe(503);
  });
});

describe("client serializer: saved excluded skills", () => {
  const capture = async (opts: Record<string, unknown>) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { getLiveJobs } = await import("@/lib/jobs/service");
    await getLiveJobs({ page: 1, pageSize: 25, baseUrl: "http://x", ...opts } as any);
    return new URL(urls[0]);
  };
  const prefs = { roles: [], categories: [], employmentTypes: [], locations: [], remotePreference: "any", dailyDigestOptIn: false, onboardingCompleted: true, updatedAt: "2026-11-25T00:00:00Z", excludedSkills: [" React ", "react", "SQL"] };
  afterEach(() => { delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS; });
  it("gate off: never sent. gate on: sent once, keyed and deduped, personalized feed only", async () => {
    expect((await capture({ sortBy: "match", preferences: prefs })).searchParams.get("excludedSkills")).toBeNull();
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    expect(JSON.parse((await capture({ sortBy: "match", preferences: prefs })).searchParams.get("excludedSkills")!)).toEqual(["React", "SQL"]);
    expect((await capture({ sortBy: "newest", preferences: prefs })).searchParams.get("excludedSkills")).toBeNull();
    expect((await capture({ sortBy: "match", preferences: { ...prefs, advancedPreferencesAvailable: false } })).searchParams.get("excludedSkills")).toBeNull();
  });
});

describe("/api/jobs/recommended preferred skills: ranking only, Pro only effect, off by default", () => {
  const prefsRow = (id: string) => ({ user_id: id, roles: ["Engineer"], experience_level: "mid", remote_preference: "any", locations: [], employment_types: [], categories: [], preferred_skills: [" REACT "] });
  const order = async (token: string) => (await recommended("pageSize=50", token)).body.jobs.map((j: any) => byTitle[j.id]);
  beforeEach(() => {
    for (const r of rows as any[]) r.skills = r.title === "CX Developer" ? ["React"] : ["Vue"];
    db.tables.user_preferences = [prefsRow("pro-1"), prefsRow("free-1")];
  });
  afterEach(() => { delete process.env.CM_PREFERRED_SKILLS_RANKING; delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS; db.failPreferredRead = false; db.cfEnv = undefined; });

  it("flag off: identical order for everyone. Flag on: Pro moves the React job up within its tier, Free is unchanged, nothing is hidden", async () => {
    const proOff = await order("tok-pro");
    const freeOff = await order("tok-free");
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    const proOn = await order("tok-pro");
    const freeOn = await order("tok-free");
    expect(proOn.slice().sort()).toEqual(proOff.slice().sort());
    expect(freeOn).toEqual(freeOff);
    expect(proOff.indexOf("CX Developer")).toBeGreaterThan(proOff.indexOf("Editor"));
    expect(proOn.indexOf("CX Developer")).toBeLessThan(proOn.indexOf("Editor"));
  });

  const cx = (body: any) => body.jobs.find((j: any) => byTitle[j.id] === "CX Developer");
  const detail = async (id: string, token: string) => (await search(`id=${id}`, token)).body;

  it("route parity: card (recommended) and detail (search?id=) show the same score for Pro with the boost on; Free equals its no-preference score", async () => {
    const cxId = (rows as any[]).find((r) => r.title === "CX Developer").id;
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    const freeOff = cx((await recommended("pageSize=50", "tok-free")).body).matchScore;
    const proOff = cx((await recommended("pageSize=50", "tok-pro")).body).matchScore;
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    const proCard = cx((await recommended("pageSize=50", "tok-pro")).body);
    const freeCard = cx((await recommended("pageSize=50", "tok-free")).body);
    const proDetail = (await detail(cxId, "tok-pro")).jobs[0];
    const freeDetail = (await detail(cxId, "tok-free")).jobs[0];
    expect(proCard.matchScore).toBeGreaterThan(proOff);
    expect(proDetail.matchScore).toBe(proCard.matchScore);
    expect(freeCard.matchScore).toBe(freeOff);
    expect(freeDetail.matchScore).toBe(freeCard.matchScore);
  });
  it("gate OFF with the flag ON: no boost anywhere and no preferred-skills read at all", async () => {
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS;
    db.preferredReads = 0;
    const o = await order("tok-pro");
    expect(o.indexOf("CX Developer")).toBeGreaterThan(o.indexOf("Editor"));
    expect(db.preferredReads).toBe(0);
  });
  it("one read per request; a failed read means no boost (same rank and display), never an error", async () => {
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    db.preferredReads = 0;
    await order("tok-pro");
    expect(db.preferredReads).toBe(1);
    db.failPreferredRead = true;
    const failed = await recommended("pageSize=50", "tok-pro");
    expect(failed.status).toBe(200);
    const off = cx((await (async () => { delete process.env.CM_PREFERRED_SKILLS_RANKING; return recommended("pageSize=50", "tok-pro"); })()).body);
    expect(cx(failed.body).matchScore).toBe(off.matchScore);
    expect(failed.body.jobs.map((j: any) => byTitle[j.id])).toEqual((await recommended("pageSize=50", "tok-pro")).body.jobs.map((j: any) => byTitle[j.id]));
  });

  it("reviewer POST unlock binding-only bonus, gate-off/error fallback, and auth failures", async () => {
    const cxId = (rows as any[]).find((r) => r.title === "CX Developer").id;
    const { POST } = await import("@/app/api/jobs/pro/route");
    const unlock = async (token: string, ids: unknown = [cxId]) => {
      const r = await POST(new Request("http://x/api/jobs/pro", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }));
      return { status: r.status, body: await r.json() };
    };
    const off = await unlock("tok-pro");
    expect(off.status).toBe(200);
    db.cfEnv = { CM_PREFERRED_SKILLS_RANKING: "1", NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: "true" };
    db.preferredReads = 0;
    const on = await unlock("tok-pro");
    expect(on.status).toBe(200);
    expect(db.preferredReads).toBe(1);
    expect(on.body.jobs[0].matchScore).toBeGreaterThan(off.body.jobs[0].matchScore);
    const card = cx((await recommended("pageSize=50", "tok-pro")).body);
    expect(on.body.jobs[0].matchScore).toBe(card.matchScore);
    expect(on.body.jobs[0].scoreRevision).toBe(card.scoreRevision);
    db.failPreferredRead = true;
    expect((await unlock("tok-pro")).body.jobs[0].matchScore).toBe(off.body.jobs[0].matchScore);
    db.failPreferredRead = false;
    db.cfEnv.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "false";
    expect((await unlock("tok-pro")).body.jobs[0].matchScore).toBe(off.body.jobs[0].matchScore);
    expect((await unlock("tok-free")).status).toBe(403);
    expect((await unlock("bad-token")).status).toBe(401);
    expect((await unlock("tok-pro", [])).status).toBe(400);
  });

  it("Cloudflare-binding-only flags (nothing in process.env): list, detail and the Pro endpoint all boost the same Pro score", async () => {
    db.cfEnv = { CM_PREFERRED_SKILLS_RANKING: "1", NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: "true" };
    const cxId = (rows as any[]).find((r) => r.title === "CX Developer").id;
    const { GET: proGET } = await import("@/app/api/jobs/pro/route");
    const proRes = await proGET(req(`/api/jobs/pro?id=${cxId}`, "tok-pro"));
    const proBody = await proRes.json();
    const proJob = proBody.job ?? proBody.jobs?.[0] ?? proBody;
    const card = cx((await recommended("pageSize=50", "tok-pro")).body);
    const det = (await detail(cxId, "tok-pro")).jobs[0];
    db.cfEnv = undefined;
    const off = cx((await recommended("pageSize=50", "tok-pro")).body);
    expect(card.matchScore).toBeGreaterThan(off.matchScore);
    expect(det.matchScore).toBe(card.matchScore);
    expect(proJob.matchScore).toBe(card.matchScore);
  });
});
