// Multi-select Job Type and Work Model through the REAL handlers (Next /api/jobs/search, /api/jobs/recommended,
// the routed Netlify jobs-search function) and the real getLiveJobs request serialization and direct/category-
// fallback queries. Only Supabase is faked; `.or()`/`.ilike()` evaluate PostgREST logic trees with SQL NULLs.
// Expected sets come from plain predicates written here, not from the shared helper under test.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";
import { matchesJobTypeFilter, matchesWorkModelFilter } from "@/lib/jobs/jobFilters";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
}));

vi.mock("@supabase/supabase-js", async () => {
  const { matchesPostgrestOr: orMatch } = await import("@/lib/jobs/__tests__/postgrestLogicTree");
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    const run = () => {
      let data = (state.tables[table] || []).filter((r) => preds.every((p) => p(r)));
      data = [...data].sort((a, b) => {
        for (const o of orders) {
          if (a[o.col] === b[o.col]) continue;
          if (a[o.col] == null) return 1;
          if (b[o.col] == null) return -1;
          return (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1);
        }
        return 0;
      });
      const count = data.length;
      if (range) data = data.slice(range[0], range[1] + 1);
      else if (limit !== null) data = data.slice(0, limit);
      return { data, count, error: null };
    };
    const b: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
          if (prop === "eq") return (c: string, v: unknown) => (preds.push((r) => r[c] === v), b);
          if (prop === "neq") return (c: string, v: unknown) => (preds.push((r) => r[c] !== v), b);
          if (prop === "in") return (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b);
          if (prop === "gte") return (c: string, v: any) => (preds.push((r) => r[c] != null && r[c] >= v), b);
          if (prop === "lte") return (c: string, v: any) => (preds.push((r) => r[c] != null && r[c] <= v), b);
          if (prop === "ilike") return (c: string, p: string) => (preds.push((r) => orMatch(`${c}.ilike.${p}`, r)), b);
          if (prop === "or") return (expr: string) => (preds.push((r) => orMatch(expr, r)), b);
          if (prop === "not") return (c: string, op: string, v: any) => (preds.push((r) => orMatch(`${c}.not.${op}.${v}`, r)), b);
          if (prop === "is") return (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b);
          if (prop === "order") return (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), b);
          if (prop === "range") return (f: number, t: number) => ((range = [f, t]), b);
          if (prop === "limit") return (n: number) => ((limit = n), b);
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: run().data[0] ?? null, error: null });
          return () => b; // select, textSearch, etc.
        },
      }
    );
    return b;
  }
  const client = {
    auth: {
      getUser: async (token: string) => {
        const user = state.users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
      getSession: async () => ({ data: { session: null }, error: null }),
    },
    from,
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };
  (globalThis as any).__fakeSupabase = client;
  return { createClient: () => client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

const day = (n: number) => new Date(Date.UTC(2026, 10, 18 - n)).toISOString();
type Row = { title: string; job_type: string | null; remote: boolean | null; location: string; remote_scope: string | null; category?: string };
const job = (i: number, r: Row) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  company: `Company ${i}`,
  companies: { name: `Company ${i}`, logo_url: null },
  company_id: `co_${i}`,
  category: "engineering",
  country_code: "US",
  verified: true,
  posted_at: day(i),
  created_at: day(i),
  salary_min: 100000,
  salary_max: 150000,
  currency: "USD",
  salary_period: "year",
  salary_text: "$100k - $150k",
  apply_url: `https://careers.example.com/apply/${i}`,
  description: "Listed requirements",
  skills: ["TypeScript"],
  status: "active",
  is_active: true,
  ...r,
});
const JOBS = [
  job(1, { title: "Senior Backend Engineer", job_type: "full-time", remote: true, location: "Remote", remote_scope: "worldwide" }),
  job(2, { title: "Frontend Engineer", job_type: "contract", remote: false, location: "Austin, TX (Hybrid)", remote_scope: "hybrid" }),
  job(3, { title: "Data Engineer", job_type: "part-time", remote: false, location: "Austin, TX", remote_scope: "onsite" }),
  job(4, { title: "Engineering Intern", job_type: "internship", remote: true, location: "Remote", remote_scope: null }),
  job(5, { title: "Platform Engineer", job_type: null, remote: false, location: "Berlin (Hybrid)", remote_scope: "hybrid" }),
  job(6, { title: "Senior Product Designer", job_type: "Full_Time", remote: false, location: "Austin, TX", remote_scope: null, category: "design" }),
  job(7, { title: "Site Reliability Engineer", job_type: "contractor", remote: true, location: "Remote - US", remote_scope: null }),
  job(8, { title: "Senior Hybrid Engineer", job_type: "full-time", remote: false, location: "Austin, TX", remote_scope: "hybrid" }),
  job(9, { title: "QA Engineer", job_type: "contract", remote: null, location: "Austin, TX", remote_scope: null }),
];

