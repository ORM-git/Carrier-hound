/**
 * Paid-gating regression matrix (checklist #47). Test-only: asserts the CURRENT contract, changes nothing.
 *
 * Contract (src/lib/jobs/service.ts getLiveJobs doc): for non-Pro viewers the gated fields are exactly
 * company, salary, apply_url, description, skills. Paid score inputs (PAID_SCORE_INPUT_COLUMNS in
 * src/lib/matcher/scoring.ts) never enter an unpaid scoreRevision; displayScore strips them for unpaid
 * viewers. Pro is the positive control on every surface.
 *
 * Method: every gated column carries a unique SENTINEL value (incl. the companies(name) join), and every
 * non-Pro response body is deep-scanned for those sentinels, so a leak under ANY field name fails.
 * Synthetic fixtures + in-memory Supabase fake only: no DB, no network, no production data.
 * The fake `jobs_public` table mirrors the real view (supabase/schema.generated.sql: gated columns are
 * masked constants there), `jobs` holds full rows.
 *
 * SURFACE INVENTORY (add every new route that returns job or score data here and to SURFACES below):
 *   Next routes (src/app/api/jobs/*)
 *     S1  GET  /api/jobs/search              list: guest, Free, Pro; also no-service-key fallback
 *     S2  GET  /api/jobs/search?id=          job detail: guest, Free, Pro
 *     S3  GET  /api/jobs/recommended         recommended/related feed: guest, Free, Pro (+ Pro hydration);
 *                                            also anon no-service-key branch (jobs_public)
 *     S4  GET  /api/jobs/pro?id=             Pro detail + same-company related jobs: guest 401, Free 403, Pro 200
 *     S5  POST /api/jobs/pro                 unlock flow (batch hydration): guest 401, Free 403, Pro 200
 *     S6  POST /api/jobs/top10               Top 10 matches: guest 401, Free 403, Pro 200
 *     S7  GET  /api/jobs/suggest             title suggestions: guest, Free
 *   Direct API routes that bypass the service layer (netlify/functions/*)
 *     S8  jobs-search handler                list + ?id detail: guest, Free, Pro
 *     S9  jobs-pro handler                   detail: guest 401, Free 403, Pro 200
 *     S10 jobs-top10 handler                 guest 401, Free 403
 *   Client service layer (src/lib/jobs/service.ts) fallback / cache-miss paths
 *     S11 getLiveJobs                        direct jobs_public fallback; client-claimed isPro with a Free
 *                                            session (unlock 403 must leave the masked rows untouched)
 *     S12 getLiveJobById                     isPro=false, and client-claimed isPro with a Free session
 *     S13 getAllActiveJobs                   cached full-corpus loader
 *     S14 getTopRankedJobsForCandidate       isPro=false short-circuit; client-claimed isPro, Free session
 *   Score inputs
 *     S15 scoreRevision / matchScore         unpaid values identical across paid-input variants; Pro differs
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  sessionToken: null as string | null,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let head = false;
    let write = false;
    const orders: Array<{ col: string; asc: boolean }> = [];
    const run = () => {
      if (write) return { data: [], error: null, count: 0 };
      let rows = (db.tables[table] || []).filter((r) => preds.every((p) => p(r)));
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[o.col] === b[o.col] ? 0 : (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1)));
      }
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      return { data: head ? null : rows.map((r) => structuredClone(r)), error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => ({ data: run().data?.[0] ?? null, error: null });
        if (p === "select") return (_c?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b; };
        if (p === "insert" || p === "update" || p === "upsert" || p === "delete") return () => { write = true; return b; };
        if (p === "eq") return (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b; };
        if (p === "neq") return (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return b; };
        if (p === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
        if (p === "or") return (e: string) => { preds.push((r) => matchesPostgrestOr(e, r)); return b; };
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
// Ban state is not under test here; entitlement is the REAL getServerEntitlement over the fake subscriptions table.
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));

// ---- Sentinels: unique values that must never appear in a non-Pro payload --------------------------------
const S = {
  company: "Zqxv Sentinel Holdings",
  salaryText: "SALARY-SENTINEL-TEXT",
  salaryMin: 987654,
  salaryMax: 987659,
  applyUrl: "https://apply-sentinel.example/apply/1",
  description: "DESC-SENTINEL Build distributed Node.js PostgreSQL services.",
  skill: "SkillSentinelQx",
};
const SENTINEL_STRINGS = [S.company, S.salaryText, "apply-sentinel.example", "DESC-SENTINEL", S.skill];
const SENTINEL_NUMBERS = [S.salaryMin, S.salaryMax];

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3600e3).toISOString();

const fullRow = (id: string, hoursAgo: number, paid: Partial<Record<string, unknown>> = {}) => ({
  id, title: "Backend Engineer", company: S.company, company_id: "co-sentinel", company_slug: "zqxv-sentinel",
  location: "Remote (Worldwide)", remote: true, is_remote: true, remote_scope: "worldwide", remote_eligibility: "worldwide",
  job_type: "full-time", category: "engineering", country: "United States", country_code: "US", seniority: "mid",
  verified: true, source_type: "greenhouse", status: "active", is_active: true, role_category: "backend",
  top_keywords: ["backend"], posted_at: iso(hoursAgo), created_at: iso(hoursAgo), first_seen_at: iso(hoursAgo),
  discovered_at: iso(hoursAgo), last_seen_at: iso(0), logo_url: null,
  salary_text: S.salaryText, salary_min: S.salaryMin, salary_max: S.salaryMax, currency: "USD", salary_period: "year",
  apply_url: S.applyUrl, description: S.description, skills: [S.skill, "Node.js"],
  companies: { name: S.company, logo_url: null, domain: null, canonical_domain: null, category: null },
  ...paid,
});

// Mirrors the jobs_public view: gated columns are constants, no salary_min/max/currency, no company join.
const VIEW_COLUMNS = ["id", "title", "location", "remote", "remote_scope", "remote_eligibility", "job_type", "category", "country",
  "country_code", "seniority", "verified", "source_type", "first_seen_at", "last_seen_at", "discovered_at", "posted_at", "created_at",
  "status", "is_active", "role_category", "top_keywords", "is_remote"];
const viewRow = (r: Record<string, any>) => ({
  ...Object.fromEntries(VIEW_COLUMNS.map((c) => [c, r[c]])),
  company: "Verified Employer", salary_text: null, description: null, apply_url: null, skills: [],
});

const sub = (user_id: string) => ({
  user_id, status: "active", plan_id: "monthly", current_period_end: new Date(NOW + 10 * 864e5).toISOString(),
  grace_period_end: null, created_at: iso(24),
});

function seed(paid: Partial<Record<string, unknown>> = {}) {
  const jobs = [fullRow(ID, 1, paid), fullRow(ID2, 2, paid)];
  db.tables = {
    jobs,
    jobs_public: jobs.map(viewRow),
    subscriptions: [sub("pro-1")],
    user_preferences: [{ user_id: "free-1", roles: ["Backend Engineer"], experience_level: "mid", remote_preference: "any", locations: [], employment_types: [], categories: ["engineering"] }],
    job_descriptions: [],
  };
}

// ---- Leak detection -------------------------------------------------------------------------------------
function findLeaks(body: unknown): string[] {
  const leaks: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const s of SENTINEL_STRINGS) if (v.toLowerCase().includes(s.toLowerCase())) leaks.push(`${path} = ${JSON.stringify(v)}`);
    } else if (typeof v === "number") {
      if (SENTINEL_NUMBERS.includes(v)) leaks.push(`${path} = ${v}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(body, "$");
  return leaks;
}
const expectNoLeak = (surface: string, body: unknown) => expect(findLeaks(body), `${surface} leaked gated data`).toEqual([]);
const expectProUnlocked = (surface: string, body: unknown) => {
  const text = JSON.stringify(body);
  expect(text, `${surface} Pro positive control: company`).toContain(S.company);
  expect(text, `${surface} Pro positive control: apply_url`).toContain(S.applyUrl);
  // Detector self-check: the same scanner that passes non-Pro bodies must flag this one.
  expect(findLeaks(body).length, `${surface} leak detector did not fire on a Pro body`).toBeGreaterThan(0);
};
/** Masked-list field contract for non-Pro job objects. */
const expectMaskedJob = (job: any) => {
  expect(job.company).toBe("Verified Employer");
  expect(job.salary || "").toBe("");
  expect(job.applyUrl || "").toBe("");
  expect(job.description || "").toBe("");
  expect(job.skills || []).toEqual([]);
};

