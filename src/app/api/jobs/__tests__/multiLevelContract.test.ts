// Multi-level (OR) Level filter through the REAL handlers: Next /api/jobs/search (guest, Free, Pro)
// and the routed Netlify jobs-search function. Only Supabase is faked; its `.or()` evaluates
// PostgREST logic trees with SQL NULL semantics, so the nested level clauses are exercised for real.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";
import { matchesExperienceLevelFilter } from "@/lib/jobs/experienceLevels";

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
          if (prop === "ilike")
            return (c: string, p: string) => (preds.push((r) => orMatch(`${c}.ilike.${p}`, r)), b);
          if (prop === "or") return (expr: string) => (preds.push((r) => orMatch(expr, r)), b);
          if (prop === "not")
            return (c: string, op: string, v: any) => (preds.push((r) => orMatch(`${c}.not.${op}.${v}`, r)), b);
          if (prop === "is") return (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b);
          if (prop === "order")
            return (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), b);
          if (prop === "range") return (f: number, t: number) => ((range = [f, t]), b);
          if (prop === "limit") return (n: number) => ((limit = n), b);
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: run().data[0] ?? null, error: null });
          return () => b; // select, textSearch, etc.: not used by these requests
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
    },
    from,
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };
  return { createClient: () => client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

const day = (n: number) => new Date(Date.UTC(2026, 10, 18 - n)).toISOString();
const job = (i: number, title: string, job_type: string | null = "full-time") => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title,
  company: `Company ${i}`,
  companies: { name: `Company ${i}`, logo_url: null },
  company_id: `co_${i}`,
  location: "Remote",
  category: "engineering",
  remote: true,
  remote_scope: "worldwide",
  country_code: "US",
  job_type,
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
});
const JOBS = [
  job(1, "Senior Backend Engineer"),
  job(2, "Junior Data Analyst"),
  job(3, "Staff Software Engineer"),
  job(4, "Software Engineer"),
  job(5, "Engineering Intern", "internship"),
  job(6, "Sr. Frontend Engineer"),
  job(7, "Associate Product Manager"),
  job(8, "Senior Staff Engineer"), // lead wins: excluded from entry+senior
  job(9, "Entry Level Support Engineer"),
];
const titlesFor = (level: string) =>
  JOBS.filter((j) => matchesExperienceLevelFilter({ title: j.title, job_type: j.job_type }, level)).map((j) => j.title);

let nextSearch: (r: Request) => Promise<Response>;
let netlifySearch: (e: any) => Promise<any>;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "group-secret-for-tests-0123456789",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  nextSearch = (await import("@/app/api/jobs/search/route")).GET;
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
});

async function viaNext(qs: string, token?: string) {
  const res = await nextSearch(
    new Request(`http://localhost/api/jobs/search?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  );
  expect(res.status).toBe(200);
  return res.json();
}
async function viaNetlify(qs: string, token?: string) {
  const res = await netlifySearch({
    httpMethod: "GET",
    path: "/api/jobs/search",
    queryStringParameters: Object.fromEntries(new URLSearchParams(qs)),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}
const titles = (body: any) => (body.jobs as any[]).map((j) => j.title).sort();

describe("Level facet OR through the real search handlers", () => {
  it("entry+senior returns exactly the entry and senior jobs (guest), matching the shared client predicate", async () => {
    const body = await viaNext("level=entry,senior&pageSize=50");
    expect(titles(body)).toEqual(titlesFor("entry,senior").sort());
    expect(titles(body)).toEqual(
      ["Associate Product Manager", "Entry Level Support Engineer", "Junior Data Analyst", "Senior Backend Engineer", "Sr. Frontend Engineer"].sort()
    );
  });

  it("guest and Free stay masked; Pro sees companies; all three get the same filtered set", async () => {
    const guest = await viaNext("level=entry,senior&pageSize=50");
    const free = await viaNext("level=entry,senior&pageSize=50", "tok-free");
    const pro = await viaNext("level=entry,senior&pageSize=50", "tok-pro");
    expect(titles(free)).toEqual(titles(guest));
    expect(titles(pro)).toEqual(titles(guest));
    const leaks = (b: any) => (b.jobs as any[]).some((j) => String(j.company || "").startsWith("Company "));
    expect(leaks(guest)).toBe(false);
    expect(leaks(free)).toBe(false);
    expect(leaks(pro)).toBe(true);
  });

  it("intern/lead aliases, legacy single-level URLs and all/empty behave as before", async () => {
    expect(titles(await viaNext("level=internship,staff&pageSize=50"))).toEqual(titlesFor("intern,lead").sort());
    expect(titles(await viaNext("level=senior&pageSize=50"))).toEqual(["Senior Backend Engineer", "Sr. Frontend Engineer"]);
    expect(titles(await viaNext("level=mid&pageSize=50"))).toEqual(["Software Engineer"]);
    const all = titles(await viaNext("pageSize=50"));
    expect(all).toHaveLength(JOBS.length);
    expect(titles(await viaNext("level=all&pageSize=50"))).toEqual(all);
    expect(titles(await viaNext("level=intern,entry,mid,senior,lead&pageSize=50"))).toEqual(all);
  });

  it("duplicate, invalid and injected values cannot widen or alter the result", async () => {
    const clean = titles(await viaNext("level=senior&pageSize=50"));
    const q = new URLSearchParams({ level: "senior,senior,director,or(id.gt.0),title.ilike.*", pageSize: "50" });
    expect(titles(await viaNext(q.toString()))).toEqual(clean);
  });

  it("count and pagination agree with the filtered set (no gaps or duplicates across pages)", async () => {
    const expected = titlesFor("entry,senior").sort();
    const seen: string[] = [];
    let qs = "level=entry,senior&pageSize=2";
    for (let guard = 0; guard < 10; guard++) {
      const body = await viaNext(qs);
      seen.push(...(body.jobs as any[]).map((j) => j.title));
      if (typeof body.totalCount === "number") expect(body.totalCount).toBeLessThanOrEqual(expected.length);
      if (!body.hasMore && !body.hasNextPage) break;
      qs = body.nextCursor
        ? `level=entry,senior&pageSize=2&cursor=${encodeURIComponent(body.nextCursor)}`
        : `level=entry,senior&pageSize=2&page=${guard + 2}`;
    }
    expect([...seen].sort()).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("Netlify routed search returns the same filtered set as Next for guest and Pro", async () => {
    for (const level of ["entry,senior", "senior", "intern,lead", "mid"]) {
      expect(titles(await viaNetlify(`level=${level}&pageSize=50`)), level).toEqual(titles(await viaNext(`level=${level}&pageSize=50`)));
    }
    expect(titles(await viaNetlify("level=entry,senior&pageSize=50", "tok-pro"))).toEqual(
      titles(await viaNext("level=entry,senior&pageSize=50", "tok-pro"))
    );
  });

  it("evaluator sanity: the fake honors nested clauses the way Postgres would", () => {
    expect(matchesPostgrestOr("and(title.ilike.%a%,or(job_type.is.null,job_type.neq.internship))", { title: "a", job_type: null })).toBe(true);
    expect(matchesPostgrestOr("job_type.neq.internship", { job_type: null })).toBe(false); // SQL NULL
  });
});