// Independent oracle (SQL semantics: NULL job_type / NULL remote never satisfy a predicate on that column).
const oracleType = (sel: string) => (j: (typeof JOBS)[number]) => {
  const t = (j.job_type || "").toLowerCase();
  return !!j.job_type && sel.split(",").some((s) => {
    const k = s.trim().toLowerCase();
    return t.includes(k.includes("full") ? "full" : k.includes("contract") ? "contract" : k.includes("part") ? "part" : k.includes("intern") ? "intern" : k);
  });
};
const oracleWork = (sel: string) => (j: (typeof JOBS)[number]) => {
  const loc = j.location.toLowerCase();
  return sel.split(",").some((s) => {
    const k = s.trim().toLowerCase();
    if (k === "remote") return j.remote === true || loc.includes("remote");
    if (k === "hybrid") return loc.includes("hybrid") || j.remote_scope === "hybrid";
    if (k === "onsite") return j.remote === false || loc.includes("onsite");
    return false;
  });
};
const titlesWhere = (...ps: Array<(j: (typeof JOBS)[number]) => boolean>) =>
  JOBS.filter((j) => ps.every((p) => p(j))).map((j) => j.title).sort();

let nextSearch: (r: Request) => Promise<Response>;
let nextRecommended: (r: Request) => Promise<Response>;
let netlifySearch: (e: any) => Promise<any>;
const originalFetch = globalThis.fetch;
const fetched: string[] = [];

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "group-secret-for-tests-0123456789",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  nextSearch = (await import("@/app/api/jobs/search/route")).GET;
  nextRecommended = (await import("@/app/api/jobs/recommended/route")).GET;
  netlifySearch = (await import("../../../../../netlify/functions/jobs-search")).handler as any;
}, 60000);

beforeEach(() => {
  state.users = {
    "tok-free": { id: "u_free", email: "free@example.com", user_metadata: {} },
    "tok-pro": { id: "u_pro", email: "pro@example.com", user_metadata: {} },
  };
  state.tables = {
    jobs: JOBS.map((j) => ({ ...j })),
    jobs_public: JOBS.map((j) => ({ ...j })),
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
  };
  fetched.length = 0;
  (globalThis as any).__mockSupabaseClient = (globalThis as any).__fakeSupabase;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    if (url.includes("/api/jobs/recommended")) return nextRecommended(new Request(url, init));
    if (url.includes("/api/jobs/search")) return nextSearch(new Request(url, init));
    return originalFetch(input, init);
  }) as any;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as any).__mockSupabaseClient;
});

