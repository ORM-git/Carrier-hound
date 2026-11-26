// /api/jobs/ranked-feed prototype through the REAL handler. Harness copied from feedConstraintRoutes.test.ts.
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


const req = (url: string, token?: string) => new Request(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

// --- /api/jobs/ranked-feed prototype (harness above copied from feedConstraintRoutes.test.ts) -----------
beforeEach(() => {
  process.env.RANKED_FEED_PROTOTYPE = "true";
  db.users = {
    "tok-pro": { id: "pro-1", user_metadata: {}, last_sign_in_at: "2026-11-26T08:00:00Z" } as any,
    "tok-free": { id: "free-1", user_metadata: {}, last_sign_in_at: "2026-11-26T08:00:00Z" } as any,
  };
  db.tables.user_preferences = [];
});
afterEach(() => {
  delete process.env.RANKED_FEED_PROTOTYPE;
});

async function feed(qs: string, token = "tok-free") {
  const { GET } = await import("@/app/api/jobs/ranked-feed/route");
  const res = await GET(req(`/api/jobs/ranked-feed?${qs}`, token));
  return { status: res.status, body: await res.json() };
}
const ids = (body: any) => (body.jobs || []).map((j: any) => j.id);

describe("/api/jobs/ranked-feed prototype", () => {
  it("is off unless RANKED_FEED_PROTOTYPE=true", async () => {
    delete process.env.RANKED_FEED_PROTOTYPE;
    expect((await feed("pageSize=5")).status).toBe(404);
  });

  it("rejects filters it does not evaluate instead of ignoring them", async () => {
    const { status, body } = await feed("pageSize=5&category=ai");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "unsupported_on_prototype", param: "category" });
  });

  it("walks the whole eligible corpus with no duplicates; a delete between pages is omitted, not resurrected", async () => {
    const p1 = (await feed("pageSize=4")).body;
    expect(p1.snapshot).toMatchObject({ built: true, stale: false, rankedRows: 11, eligibleRows: 11 });
    expect(p1.jobs).toHaveLength(4);
    const removed = rows.find((r) => !ids(p1).includes(r.id))!;
    removed.is_active = false; // withdrawn after the build
    const seen = [...ids(p1)];
    let cursor = p1.nextCursor;
    while (cursor) {
      const p = (await feed(`pageSize=4&cursor=${cursor}`)).body;
      expect(p.snapshot.built).toBe(false);
      seen.push(...ids(p));
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(removed.id);
    expect(seen).toHaveLength(10);
  });

  it("Free snapshot pages never contain Pro fields; Pro pages are hydrated at serve time", async () => {
    const free = (await feed("pageSize=20", "tok-free")).body;
    expect(free.jobs.length).toBeGreaterThan(0);
    for (const j of free.jobs) {
      expect(j.company).toBe("Verified Employer");
      expect(j.applyUrl).toBe("");
      expect(j.description).toBe("");
      expect(j.skills).toEqual([]);
      expect(j.salary).toBe("");
      expect(j).not.toHaveProperty("companyId");
      expect(j).not.toHaveProperty("company_id");
    }
    const pro = (await feed("pageSize=20", "tok-pro")).body;
    expect(pro.jobs.some((j: any) => j.applyUrl.startsWith("https://"))).toBe(true);
    expect(pro.jobs.some((j: any) => j.company !== "Verified Employer")).toBe(true);
  });

  it("a cursor from another tier, filter set or session resets (409 cursor_reset)", async () => {
    const p1 = (await feed("pageSize=2", "tok-free")).body;
    expect((await feed(`pageSize=2&cursor=${p1.nextCursor}`, "tok-pro")).body.error).toBe("cursor_reset");
    expect((await feed(`pageSize=2&jobType=contract&cursor=${p1.nextCursor}`, "tok-free")).status).toBe(409);
    (db.users["tok-free"] as any).last_sign_in_at = "2026-11-26T09:30:00Z"; // signed in again
    expect((await feed(`pageSize=2&cursor=${p1.nextCursor}`, "tok-free")).status).toBe(409);
  });

  it("a new ingest cycle marks an issued snapshot stale but keeps its pages consistent; a fresh request rebuilds", async () => {
    const p1 = (await feed("pageSize=3", "tok-free")).body;
    const fresh = { ...rows[0], id: "00000000-0000-4000-8000-000000000999", title: "Brand New Engineer", first_seen_at: new Date().toISOString() };
    rows.push(fresh);
    const p2 = (await feed(`pageSize=3&cursor=${p1.nextCursor}`, "tok-free")).body;
    expect(p2.snapshot.stale).toBe(true);
    expect(ids(p2)).not.toContain(fresh.id);
    expect(ids(p2).some((id: string) => ids(p1).includes(id))).toBe(false);
    const rebuilt = (await feed("pageSize=50", "tok-free")).body;
    expect(rebuilt.snapshot).toMatchObject({ built: true, stale: false, rankedRows: 12 });
    expect(ids(rebuilt)).toContain(fresh.id);
  });

  it("serve-time filters still apply: a job updated out of the filter after the build is omitted", async () => {
    const p1 = (await feed("pageSize=2&excludeTitle=sales", "tok-free")).body;
    const target = rows.find((r) => r.title === "Platform Engineer")!;
    target.title = "Sales Platform Engineer";
    const seen = [...ids(p1)];
    let cursor = p1.nextCursor;
    while (cursor) {
      const p = (await feed(`pageSize=2&excludeTitle=sales&cursor=${cursor}`, "tok-free")).body;
      seen.push(...ids(p));
      cursor = p.nextCursor;
    }
    if (!ids(p1).includes(target.id)) expect(seen).not.toContain(target.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