// ---- Request helpers ------------------------------------------------------------------------------------
const TOKENS = { guest: undefined, free: "tok-free", pro: "tok-pro" } as const;
type Tier = keyof typeof TOKENS;
const req = (url: string, token?: string, init: RequestInit = {}) =>
  new Request(`http://localhost${url}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
const post = (url: string, token: string | undefined, body: unknown) =>
  req(url, token, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const netlifyEvent = (token: string | undefined, query: Record<string, string> = {}, method = "GET", body?: unknown) => ({
  httpMethod: method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
  queryStringParameters: query,
  body: body ? JSON.stringify(body) : null,
});
const candidate = {
  name: "Test Person", email: "t@example.com", phone: "", location: "", headline: "Backend Engineer", summary: "",
  skills: ["Node.js", "PostgreSQL"], experience: [], education: [], certifications: [],
  confirmedAt: iso(48), updatedAt: iso(48),
};

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-fake",
  SUPABASE_URL: "https://fake.supabase.co",
  COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
  NEXT_PUBLIC_BILLING_ENABLED: "true",
  __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
};

let client: any;
beforeAll(async () => {
  client = ((await import("@supabase/supabase-js")) as any).__client;
  // Warm the module graph once so the first test is not charged the cold transform time.
  await Promise.all([import("@/app/api/jobs/search/route"), import("@/app/api/jobs/recommended/route"), import("@/lib/jobs/service")]);
}, 60000);

beforeEach(() => {
  Object.assign(process.env, baseEnv, { SUPABASE_SERVICE_ROLE_KEY: "service-role-fake" });
  db.users = {
    "tok-free": { id: "free-1", email: "free@example.com", user_metadata: { is_pro: true } }, // client-editable claim must not unlock
    "tok-pro": { id: "pro-1", email: "pro@example.com", user_metadata: {} },
  };
  db.sessionToken = null;
  seed();
  (globalThis as any).__mockSupabaseClient = client;
});
afterEach(() => {
  delete (globalThis as any).__mockSupabaseClient;
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ---- S1-S7 Next routes ------------------------------------------------------------------------------------
describe("S1 GET /api/jobs/search (list)", () => {
  it.each(["guest", "free"] as Tier[])("%s: masked, no sentinel anywhere", async (tier) => {
    const { GET } = await import("@/app/api/jobs/search/route");
    const body = await (await GET(req("/api/jobs/search?limit=10", TOKENS[tier]))).json();
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.isPro).toBe(false);
    body.jobs.forEach(expectMaskedJob);
    expectNoLeak(`S1 ${tier}`, body);
  });

  it("no-service-key fallback (Pro token): still masked", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("@/app/api/jobs/search/route");
    const body = await (await GET(req("/api/jobs/search?limit=10", TOKENS.pro))).json();
    body.jobs.forEach(expectMaskedJob);
    expectNoLeak("S1 no-service-key", body);
  });

  it("Pro positive control: unlocked", async () => {
    const { GET } = await import("@/app/api/jobs/search/route");
    const body = await (await GET(req("/api/jobs/search?limit=10", TOKENS.pro))).json();
    expect(body.isPro).toBe(true);
    expectProUnlocked("S1 pro", body);
  });
});

describe("S2 GET /api/jobs/search?id= (detail)", () => {
  it.each(["guest", "free"] as Tier[])("%s: masked, no sentinel anywhere", async (tier) => {
    const { GET } = await import("@/app/api/jobs/search/route");
    const body = await (await GET(req(`/api/jobs/search?id=${ID}`, TOKENS[tier]))).json();
    expect(body.jobs.map((j: any) => j.id)).toEqual([ID]);
    body.jobs.forEach(expectMaskedJob);
    expectNoLeak(`S2 ${tier}`, body);
  });

  it("Pro positive control: unlocked", async () => {
    const { GET } = await import("@/app/api/jobs/search/route");
    expectProUnlocked("S2 pro", await (await GET(req(`/api/jobs/search?id=${ID}`, TOKENS.pro))).json());
  });
});

describe("S3 GET /api/jobs/recommended", () => {
  it.each(["guest", "free"] as Tier[])("%s: masked, no sentinel anywhere", async (tier) => {
    const { GET } = await import("@/app/api/jobs/recommended/route");
    const body = await (await GET(req("/api/jobs/recommended?pageSize=10", TOKENS[tier]))).json();
    expect(body.jobs.length).toBeGreaterThan(0);
    body.jobs.forEach(expectMaskedJob);
    expectNoLeak(`S3 ${tier}`, body);
  });

  it("anon no-service-key branch (jobs_public): masked", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("@/app/api/jobs/recommended/route");
    const body = await (await GET(req("/api/jobs/recommended?pageSize=10"))).json();
    expect(body.jobs.length).toBeGreaterThan(0);
    expectNoLeak("S3 anon", body);
  });

  it("Pro positive control: unlocked via hydration", async () => {
    const { GET } = await import("@/app/api/jobs/recommended/route");
    const body = await (await GET(req("/api/jobs/recommended?pageSize=10", TOKENS.pro))).json();
    expect(body.isPro).toBe(true);
    expectProUnlocked("S3 pro", body);
  });
});

describe("S4 GET /api/jobs/pro?id= (Pro detail + same-company related)", () => {
  it.each([["guest", 401], ["free", 403]] as Array<[Tier, number]>)("%s: %i and no sentinel in the error body", async (tier, status) => {
    const { GET } = await import("@/app/api/jobs/pro/route");
    const res = await GET(req(`/api/jobs/pro?id=${ID}`, TOKENS[tier]));
    expect(res.status).toBe(status);
    expectNoLeak(`S4 ${tier}`, await res.json());
  });

  it("Pro positive control: 200 unlocked", async () => {
    const { GET } = await import("@/app/api/jobs/pro/route");
    const res = await GET(req(`/api/jobs/pro?id=${ID}`, TOKENS.pro));
    expect(res.status).toBe(200);
    expectProUnlocked("S4 pro", await res.json());
  });
});

describe("S5 POST /api/jobs/pro (unlock flow)", () => {
  it.each([["guest", 401], ["free", 403]] as Array<[Tier, number]>)("%s: %i and no sentinel in the error body", async (tier, status) => {
    const { POST } = await import("@/app/api/jobs/pro/route");
    const res = await POST(post("/api/jobs/pro", TOKENS[tier], { ids: [ID, ID2] }));
    expect(res.status).toBe(status);
    expectNoLeak(`S5 ${tier}`, await res.json());
  });

  it("Pro positive control: 200 unlocked", async () => {
    const { POST } = await import("@/app/api/jobs/pro/route");
    const res = await POST(post("/api/jobs/pro", TOKENS.pro, { ids: [ID, ID2] }));
    expect(res.status).toBe(200);
    expectProUnlocked("S5 pro", await res.json());
  });
});

describe("S6 POST /api/jobs/top10", () => {
  it.each([["guest", 401], ["free", 403]] as Array<[Tier, number]>)("%s: %i and no sentinel in the error body", async (tier, status) => {
    const { POST } = await import("@/app/api/jobs/top10/route");
    const res = await POST(post("/api/jobs/top10", TOKENS[tier], { candidate, limit: 10 }));
    expect(res.status).toBe(status);
    expectNoLeak(`S6 ${tier}`, await res.json());
  });

  it("Pro positive control: 200 unlocked", async () => {
    const { POST } = await import("@/app/api/jobs/top10/route");
    const res = await POST(post("/api/jobs/top10", TOKENS.pro, { candidate, limit: 10 }));
    expect(res.status).toBe(200);
    expectProUnlocked("S6 pro", await res.json());
  });
});

describe("S7 GET /api/jobs/suggest", () => {
  it.each(["guest", "free"] as Tier[])("%s: no sentinel anywhere", async (tier) => {
    const { GET } = await import("@/app/api/jobs/suggest/route");
    const res = await GET(req("/api/jobs/suggest?q=back", TOKENS[tier]));
    expectNoLeak(`S7 ${tier}`, await res.json());
  });
});

// ---- S8-S10 direct netlify functions (bypass the service layer) --------------------------------------------
describe("S8 netlify jobs-search", () => {
  beforeEach(async () => {
    (await import("../../../netlify/functions/jobs-search"))._resetSearchRateLimitStore();
  });

  it.each(["guest", "free"] as Tier[])("%s: list and detail masked, no sentinel anywhere", async (tier) => {
    const { handler } = await import("../../../netlify/functions/jobs-search");
    for (const query of [{ limit: "10" }, { id: ID }] as Array<Record<string, string>>) {
      const res = await handler(netlifyEvent(TOKENS[tier], query));
      const body = JSON.parse(res.body);
      expect(body.jobs.length, JSON.stringify(query)).toBeGreaterThan(0);
      body.jobs.forEach(expectMaskedJob);
      expectNoLeak(`S8 ${tier} ${JSON.stringify(query)}`, body);
    }
  });

  it("Pro positive control: list unlocked", async () => {
    const { handler } = await import("../../../netlify/functions/jobs-search");
    expectProUnlocked("S8 pro", JSON.parse((await handler(netlifyEvent(TOKENS.pro, { limit: "10" }))).body));
  });
});

describe("S9 netlify jobs-pro", () => {
  it.each([["guest", 401], ["free", 403]] as Array<[Tier, number]>)("%s: %i and no sentinel in the error body", async (tier, status) => {
    const { handler } = await import("../../../netlify/functions/jobs-pro");
    const res = await handler(netlifyEvent(TOKENS[tier], { id: ID }));
    expect(res.statusCode).toBe(status);
    expectNoLeak(`S9 ${tier}`, JSON.parse(res.body));
  });

  it("Pro positive control: 200 unlocked", async () => {
    const { handler } = await import("../../../netlify/functions/jobs-pro");
    const res = await handler(netlifyEvent(TOKENS.pro, { id: ID }));
    expect(res.statusCode).toBe(200);
    expectProUnlocked("S9 pro", JSON.parse(res.body));
  });
});

describe("S10 netlify jobs-top10", () => {
  it.each([["guest", 401], ["free", 403]] as Array<[Tier, number]>)("%s: %i and no sentinel in the error body", async (tier, status) => {
    const { handler } = await import("../../../netlify/functions/jobs-top10");
    const res = await handler(netlifyEvent(TOKENS[tier], {}, "POST", { candidate, limit: 10 }));
    expect(res.statusCode).toBe(status);
    expectNoLeak(`S10 ${tier}`, JSON.parse(res.body));
  });
});

// ---- S11-S14 client service fallback / cache-miss paths --------------------------------------------------
/** Routes the service's relative fetches to the REAL route handlers, so server gating decides. */
async function stubFetchToRoutes() {
  const search = await import("@/app/api/jobs/search/route");
  const recommended = await import("@/app/api/jobs/recommended/route");
  const pro = await import("@/app/api/jobs/pro/route");
  const top10 = await import("@/app/api/jobs/top10/route");
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const r = new Request(url, init);
    const method = (init.method || "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/jobs/search") return search.GET(r);
    if (url.pathname === "/api/jobs/recommended") return recommended.GET(r);
    if (url.pathname === "/api/jobs/pro") return method === "POST" ? pro.POST(r) : pro.GET(r);
    if (url.pathname === "/api/jobs/top10") return top10.POST(r);
    throw new Error(`unexpected fetch ${url.pathname}`);
  });
  return calls;
}

describe("S11 service.getLiveJobs", () => {
  it("guest direct jobs_public fallback: masked, no sentinel", async () => {
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs({ pageSize: 10 });
    expect(res.jobs.length).toBeGreaterThan(0);
    res.jobs.forEach(expectMaskedJob);
    expectNoLeak("S11 guest", res);
  });

  it("client-claimed isPro with a Free session: unlock is refused server-side and rows stay masked", async () => {
    db.sessionToken = TOKENS.free;
    const calls = await stubFetchToRoutes();
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs({ pageSize: 10, isPro: true });
    expect(calls).toContain("POST /api/jobs/pro");
    expect(res.jobs.length).toBeGreaterThan(0);
    res.jobs.forEach(expectMaskedJob);
    expectNoLeak("S11 claimed-pro free", res);
  });

  it("Pro positive control: client isPro + Pro session unlocks via /api/jobs/pro", async () => {
    db.sessionToken = TOKENS.pro;
    await stubFetchToRoutes();
    const { getLiveJobs } = await import("@/lib/jobs/service");
    expectProUnlocked("S11 pro", await getLiveJobs({ pageSize: 10, isPro: true }));
  });
});

describe("S12 service.getLiveJobById", () => {
  it.each([["guest", false], ["free", false], ["free", true]] as Array<[Tier, boolean]>)(
    "%s session, isPro=%s: masked, no sentinel",
    async (tier, claimedPro) => {
      db.sessionToken = TOKENS[tier] ?? null;
      await stubFetchToRoutes();
      const { getLiveJobById } = await import("@/lib/jobs/service");
      const job = await getLiveJobById(ID, claimedPro);
      expect(job?.id).toBe(ID);
      expectMaskedJob(job);
      expectNoLeak(`S12 ${tier} claimed=${claimedPro}`, job);
    },
  );

  it("Pro positive control", async () => {
    db.sessionToken = TOKENS.pro;
    await stubFetchToRoutes();
    const { getLiveJobById } = await import("@/lib/jobs/service");
    expectProUnlocked("S12 pro", await getLiveJobById(ID, true));
  });
});

describe("S13 service.getAllActiveJobs (cached loader)", () => {
  it("masked on first load and on the cached second read", async () => {
    const { getAllActiveJobs } = await import("@/lib/jobs/service");
    for (const pass of ["miss", "hit"]) {
      const jobs = await getAllActiveJobs();
      expect(jobs.length, pass).toBeGreaterThan(0);
      jobs.forEach(expectMaskedJob);
      expectNoLeak(`S13 ${pass}`, jobs);
    }
  });
});

describe("S14 service.getTopRankedJobsForCandidate", () => {
  it("isPro=false short-circuits to []", async () => {
    const { getTopRankedJobsForCandidate } = await import("@/lib/jobs/service");
    expect(await getTopRankedJobsForCandidate(candidate as any, 10, false)).toEqual([]);
  });

  it("client-claimed isPro with a Free session: top10 403 -> []", async () => {
    db.sessionToken = TOKENS.free;
    await stubFetchToRoutes();
    const { getTopRankedJobsForCandidate } = await import("@/lib/jobs/service");
    expect(await getTopRankedJobsForCandidate(candidate as any, 10, true)).toEqual([]);
  });
});

// ---- S15 score inputs --------------------------------------------------------------------------------------
describe("S15 paid score inputs never enter an unpaid scoreRevision / matchScore", () => {
  const variantB = {
    description: "DESC-SENTINEL Completely different Kubernetes Terraform Go role.",
    skills: [S.skill, "Go", "Kubernetes"],
    salary_text: `${S.salaryText} B`, salary_min: S.salaryMin, salary_max: S.salaryMax + 1, currency: "EUR", salary_period: "month",
  };
  const scores = (body: any) => body.jobs.map((j: any) => ({ id: j.id, scoreRevision: j.scoreRevision, matchScore: j.matchScore }));

  async function both(path: string, token: string | undefined, route: "search" | "recommended") {
    const mod = route === "search" ? await import("@/app/api/jobs/search/route") : await import("@/app/api/jobs/recommended/route");
    seed();
    const a = scores(await (await mod.GET(req(path, token))).json());
    seed(variantB);
    const b = scores(await (await mod.GET(req(path, token))).json());
    return { a, b };
  }

  it.each([
    ["search list", "/api/jobs/search?limit=10", "search"],
    ["search detail", `/api/jobs/search?id=${ID}`, "search"],
    ["recommended", "/api/jobs/recommended?pageSize=10", "recommended"],
  ] as const)("%s: guest and Free values identical across paid-input variants", async (_l, path, route) => {
    for (const tier of ["guest", "free"] as Tier[]) {
      const { a, b } = await both(path, TOKENS[tier], route);
      expect(a.length).toBeGreaterThan(0);
      expect(a.every((x: any) => typeof x.scoreRevision === "string" && x.scoreRevision.length > 0)).toBe(true);
      expect(b, `${route} ${tier}`).toEqual(a);
    }
  });

  it("Pro positive control: scoreRevision changes when paid inputs change", async () => {
    const { a, b } = await both("/api/jobs/search?limit=10", TOKENS.pro, "search");
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((x: any) => x.scoreRevision)).not.toEqual(a.map((x: any) => x.scoreRevision));
  });

  it("scoreInputRevision unit contract: includePaidInputs=false ignores every PAID_SCORE_INPUT_COLUMNS value", async () => {
    const { scoreInputRevision } = await import("@/lib/matcher/scoring");
    // Mirrors the module-private PAID_SCORE_INPUT_COLUMNS in src/lib/matcher/scoring.ts (not exported; test-only PR).
    const PAID_SCORE_INPUT_COLUMNS = ["description", "skills", "salary_text", "salary_min", "salary_max", "currency", "salary_period"];
    const base = fullRow(ID, 1);
    const at = NOW;
    for (const col of PAID_SCORE_INPUT_COLUMNS) {
      const changed = { ...base, [col]: col === "skills" ? ["Other"] : col.startsWith("salary_m") ? 1 : `changed-${col}` };
      expect(scoreInputRevision(changed, false, at), col).toBe(scoreInputRevision(base, false, at));
      expect(scoreInputRevision(changed, true, at), `${col} (Pro control)`).not.toBe(scoreInputRevision(base, true, at));
    }
  });
});