const auth = (token?: string): RequestInit => ({ headers: token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>) });
async function viaNext(qs: string, token?: string) {
  const res = await nextSearch(new Request(`http://localhost/api/jobs/search?${qs}&pageSize=50`, auth(token)));
  expect(res.status).toBe(200);
  return res.json();
}
async function viaRecommended(qs: string, token?: string) {
  const res = await nextRecommended(new Request(`http://localhost/api/jobs/recommended?${qs}&pageSize=50`, auth(token)));
  expect(res.status).toBe(200);
  return res.json();
}
async function viaNetlify(qs: string, token?: string) {
  const res = await netlifySearch({
    httpMethod: "GET",
    path: "/api/jobs/search",
    queryStringParameters: Object.fromEntries(new URLSearchParams(`${qs}&pageSize=50`)),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}
const titles = (body: any) => (body.jobs as any[]).map((j) => j.title).sort();
const ALL = JOBS.map((j) => j.title).sort();
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("Job Type: OR within the dimension on every server path", () => {
  // The UI serializes multi-select as "full-time, contract" (comma + space).
  const SEL = "full-time, contract";
  const expected = titlesWhere(oracleType(SEL));

  it("Full-time + Contract returns both types (search, Netlify, recommended; guest/Free/Pro)", async () => {
    expect(expected).toEqual(
      ["Frontend Engineer", "QA Engineer", "Senior Backend Engineer", "Senior Hybrid Engineer", "Senior Product Designer", "Site Reliability Engineer"].sort()
    );
    for (const token of [undefined, "tok-free", "tok-pro"]) {
      expect(titles(await viaNext(qs({ jobType: SEL }), token)), `search ${token}`).toEqual(expected);
      expect(titles(await viaNetlify(qs({ jobType: SEL }), token)), `netlify ${token}`).toEqual(expected);
      expect(titles(await viaRecommended(qs({ jobType: SEL }), token)), `recommended ${token}`).toEqual(expected);
    }
  });

  it("single selections, aliases, case/spacing keep their old meaning; NULL job_type never matches", async () => {
    const cases: Array<[string, string[]]> = [
      ["full-time", ["Senior Backend Engineer", "Senior Hybrid Engineer", "Senior Product Designer"]],
      ["contract", ["Frontend Engineer", "QA Engineer", "Site Reliability Engineer"]],
      ["part-time", ["Data Engineer"]],
      ["internship", ["Engineering Intern"]],
      ["  FULL-TIME ,CONTRACT  ", expected],
      ["Full Time", ["Senior Backend Engineer", "Senior Hybrid Engineer", "Senior Product Designer"]],
      ["full-time,full-time", ["Senior Backend Engineer", "Senior Hybrid Engineer", "Senior Product Designer"]],
      ["contractor", ["Site Reliability Engineer"].concat(["Frontend Engineer", "QA Engineer"])],
      ["full-time,contract,part-time,internship", ALL.filter((t) => t !== "Platform Engineer")],
    ];
    for (const [sel, want] of cases) {
      expect(titles(await viaNext(qs({ jobType: sel }))), sel).toEqual([...want].sort());
      expect(titles(await viaRecommended(qs({ jobType: sel }))), `rec ${sel}`).toEqual([...want].sort());
    }
    expect(titles(await viaNext(qs({ jobType: "all" })))).toEqual(ALL);
    expect(titles(await viaNext(qs({ jobType: "" })))).toEqual(ALL);
  });

  it("injected values cannot widen or break the clause", async () => {
    const clean = titles(await viaNext(qs({ jobType: "contract" })));
    expect(titles(await viaNext(qs({ jobType: "contract,),or(id.gt.0" })))).toEqual(clean);
    expect(titles(await viaNext(qs({ jobType: "contract,%" })))).toEqual(clean);
  });
});

describe("Work Model: OR within the dimension (server logic preserved)", () => {
  it("Remote + Hybrid includes Hybrid jobs with remote=false; remoteOnly is what excludes them", async () => {
    const want = titlesWhere(oracleWork("remote,hybrid"));
    expect(want).toEqual(expect.arrayContaining(["Frontend Engineer", "Platform Engineer", "Senior Hybrid Engineer"]));
    for (const via of [viaNext, viaNetlify, viaRecommended]) {
      expect(titles(await via(qs({ workModel: "remote, hybrid" })))).toEqual(want);
      // The old page sent remoteOnly=true with this selection: that is the restriction that hid Hybrid jobs.
      const strict = titles(await via(qs({ workModel: "remote, hybrid", remoteOnly: "true" })));
      expect(strict).not.toContain("Frontend Engineer");
    }
  });

  it("all work modes includes Onsite; NULL remote with no keyword stays excluded as before", async () => {
    const got = titles(await viaNext(qs({ workModel: "remote, hybrid, onsite" })));
    expect(got).toEqual(titlesWhere(oracleWork("remote,hybrid,onsite")));
    expect(got).toEqual(expect.arrayContaining(["Data Engineer", "Senior Product Designer"]));
    expect(got).not.toContain("QA Engineer");
    expect(titles(await viaNext(qs({ workModel: "onsite" })))).toEqual(titlesWhere(oracleWork("onsite")));
    expect(titles(await viaNext(qs({ workModel: "Remote" })))).toEqual(titlesWhere(oracleWork("remote")));
    expect(titles(await viaNext(qs({ workModel: "all" })))).toEqual(ALL);
  });
});

describe("AND across dimensions = intersection of each dimension alone", () => {
  const combos: Array<Record<string, string>> = [
    { category: "design" },
    { location: "Austin" },
    { level: "senior" },
    { level: "entry,senior" },
  ];
  for (const other of combos) {
    it(`Job Type + Work Model + ${JSON.stringify(other)}`, async () => {
      for (const via of [viaNext, viaNetlify, viaRecommended]) {
        const alone = new Set(titles(await via(qs(other))));
        const jt = new Set(titles(await via(qs({ jobType: "full-time, contract" }))));
        const wm = new Set(titles(await via(qs({ workModel: "remote, hybrid" }))));
        const both = titles(await via(qs({ ...other, jobType: "full-time, contract", workModel: "remote, hybrid" })));
        expect(both).toEqual(Array.from(alone).filter((t) => jt.has(t) && wm.has(t)).sort());
      }
    });
  }
});

describe("API counts and the page's card filter agree", () => {
  it("every returned card survives the page's secondary filter, and totalCount equals the filtered set", async () => {
    for (const [jobType, workModel] of [["full-time, contract", "remote, hybrid"], ["contract", ""], ["part-time", "onsite"], ["", "remote, hybrid, onsite"]]) {
      for (const via of [viaNext, viaRecommended]) {
        const body = await via(qs({ jobType, workModel }));
        const want = titlesWhere(...(jobType ? [oracleType(jobType)] : []), ...(workModel ? [oracleWork(workModel)] : []));
        expect(titles(body), `${jobType}|${workModel}`).toEqual(want);
        expect(body.totalCount, `${jobType}|${workModel}`).toBe(want.length);
        const visible = (body.jobs as any[]).filter((j) => matchesJobTypeFilter(j.type, jobType) && matchesWorkModelFilter(j, workModel));
        expect(visible.length, `${jobType}|${workModel} cards`).toBe(body.jobs.length);
      }
    }
  });
});

describe("getLiveJobs: real request serialization and direct queries", () => {
  it("search and recommended requests carry the multi-select unchanged and return both types", async () => {
    const opts = { jobType: "full-time, contract", workModel: "remote, hybrid", pageSize: 50, baseUrl: "http://localhost" };
    const want = titlesWhere(oracleType(opts.jobType), oracleWork(opts.workModel));
    const viaSearch = await getLiveJobs({ ...opts, sortBy: "newest" });
    const viaRec = await getLiveJobs({ ...opts, sortBy: "match" });
    const [searchUrl, recUrl] = fetched.map((u) => new URL(u));
    expect(searchUrl.pathname).toBe("/api/jobs/search");
    expect(recUrl.pathname).toBe("/api/jobs/recommended");
    for (const u of [searchUrl, recUrl]) {
      expect(u.searchParams.get("jobType")).toBe("full-time, contract");
      expect(u.searchParams.get("workModel")).toBe("remote, hybrid");
      expect(u.searchParams.has("remoteOnly")).toBe(false);
    }
    expect(viaSearch.jobs.map((j) => j.title).sort()).toEqual(want);
    expect(viaRec.jobs.map((j) => j.title).sort()).toEqual(want);
    expect(viaSearch.totalCount).toBe(want.length);
  });

  it("direct jobs_public query (no server) ORs Job Type and keeps the card types filterable", async () => {
    const res = await getLiveJobs({ jobType: "full-time, contract", workModel: "remote, hybrid", pageSize: 50 });
    expect(fetched).toEqual([]);
    const want = titlesWhere(oracleType("full-time, contract"), oracleWork("remote, hybrid"));
    expect(res.jobs.map((j) => j.title).sort()).toEqual(want);
    expect(res.jobs.every((j) => matchesJobTypeFilter(j.type, "full-time, contract"))).toBe(true);
  });

  it("category fallback ORs Job Type and applies Work Model like the main query", async () => {
    const res = await getLiveJobs({
      sortBy: "match",
      pageSize: 50,
      jobType: "full-time, contract",
      workModel: "remote, hybrid",
      candidate: { skills: ["zzyzxlang"], titles: ["Zzyzx Wrangler"] } as any,
      preferences: { roles: ["Zzyzx Wrangler"], categories: ["engineering"] } as any,
    });
    const want = titlesWhere((j) => (j.category ?? "engineering") === "engineering", oracleType("full-time, contract"), oracleWork("remote, hybrid"));
    expect(res.jobs.map((j) => j.title).sort()).toEqual(want);
  });
});
