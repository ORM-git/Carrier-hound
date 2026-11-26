import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";
import { FROZEN_REUSE_SECONDS } from "@/lib/jobs/feedSnapshot";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
  // Log of executed queries on jobs tables: selected columns, count option, rows and UTF-8 response bytes.
  queries: [] as Array<{ table: string; cols: string; count?: string; rows: number; bytes: number; ids: string[] }>,
  failWhen: null as null | ((table: string, cols: string) => boolean),
  rpcFail: null as null | { message: string; code?: string },
  rpcGate: null as null | Promise<void>, // holds freeze_feed_corpus open (concurrency tests)
  afterFrozenRead: null as null | (() => void), // runs after each read of the frozen relation (mid-build mutation hook)
}));

/** Like PostgREST, return only the selected columns ("a, b, rel(x, y)"); "*" or aliases fall back to whole rows. */
function projectRows(rows: any[], cols: string): any[] {
  if (!cols || /[*:!]/.test(cols)) return rows;
  const names: string[] = [];
  let depth = 0, cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { names.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) names.push(cur.trim());
  const keys = names.map((n) => n.replace(/\([\s\S]*$/, "").trim());
  return rows.map((r) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]])));
}

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const predicates: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; ascending: boolean; nullsFirst?: boolean }> = [];
    let rangeBounds: [number, number] | null = null;
    let limitCount: number | null = null;
    let selectedCols = "*";
    let selectedCount: string | undefined;

    const run = () => {
      if (state.failWhen?.(table, selectedCols)) return { data: null, count: null, error: { message: "injected failure" } };
      const result = runQuery();
      if (table === "feed_corpus_frozen") state.afterFrozenRead?.();
      if (table.startsWith("jobs") || table === "feed_corpus_frozen") {
        result.data = projectRows(result.data, selectedCols);
        state.queries.push({ table, cols: selectedCols, count: selectedCount, rows: result.data.length, bytes: new TextEncoder().encode(JSON.stringify(result.data)).length, ids: result.data.map((r: any) => r.id) });
      }
      return result;
    };

    const runQuery = () => {
      let data = [...(state.tables[table] || [])].filter((r) =>
        predicates.every((p) => p(r))
      );

      // Real order execution
      if (orders.length > 0) {
        data.sort((a, b) => {
          for (const ord of orders) {
            const valA = a[ord.col];
            const valB = b[ord.col];
            if (valA === valB) continue;
            if (valA == null) return ord.nullsFirst ? -1 : 1;
            if (valB == null) return ord.nullsFirst ? 1 : -1;
            const cmp = valA > valB ? 1 : -1;
            return ord.ascending ? cmp : -cmp;
          }
          return 0;
        });
      }

      const totalCount = data.length;

      // Real range and limit execution
      if (rangeBounds) {
        data = data.slice(rangeBounds[0], rangeBounds[1] + 1);
      } else if (limitCount !== null) {
        data = data.slice(0, limitCount);
      }

      return { data, count: totalCount, error: null };
    };

    const b: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
          }
          if (prop === "eq") {
            return (c: string, v: unknown) => {
              predicates.push((r) => r[c] === v);
              return b;
            };
          }
          if (prop === "ilike") {
            return (c: string, pattern: string) => {
              const term = pattern.replace(/^%|%$/g, "").toLowerCase();
              predicates.push((r) => String(r[c] || "").toLowerCase().includes(term));
              return b;
            };
          }
          if (prop === "gte") {
            return (c: string, val: any) => {
              predicates.push((r) => {
                const v = r[c];
                if (v == null) return false;
                if (typeof val === "number") return Number(v) >= val;
                return v >= val;
              });
              return b;
            };
          }
          if (prop === "not") {
            return (c: string, op: string, val: any) => {
              if (op === "is" && val === null) {
                predicates.push((r) => r[c] != null);
              } else if (op === "ilike") {
                const term = String(val).replace(/^%|%$/g, "").toLowerCase();
                predicates.push((r) => !String(r[c] || "").toLowerCase().includes(term));
              } else {
                predicates.push((r) => r[c] !== val);
              }
              return b;
            };
          }
          if (prop === "is") {
            return (c: string, v: unknown) => {
              predicates.push((r) => (v === null ? r[c] == null : r[c] === v));
              return b;
            };
          }
          if (prop === "lt") {
            return (c: string, v: any) => {
              predicates.push((r) => r[c] != null && r[c] < v);
              return b;
            };
          }
          if (prop === "in") {
            return (c: string, values: any[]) => {
              predicates.push((r) => Array.isArray(values) && values.includes(r[c]));
              return b;
            };
          }
          if (prop === "or") {
            // Evaluate PostgREST logic trees (nested and()/or()) like Postgres, not a naive comma split.
            return (expr: string) => {
              predicates.push((r) => matchesPostgrestOr(expr, r));
              return b;
            };
          }
          if (prop === "order") {
            return (col: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
              orders.push({
                col,
                ascending: options?.ascending !== false,
                nullsFirst: options?.nullsFirst,
              });
              return b;
            };
          }
          if (prop === "range") {
            return (fromIndex: number, toIndex: number) => {
              rangeBounds = [fromIndex, toIndex];
              return b;
            };
          }
          if (prop === "limit") {
            return (n: number) => {
              limitCount = n;
              return b;
            };
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({ data: run().data?.[0] ?? null, error: null });
          }
          if (prop === "select") {
            return (cols?: string, opts?: { count?: string }) => {
              selectedCols = cols ?? "*";
              selectedCount = opts?.count;
              return b;
            };
          }
          return () => b;
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
    // Emulates public.freeze_feed_corpus (docs/proposed SQL; the SQL itself is validated separately on a real Postgres):
    // reuse a fresh epoch, else copy the visible active rows in one step, hard-cap at max+1 and fail without a partial copy.
    rpc: async (name: string, args: any) => {
      if (name !== "freeze_feed_corpus") return { data: null, error: { message: "unknown function", code: "PGRST202" } };
      if (state.rpcGate) await state.rpcGate;
      if (state.rpcFail) return { data: null, error: state.rpcFail };
      const epochs = (state.tables.feed_corpus_epochs ||= []);
      const fresh = epochs.filter((e: any) => Date.now() - e.frozen_ms < args.p_reuse_seconds * 1000).sort((a: any, b: any) => b.frozen_ms - a.frozen_ms)[0];
      if (fresh) {
        if (fresh.row_count > args.p_max_rows) return { data: null, error: { message: "snapshot_too_large", code: "54000" } };
        return { data: [{ out_epoch: fresh.epoch, out_frozen_at: new Date(fresh.frozen_ms).toISOString(), out_row_count: fresh.row_count, out_corpus_mark: fresh.mark }], error: null };
      }
      const visible = (state.tables.jobs || []).filter((j: any) => j.status === "active" && j.is_active === true && j.source_type !== "jobspy").slice(0, args.p_max_rows + 1);
      if (visible.length > args.p_max_rows) return { data: null, error: { message: "snapshot_too_large", code: "54000" } };
      const epoch = crypto.randomUUID();
      const frozen = (state.tables.feed_corpus_frozen ||= []);
      for (const j of visible) frozen.push({ ...j, epoch });
      const mark = visible.map((j: any) => j.first_seen_at).sort().pop() ?? null; // newest first_seen_at INSIDE the epoch
      epochs.push({ epoch, frozen_ms: Date.now(), row_count: visible.length, mark });
      return { data: [{ out_epoch: epoch, out_frozen_at: new Date().toISOString(), out_row_count: visible.length, out_corpus_mark: mark }], error: null };
    },
  };
  return { createClient: () => client };
});

vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

// 320 test jobs corpus for realistic pagination and ranking assertions
function generateTestCorpus(count: number = 320) {
  const jobs: any[] = [];
  const baseTime = Date.now() - 30 * 864e5;

  // Key fixtures at the start
  jobs.push({
    id: "11111111-1111-4111-8111-111111111111",
    title: "Senior Frontend Developer",
    company: "Frontend Masters Inc",
    company_id: "co_frontend",
    location: "Remote (Worldwide)",
    category: "engineering",
    remote: true,
    is_remote: true,
    remote_scope: "worldwide",
    country_code: "US",
    job_type: "full-time",
    verified: true,
    posted_at: new Date(baseTime + 28 * 864e5).toISOString(),
    created_at: new Date(baseTime + 28 * 864e5).toISOString(),
    salary_min: 130000,
    salary_max: 160000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$130k - $160k",
    apply_url: "https://careers.frontendmasters.com/jobs/1",
    source_type: "direct",
    source: "direct",
    description: "Lead modern React and TypeScript architecture",
    skills: ["TypeScript", "React", "Next.js"],
    status: "active",
    is_active: true,
    logo_url: "https://cdn.example.com/logo-frontend.png",
  });

  jobs.push({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Junior Frontend Developer",
    company: "Web Craft Studio",
    company_id: "co_webcraft",
    location: "San Francisco, CA",
    category: "engineering",
    remote: false,
    is_remote: false,
    remote_scope: "onsite",
    country_code: "US",
    job_type: "full-time",
    verified: true,
    posted_at: new Date(baseTime + 25 * 864e5).toISOString(),
    created_at: new Date(baseTime + 25 * 864e5).toISOString(),
    salary_min: 75000,
    salary_max: 90000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$75k - $90k",
    apply_url: "https://careers.webcraft.com/jobs/2",
    description: "Assist with web components",
    skills: ["JavaScript", "HTML", "CSS"],
    status: "active",
    is_active: true,
    logo_url: "https://cdn.example.com/logo-webcraft.png",
  });

  jobs.push({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Lead Sales Executive",
    company: "Apex Sales Group",
    company_id: "co_sales",
    location: "New York, NY",
    category: "sales",
    remote: false,
    is_remote: false,
    remote_scope: "onsite",
    country_code: "US",
    job_type: "part-time",
    verified: true,
    posted_at: new Date(baseTime + 29 * 864e5).toISOString(), // Newer, but non-matching category
    created_at: new Date(baseTime + 29 * 864e5).toISOString(),
    salary_min: 50000,
    salary_max: 70000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$50k - $70k",
    apply_url: "https://careers.apexsales.com/jobs/3",
    description: "Outbound enterprise sales",
    skills: ["Sales", "CRM"],
    status: "active",
    is_active: true,
    logo_url: "https://cdn.example.com/logo-sales.png",
  });

  jobs.push({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Junior Entry Web Developer",
    company: "Remote Craft Inc",
    company_id: "co_remotecraft",
    location: "Remote (Worldwide)",
    category: "engineering",
    remote: true,
    is_remote: true,
    remote_scope: "worldwide",
    country_code: "US",
    job_type: "full-time",
    verified: true,
    posted_at: new Date(baseTime + 27 * 864e5).toISOString(),
    created_at: new Date(baseTime + 27 * 864e5).toISOString(),
    salary_min: 65000,
    salary_max: 80000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$65k - $80k",
    apply_url: "https://careers.remotecraft.com/jobs/4",
    description: "Entry level web development",
    skills: ["JavaScript", "HTML", "CSS"],
    status: "active",
    is_active: true,
    logo_url: "https://cdn.example.com/logo-remotecraft.png",
  });

  // Remaining jobs to reach 300+ items (all remote engineering to test page 1 vs page 11 with exclusions)
  for (let i = 5; i <= count; i++) {
    jobs.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: `Software Engineer #${i}`,
      company: `Company ${i}`,
      company_id: `co_${i}`,
      location: "Remote (Worldwide)",
      category: "engineering",
      remote: true,
      is_remote: true,
      remote_scope: "worldwide",
      country_code: "US",
      job_type: "full-time",
      source_type: "direct",
      source: "direct",
      verified: true,
      posted_at: new Date(baseTime + (i % 24) * 864e5).toISOString(),
      created_at: new Date(baseTime + (i % 24) * 864e5).toISOString(),
      salary_min: 80000 + i * 100,
      salary_max: 120000 + i * 100,
      currency: "USD",
      salary_period: "year",
      salary_text: `$${80 + Math.floor(i / 10)}k - $${120 + Math.floor(i / 10)}k`,
      apply_url: `https://careers.company${i}.com/job/${i}`,
      description: `Job description for position #${i}`,
      skills: ["General", "Tech", "React"],
      status: "active",
      is_active: true,
      logo_url: `https://cdn.example.com/logo-${i}.png`,
    });
  }

  return jobs;
}

const req = (url: string, token?: string) =>
  new Request(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

let recommendedRoute: (r: Request) => Promise<Response>;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  recommendedRoute = (await import("@/app/api/jobs/recommended/route")).GET;
}, 30000);

beforeEach(() => {
  process.env.COMPANY_GROUP_ID_SECRET = "test-hmac-secret-012345678901234567890";
  const corpus = generateTestCorpus(320);

  state.users = {
    "tok-free-with-answers": {
      id: "u_free_answers",
      email: "free-answers@example.com",
      user_metadata: {},
    },
    "tok-pro-with-answers": {
      id: "u_pro_answers",
      email: "pro-answers@example.com",
      user_metadata: {},
    },
    "tok-user-no-answers": {
      id: "u_no_answers",
      email: "no-answers@example.com",
      user_metadata: {},
    },
  };

  state.queries = [];
  state.failWhen = null;
  state.rpcFail = null;
  state.rpcGate = null;
  state.afterFrozenRead = null;
  state.tables = {
    jobs: corpus,
    jobs_public: corpus,
    subscriptions: [
      {
        user_id: "u_pro_answers",
        status: "active",
        plan_id: "monthly",
        current_period_end: new Date(Date.now() + 15 * 864e5).toISOString(),
        grace_period_end: null,
        created_at: new Date().toISOString(),
      },
    ],
    user_preferences: [
      {
        user_id: "u_free_answers",
        roles: ["Frontend Developer"],
        experience_level: "senior",
        remote_preference: "remote",
        locations: ["Worldwide / Remote", "United States"],
        employment_types: ["full-time"],
        categories: ["engineering"],
        onboarding_completed: true,
      },
      {
        user_id: "u_pro_answers",
        roles: ["Frontend Developer"],
        experience_level: "senior",
        remote_preference: "remote",
        locations: ["Worldwide / Remote", "United States"],
        employment_types: ["full-time"],
        categories: ["engineering"],
        onboarding_completed: true,
      },
      {
        user_id: "u_no_answers",
        roles: [],
        experience_level: null,
        remote_preference: null,
        locations: [],
        employment_types: [],
        categories: [],
        onboarding_completed: false,
      },
    ],
  };

  // Mock global fetch to dispatch to recommendedRoute for full UI -> service -> handler tests
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.includes("/api/jobs/recommended")) {
      const request = new Request(urlStr, init);
      return await recommendedRoute(request);
    }
    return originalFetch(input, init);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /api/jobs/recommended Handler & Service Integration", () => {
  describe("1. Real Limit, Range & Order Execution (Page 1 vs Page 11)", () => {
    it("Page 1 returns 25 items from top of ranked pool with honest totalCount", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=1&pageSize=25", "tok-free-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(25);
      expect(body.jobs.length).toBe(25);
      expect(body.totalCount).toBeGreaterThanOrEqual(300);
      expect(body.jobs[0].id).toBe("11111111-1111-4111-8111-111111111111"); // Top match
    });

    it("Page 11 is NOT empty: returns 25 distinct items (indices 250..274) with stable pagination", async () => {
      const res1 = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=1&pageSize=25", "tok-free-with-answers")
      );
      const res11 = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=11&pageSize=25", "tok-free-with-answers")
      );

      expect(res11.status).toBe(200);
      const body1 = await res1.json();
      const body11 = await res11.json();

      expect(body11.page).toBe(11);
      expect(body11.jobs.length).toBe(25);
      expect(body11.totalCount).toBe(body1.totalCount);

      // Verify page 11 items are completely distinct from page 1 items
      const page1Ids = new Set(body1.jobs.map((j: any) => j.id));
      for (const job of body11.jobs) {
        expect(page1Ids.has(job.id)).toBe(false);
      }
    });

    it("User without answers falls back to latest jobs with range pagination over corpus", async () => {
      const res1 = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=1&pageSize=25", "tok-user-no-answers")
      );
      const res11 = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=11&pageSize=25", "tok-user-no-answers")
      );

      expect(res1.status).toBe(200);
      expect(res11.status).toBe(200);

      const body1 = await res1.json();
      const body11 = await res11.json();

      expect(body1.personalized).toBe(false);
      expect(body11.personalized).toBe(false);
      expect(body1.jobs.length).toBe(25);
      expect(body11.jobs.length).toBe(25);
      expect(body1.totalCount).toBe(320);
      expect(body11.totalCount).toBe(320);
    });

    it("Validates page and pageSize parameters (gracefully handles NaN and out-of-bounds)", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?page=NaN&pageSize=xyz", "tok-free-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(25);
      expect(body.jobs.length).toBe(25);
    });
  });

  describe("2. Free User Masking vs Pro User (Page 1 & Page 11)", () => {
    it("Free user: company is 'Verified Employer', opaque companyGroupId, salary empty, applyUrl empty on Page 1 AND Page 11", async () => {
      for (const pageNum of [1, 11]) {
        const res = await recommendedRoute(
          req(`http://localhost/api/jobs/recommended?page=${pageNum}&pageSize=25`, "tok-free-with-answers")
        );
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.isPro).toBe(false);
        expect(body.jobs.length).toBe(25);

        for (const job of body.jobs) {
          expect(job.company).toBe("Verified Employer");
          expect(job.company_id).toBeUndefined();
          expect(job.companyId).toBeUndefined();
          expect(typeof job.companyGroupId).toBe("string");
          expect(job.companyGroupId.length).toBeGreaterThan(0);
          expect(job.salary).toBe("");
          expect(job.salary_display).toBeNull();
          expect(job.applyUrl).toBe("");
          expect(job.skills).toEqual([]);
          expect(job.logoUrl).toBeNull();
        }
      }
    });

    it("Pro user: unmasked company name, companyId, salary, applyUrl, and skills on Page 1 AND Page 11", async () => {
      for (const pageNum of [1, 11]) {
        const res = await recommendedRoute(
          req(`http://localhost/api/jobs/recommended?page=${pageNum}&pageSize=25`, "tok-pro-with-answers")
        );
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.isPro).toBe(true);
        expect(body.jobs.length).toBe(25);

        for (const job of body.jobs) {
          expect(job.company).not.toBe("Verified Employer");
          expect(job.companyId).toBeTruthy();
          expect(typeof job.applyUrl).toBe("string");
          expect(job.applyUrl.length).toBeGreaterThan(0);
        }
      }
    });

    it("Fails closed with 503 if company group secret is missing for Free user", async () => {
      const origSecret = process.env.COMPANY_GROUP_ID_SECRET;
      delete process.env.COMPANY_GROUP_ID_SECRET;
      delete process.env.CAREERMONKE_COMPANY_GROUP_SECRET;
      delete process.env.COMPANY_GROUP_SECRET;

      try {
        const res = await recommendedRoute(
          req("http://localhost/api/jobs/recommended?page=1&pageSize=25", "tok-free-with-answers")
        );
        expect(res.status).toBe(503);

        const body = await res.json();
        expect(body.error).toBe("Database service unavailable");
        expect(body.jobs).toEqual([]);
      } finally {
        process.env.COMPANY_GROUP_ID_SECRET = origSecret;
      }
    });
  });

  describe("3. UI -> Service (getLiveJobs) -> Handler (/api/jobs/recommended) End-to-End Flow", () => {
    it("Calls /api/jobs/recommended through getLiveJobs for match sort without resume", async () => {
      const freePrefs = state.tables.user_preferences[0];

      const res = await getLiveJobs({
        baseUrl: "http://localhost",
        sortBy: "match",
        page: 1,
        pageSize: 25,
        candidate: null,
        preferences: freePrefs,
      });

      expect(res.isDegraded).toBe(false);
      expect(res.jobs.length).toBe(25);
      expect(res.totalCount).toBeGreaterThanOrEqual(300);
      expect(res.hasNextPage).toBe(true);

      // Verify masked for Free user
      expect(res.jobs[0].company).toBe("Verified Employer");
      expect(res.jobs[0].salary).toBe("");
      expect(res.jobs[0].applyUrl).toBe("");

      // Verify Page 11 through getLiveJobs
      const resPage11 = await getLiveJobs({
        baseUrl: "http://localhost",
        sortBy: "match",
        page: 11,
        pageSize: 25,
        candidate: null,
        preferences: freePrefs,
      });

      expect(resPage11.jobs.length).toBe(25);
      expect(resPage11.jobs[0].company).toBe("Verified Employer");
      expect(resPage11.jobs[0].id).not.toBe(res.jobs[0].id);
    });

    it("Passes all shared hard filter parameters to /api/jobs/recommended via getLiveJobs", async () => {
      const freePrefs = state.tables.user_preferences[0];

      const res = await getLiveJobs({
        baseUrl: "http://localhost",
        sortBy: "match",
        page: 1,
        pageSize: 10,
        candidate: null,
        preferences: freePrefs,
        category: "engineering",
        remoteOnly: true,
        location: "Remote",
        level: "senior",
        jobType: "full-time",
        workModel: "remote",
        countryCode: "US",
        datePosted: "month",
        experience: "senior",
        salaryMin: 100000,
        sourceType: "direct",
        company: "Frontend Masters Inc",
        search: "Frontend",
      });

      expect(res.isDegraded).toBe(false);
      expect(res.jobs.length).toBeGreaterThanOrEqual(1);
      expect(res.jobs[0].title).toContain("Frontend");

      // Negative assertions: hard filters executed by mock strictly drop non-matching jobs
      expect(res.jobs.every((j) => j.company === "Frontend Masters Inc" || j.company === "Verified Employer")).toBe(true);
      expect(res.jobs.some((j) => j.company === "Apex Sales Group")).toBe(false);
      expect(res.jobs.some((j) => j.category === "sales")).toBe(false);
      expect(res.jobs.every((j) => j.remote === true)).toBe(true);
      expect(res.jobs.some((j) => j.remote === false)).toBe(false);
    });

    it("Route-level test: explicit workModel=remote&experience=entry hard filters, assert no returned row has remote=false or matchScore=0", async () => {
      const res = await recommendedRoute(
        req(
          "http://localhost/api/jobs/recommended?experience=entry&workModel=remote&pageSize=100",
          "tok-user-no-answers"
        )
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jobs).toBeDefined();
      expect(json.jobs.length).toBeGreaterThan(0);

      // Assert no returned row has remote=false or matchScore=0
      for (const job of json.jobs) {
        expect(job.remote).not.toBe(false);
        expect(job.remote).toBe(true);
        expect(job.matchScore).toBeDefined();
        expect(job.matchScore).not.toBe(0);
        expect(job.matchScore).toBeGreaterThan(0);
      }

      // Negative assertions: assert incompatible jobs in fixture were strictly excluded
      const returnedIds = new Set(json.jobs.map((j: any) => j.id));
      // Non-remote job must be excluded
      expect(returnedIds.has("22222222-2222-4222-8222-222222222222")).toBe(false);
      // Senior job must be excluded for entry level
      expect(returnedIds.has("11111111-1111-4111-8111-111111111111")).toBe(false);
      // Lead sales job (seniority + non-remote) must be excluded
      expect(returnedIds.has("33333333-3333-4333-8333-333333333333")).toBe(false);
      // Entry remote job must be included
      expect(returnedIds.has("44444444-4444-4444-8444-444444444444")).toBe(true);
    });

    it("getLiveJobs handles 403, 503, and fallback 500 cleanly", async () => {
      const freePrefs = state.tables.user_preferences[0];

      // 1. 403 response
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: any) => {
        if (String(input).includes("/api/jobs/recommended")) {
          return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
        }
        return origFetch(input);
      });

      const res403 = await getLiveJobs({
        baseUrl: "http://localhost",
        sortBy: "match",
        preferences: freePrefs,
      });
      expect(res403.error).toBe("forbidden");
      expect(res403.jobs).toEqual([]);

      // 2. 503 response
      globalThis.fetch = vi.fn(async (input: any) => {
        if (String(input).includes("/api/jobs/recommended")) {
          return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
        }
        return origFetch(input);
      });

      const res503 = await getLiveJobs({
        baseUrl: "http://localhost",
        sortBy: "match",
        preferences: freePrefs,
      });
      expect(res503.isDegraded).toBe(true);
      expect(res503.error).toBe("degraded");
      expect(res503.jobs).toEqual([]);

      // Restore
      globalThis.fetch = origFetch;
    });

    it("Propagates query overrides and ranks top match first", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended?roles=Senior%20Frontend%20Developer&workModel=remote", "tok-user-no-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.personalized).toBe(true);
      expect(body.jobs[0].id).toBe("11111111-1111-4111-8111-111111111111");
      expect(body.jobs[0].matchScore).toBeGreaterThan(60);
    });

    it("Handler-level test: job salary 12000 USD period 'year' with minSalary 100000 USD must return empty", async () => {
      const lowSalaryJob = {
        id: "low-salary-12k-usd-year",
        title: "Frontend Developer",
        company: "Budget Tech",
        company_id: "co_budget",
        location: "Remote",
        category: "engineering",
        remote: true,
        is_remote: true,
        remote_scope: "remote",
        country_code: "US",
        job_type: "full-time",
        verified: true,
        posted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        salary_min: 12000,
        salary_max: 12000,
        currency: "USD",
        salary_period: "year",
        salary_text: "$12,000 / year",
        apply_url: "https://example.com/apply",
        description: "Frontend developer role",
        skills: ["React"],
        status: "active",
        is_active: true,
        logo_url: "https://cdn.example.com/logo-budget.png",
      };

      state.tables.jobs = [lowSalaryJob];
      state.tables.jobs_public = [lowSalaryJob];

      const res = await recommendedRoute(
        req(
          "http://localhost/api/jobs/recommended?minSalary=100000&salaryCurrency=USD",
          "tok-user-no-answers"
        )
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jobs).toBeDefined();
      expect(json.jobs.length).toBe(0);
      expect(json.totalCount).toBe(0);
    });
  });
});

describe("4. Parsed onboarding resume / LinkedIn PDF ranking (behind the Step 2 flag)", () => {
  const STEP2_FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
  const PATH = "u_no_answers/onboarding/current.pdf";
  const older = new Date(Date.now() - 10 * 864e5).toISOString();
  const newer = new Date(Date.now() - 1 * 864e5).toISOString();
  const base = { status: "active", is_active: true, remote: true, remote_scope: "worldwide", location: "Remote", job_type: "full-time", category: "data" };

  beforeEach(() => {
    const jobs = [
      { ...base, id: "job-sales", title: "Account Executive", company_id: "co_a", posted_at: newer, created_at: newer, skills: [], description: "" },
      { ...base, id: "job-data", title: "Data Analyst", company_id: "co_b", posted_at: older, created_at: older, skills: ["SQL", "Tableau"], description: "Dashboards" },
    ];
    state.tables.jobs = jobs;
    state.tables.jobs_public = jobs;
    state.tables.onboarding_resume_uploads = [{ user_id: "u_no_answers", storage_path: PATH }];
    state.tables.onboarding_resume_profiles = [
      {
        user_id: "u_no_answers",
        parse_status: "parsed",
        source_storage_path: PATH,
        profile: { jobTitles: ["Data Analyst"], skills: ["SQL", "Tableau"], preferredRoles: [], education: [], yearsOfExperience: 3, location: null },
      },
    ];
  });
  afterEach(() => {
    delete process.env[STEP2_FLAG];
  });

  it("flag on: the user's parsed resume personalizes and reorders the list", async () => {
    process.env[STEP2_FLAG] = "true";
    const body = await (await recommendedRoute(req("http://localhost/api/jobs/recommended", "tok-user-no-answers"))).json();
    expect(body.personalized).toBe(true);
    expect(body.jobs[0].id).toBe("job-data");
  });

  it("flag off: the resume profile is ignored (latest first, not personalized)", async () => {
    process.env[STEP2_FLAG] = "false";
    const body = await (await recommendedRoute(req("http://localhost/api/jobs/recommended", "tok-user-no-answers"))).json();
    expect(body.personalized).toBe(false);
    expect(body.jobs[0].id).toBe("job-sales");
  });

  it("a profile parsed from an older upload is ignored", async () => {
    process.env[STEP2_FLAG] = "true";
    state.tables.onboarding_resume_uploads = [{ user_id: "u_no_answers", storage_path: "u_no_answers/onboarding/newer.pdf" }];
    const body = await (await recommendedRoute(req("http://localhost/api/jobs/recommended", "tok-user-no-answers"))).json();
    expect(body.personalized).toBe(false);
  });

  it("guests get no resume personalization", async () => {
    process.env[STEP2_FLAG] = "true";
    const body = await (await recommendedRoute(req("http://localhost/api/jobs/recommended"))).json();
    expect(body.personalized).toBe(false);
  });
});

describe("explicit Level filter on the current recommended feed (multi-level OR)", () => {
  it("level=entry,senior keeps only entry+senior jobs and never changes the stored-experience scoring", async () => {
    const { matchesExperienceLevelFilter } = await import("@/lib/jobs/experienceLevels");
    const unfiltered = await (
      await recommendedRoute(req("http://localhost/api/jobs/recommended?pageSize=100", "tok-pro-with-answers"))
    ).json();
    const filtered = await (
      await recommendedRoute(req("http://localhost/api/jobs/recommended?level=entry,senior&pageSize=100", "tok-pro-with-answers"))
    ).json();
    expect(filtered.jobs.length).toBeGreaterThan(0);
    for (const j of filtered.jobs) {
      expect(matchesExperienceLevelFilter({ title: j.title, type: j.type ?? j.jobType }, "entry,senior"), j.title).toBe(true);
    }
    const scoreById = new Map(unfiltered.jobs.map((j: any) => [j.id, j.matchScore]));
    for (const j of filtered.jobs) {
      if (scoreById.has(j.id)) expect(j.matchScore, j.title).toBe(scoreById.get(j.id));
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Signed-in Free user, no subscription: India + Open to Remote + intern (the "Recommended disappears" bug).
// UI layer = the exact getLiveJobs() call the Jobs page makes on the Recommended tab (empty filter defaults,
// sortBy "match", saved preferences), dispatched through the service into the real route handler.
// ---------------------------------------------------------------------------------------------------
describe("5. Signed-in Free (no subscription): India + Open to Remote + intern", () => {
  const TOKEN = "tok-free-india";
  const USER_ID = "u_free_india";
  const day = 864e5;
  const mk = (id: string, title: string, extra: Record<string, unknown>, ageDays = 1) => ({
    id,
    title,
    company: `Company ${id}`,
    company_id: `co_${id}`,
    category: "engineering",
    job_type: "full-time",
    remote: false,
    remote_scope: "onsite",
    remote_eligibility: null,
    country_code: null,
    status: "active",
    is_active: true,
    posted_at: new Date(Date.now() - ageDays * day).toISOString(),
    created_at: new Date(Date.now() - ageDays * day).toISOString(),
    salary_min: 30000,
    salary_max: 40000,
    currency: "INR",
    salary_period: "month",
    salary_text: "₹30k - ₹40k / month",
    apply_url: `https://careers.example.com/${id}`,
    description: `Description for ${id}`,
    skills: ["Python", "SQL"],
    logo_url: `https://cdn.example.com/${id}.png`,
    ...extra,
  });

  // Eligible for an India + Open to Remote + intern seeker
  const ELIGIBLE = {
    inIntern: mk("in-intern", "Software Engineering Intern", { location: "Bengaluru, India", country_code: "IN", job_type: "internship" }),
    wwGrad: mk("ww-grad", "Graduate Software Engineer", { location: "Remote (Worldwide)", remote: true, remote_scope: "worldwide" }, 2),
    // On-role title: the relevance gate (correctly) drops off-role jobs such as a Data Analyst for a Software Engineer
    unrestrictedRemote: mk("remote-junior", "Junior Software Developer", { location: "Remote", remote: true, remote_scope: "remote" }, 3),
    inInternal: mk("in-internal", "Internal Tools Engineer", { location: "Pune, India", country_code: "IN" }, 4),
  };
  // Must never appear: restricted elsewhere, Indiana (not India), or senior
  const EXCLUDED = {
    usRemoteRestricted: mk("us-remote-intern", "Software Engineer Intern", {
      location: "Remote, United States",
      country_code: "US",
      remote: true,
      remote_scope: "remote",
      remote_eligibility: "country_restricted",
      job_type: "internship",
    }),
    indiana: mk("indiana-intern", "Software Engineer Intern", { location: "Indianapolis, Indiana", country_code: "US", job_type: "internship" }),
    inSenior: mk("in-senior", "Senior Software Engineer", { location: "Bengaluru, India", country_code: "IN" }),
  };
  const usOnsite = Array.from({ length: 30 }, (_, i) =>
    mk(`us-ae-${i}`, `Account Executive ${i}`, { location: "Austin, TX", country_code: "US", category: "sales" }, 0.5)
  );

  // What the Jobs page passes as `preferences` (getUserPreferences shape) for this account
  const indiaPrefs: any = {
    roles: ["Software Engineer"],
    experienceLevel: "intern",
    remotePreference: "remote", // onboarding "Open to Remote" on
    locations: ["India"],
    country: "India",
    countryCode: "IN",
    employmentTypes: ["internship", "full-time"],
  };
  // Exact Recommended-tab call from src/app/jobs/page.tsx with its empty filter defaults
  const pageCall = (overrides: Record<string, unknown> = {}) => ({
    baseUrl: "http://localhost",
    page: 1,
    pageSize: 25,
    category: "",
    search: "",
    remoteOnly: false,
    location: "",
    level: "",
    jobType: "",
    countryCode: "",
    workModel: "",
    datePosted: "",
    experience: "",
    salaryMin: undefined,
    sourceType: "",
    company: "",
    isPro: false,
    sortBy: "match" as const,
    candidate: null,
    preferences: indiaPrefs,
    ...overrides,
  });

  let recommendedUrls: string[] = [];

  beforeEach(async () => {
    const jobs = [...Object.values(ELIGIBLE), ...Object.values(EXCLUDED), ...usOnsite];
    state.tables.jobs = jobs;
    state.tables.jobs_public = jobs;
    state.users[TOKEN] = { id: USER_ID, email: "free-india@example.com", user_metadata: {} };
    // No subscriptions row for this user: a signed-in Free account
    state.tables.user_preferences = [
      ...state.tables.user_preferences,
      {
        user_id: USER_ID,
        roles: ["Software Engineer"],
        experience_level: "intern",
        remote_preference: "remote",
        locations: ["India"],
        employment_types: ["internship", "full-time"],
        categories: [],
        onboarding_completed: true,
      },
    ];

    // Signed-in browser session -> service sends Authorization: Bearer <token>
    const { createClient } = await import("@supabase/supabase-js");
    const db: any = (createClient as any)();
    (globalThis as any).__mockSupabaseClient = {
      ...db,
      from: db.from,
      auth: { ...db.auth, getSession: async () => ({ data: { session: { access_token: TOKEN } }, error: null }) },
    };

    recommendedUrls = [];
    const routeFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/jobs/recommended")) recommendedUrls.push(url);
      return routeFetch(input, init);
    });
  });

  afterEach(() => {
    delete (globalThis as any).__mockSupabaseClient;
    delete process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED;
  });

  const ids = (jobs: any[]) => new Set(jobs.map((j) => j.id));
  const expectEligibleMasked = (jobs: any[]) => {
    const got = ids(jobs);
    for (const j of Object.values(ELIGIBLE)) expect(got.has(j.id), `missing eligible ${j.id}`).toBe(true);
    for (const j of Object.values(EXCLUDED)) expect(got.has(j.id), `leaked ${j.id}`).toBe(false);
    expect(jobs.some((j) => String(j.id).startsWith("us-ae-"))).toBe(false);
    for (const j of jobs) {
      // Server-side masking for Free: no company, salary, apply link, description or skills
      expect(j.company).toBe("Verified Employer");
      expect(j.applyUrl).toBe("");
      expect(j.salary).toBe("");
      expect(j.description).toBe("");
      expect(j.skills).toEqual([]);
      expect(j.logoUrl).toBeNull();
    }
  };

  it("no resume: masked eligible cards appear (India jobs + worldwide/unrestricted remote, interns included)", async () => {
    const res = await getLiveJobs(pageCall() as any);

    expect(res.isDegraded).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.jobs.length).toBe(Object.keys(ELIGIBLE).length);
    expect(res.totalCount).toBe(Object.keys(ELIGIBLE).length);
    expectEligibleMasked(res.jobs);

    // Saved preferences travel as ranking params; none of them is an explicit hard-filter param
    const url = new URL(recommendedUrls[0]);
    expect(url.searchParams.get("experienceLevel")).toBe("intern");
    expect(url.searchParams.get("countryCode")).toBe("India"); // saved country, a ranking preference
    expect(url.searchParams.get("remotePreference")).toBe("remote");
    for (const hard of ["experience", "country_code", "workModel", "level", "location"]) {
      expect(url.searchParams.has(hard), hard).toBe(false);
    }
  });

  it("owner-shaped request straight to the endpoint (Bearer Free token, saved prefs as params) returns masked eligible jobs", async () => {
    const res = await recommendedRoute(
      req(
        "http://localhost/api/jobs/recommended?page=1&pageSize=25&roles=Software%20Engineer&experienceLevel=intern&remotePreference=remote&locations=India&employmentTypes=internship%2Cfull-time&countryCode=IN",
        TOKEN
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isPro).toBe(false);
    expect(body.personalized).toBe(true);
    expectEligibleMasked(body.jobs);
  });

  it("with parsed onboarding resume (Step 2 flag on): same eligible masked set, resume only reorders", async () => {
    process.env.NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED = "true";
    const path = `${USER_ID}/onboarding/current.pdf`;
    state.tables.onboarding_resume_uploads = [{ user_id: USER_ID, storage_path: path }];
    state.tables.onboarding_resume_profiles = [
      {
        user_id: USER_ID,
        parse_status: "parsed",
        source_storage_path: path,
        profile: { jobTitles: ["Data Analyst"], skills: ["SQL", "Python"], preferredRoles: [], education: [], yearsOfExperience: 0, location: "India" },
      },
    ];
    const res = await getLiveJobs(pageCall() as any);
    expect(res.isDegraded).toBe(false);
    expect(res.jobs.length).toBe(Object.keys(ELIGIBLE).length);
    expectEligibleMasked(res.jobs);
  });

  it("with a confirmed resume profile (client ranking path): eligible masked jobs, no restricted or foreign jobs", async () => {
    const candidate: any = {
      headline: "Software Engineer",
      skills: ["Python", "SQL"],
      experience: [{ role: "Software Engineering Intern" }],
      confirmedAt: new Date().toISOString(),
    };
    const res = await getLiveJobs(pageCall({ candidate }) as any);
    expect(res.isDegraded).not.toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.jobs.length).toBeGreaterThan(0);
    const got = ids(res.jobs);
    expect(got.has(ELIGIBLE.inIntern.id)).toBe(true);
    expect(got.has(ELIGIBLE.wwGrad.id)).toBe(true);
    for (const j of Object.values(EXCLUDED)) expect(got.has(j.id), `leaked ${j.id}`).toBe(false);
    expect(res.jobs.some((j: any) => String(j.id).startsWith("us-ae-"))).toBe(false);
    for (const j of res.jobs) {
      expect(j.company).toBe("Verified Employer");
      expect(j.applyUrl).toBe("");
    }
  });

  it("explicit filters still restrict: country_code=IN drops worldwide remote; workModel=remote drops on-site India", async () => {
    const inOnly = await getLiveJobs(pageCall({ countryCode: "IN" }) as any);
    expect(Array.from(ids(inOnly.jobs)).sort()).toEqual([ELIGIBLE.inIntern.id, ELIGIBLE.inInternal.id].sort());

    const remoteOnly = await getLiveJobs(pageCall({ workModel: "remote" }) as any);
    expect(Array.from(ids(remoteOnly.jobs)).sort()).toEqual([ELIGIBLE.unrestrictedRemote.id, ELIGIBLE.wwGrad.id].sort());
  });

  it("explicit Experience=intern uses the shared early-career classifier (interns + graduates, not 'Internal')", async () => {
    const res = await getLiveJobs(pageCall({ experience: "intern" }) as any);
    const got = ids(res.jobs);
    expect(got.has(ELIGIBLE.inIntern.id)).toBe(true);
    expect(got.has(ELIGIBLE.wwGrad.id)).toBe(true);
    expect(got.has(ELIGIBLE.unrestrictedRemote.id)).toBe(true);
    expect(got.has(ELIGIBLE.inInternal.id)).toBe(false);
  });

  it("explicit Level=intern keeps its own meaning (job_type internship only)", async () => {
    const res = await getLiveJobs(pageCall({ level: "intern" }) as any);
    expect(Array.from(ids(res.jobs))).toEqual([ELIGIBLE.inIntern.id]);
  });

  it("genuine zero results stay honest: no eligible jobs -> empty, not degraded, nothing invented", async () => {
    const onlyIneligible = [...Object.values(EXCLUDED), ...usOnsite];
    state.tables.jobs = onlyIneligible;
    state.tables.jobs_public = onlyIneligible;
    const res = await getLiveJobs(pageCall() as any);
    expect(res.isDegraded).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.jobs).toEqual([]);
    expect(res.totalCount).toBe(0);
  });

  it("an explicit filter with no matches is honest and is never silently cleared", async () => {
    const res = await getLiveJobs(pageCall({ search: "Quantum Chef" }) as any);
    expect(res.isDegraded).toBe(false);
    expect(res.jobs).toEqual([]);
    expect(new URL(recommendedUrls[0]).searchParams.get("search")).toBe("Quantum Chef");
  });
});

describe("6. Non-success HTTP from /api/jobs/recommended is a retryable error, not an empty feed", () => {
  const prefs: any = { roles: ["Software Engineer"], experienceLevel: "intern", remotePreference: "remote", locations: ["India"] };
  const call = () => getLiveJobs({ baseUrl: "http://localhost", sortBy: "match", page: 1, pageSize: 25, candidate: null, preferences: prefs });
  // Only the recommended endpoint fails; the public fallback data stays reachable, so a silent
  // fallback (unpersonalized jobs shown as a normal feed) would be visible here.
  const failRecommended = (make: () => Promise<Response>) => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/jobs/recommended")) return make();
      throw new TypeError("no server in tests");
    });
  };
  const respond = (status: number) =>
    failRecommended(async () => new Response(JSON.stringify({ error: "x", jobs: [], totalCount: 0 }), { status }));

  beforeEach(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    (globalThis as any).__mockSupabaseClient = (createClient as any)();
  });
  afterEach(() => {
    delete (globalThis as any).__mockSupabaseClient;
  });

  for (const status of [500, 502, 503, 429]) {
    it(`HTTP ${status} -> isDegraded + error "degraded" (UI shows Retry)`, async () => {
      respond(status);
      const res = await call();
      expect(res.isDegraded).toBe(true);
      expect(res.error).toBe("degraded");
      expect(res.jobs).toEqual([]);
    });
  }

  it("network failure (fetch throws) -> isDegraded, never a fallback unpersonalized feed", async () => {
    failRecommended(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await call();
    expect(res.isDegraded).toBe(true);
    expect(res.error).toBe("degraded");
  });

  it("HTTP 200 with zero jobs is a successful honest empty feed (not degraded)", async () => {
    failRecommended(async () => new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200 }));
    const res = await call();
    expect(res.isDegraded).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.jobs).toEqual([]);
  });

  it("HTTP 403 stays a distinct forbidden error", async () => {
    respond(403);
    const res = await call();
    expect(res.error).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------------------------------
// Relevance gate + relevant candidate pool (one scoring path).
// 1,100 newest jobs are all off-role (sales, legal stored as category "engineering"); 5 older jobs are backend.
// The old pool (latest 1,000 jobs, then score) could never reach the backend jobs and recommended off-role ones.
// ---------------------------------------------------------------------------------------------------
describe("6. Relevance gate and relevant candidate pool", () => {
  const day = 864e5;
  const mk = (id: string, title: string, category: string, ageDays: number) => ({
    id,
    title,
    company: `Company ${id}`,
    company_id: `co_${id}`,
    category,
    job_type: "full-time",
    location: "Remote (Worldwide)",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    status: "active",
    is_active: true,
    posted_at: new Date(Date.now() - ageDays * day).toISOString(),
    created_at: new Date(Date.now() - ageDays * day).toISOString(),
    skills: [],
  });

  beforeEach(() => {
    const offRole = Array.from({ length: 1100 }, (_, i) =>
      i % 2 === 0
        ? mk(`ae-${i}`, `Enterprise Account Executive ${i}`, "sales", 1 + i / 1000)
        : mk(`counsel-${i}`, `Commercial Counsel ${i}`, "engineering", 1 + i / 1000)
    );
    const backend = Array.from({ length: 5 }, (_, i) => mk(`be-${i}`, `Backend Engineer ${i}`, "engineering", 60 + i));
    state.tables.jobs = [...offRole, ...backend];
    state.tables.jobs_public = state.tables.jobs;
  });

  it("finds older on-role jobs beyond the latest 1,000 and never returns off-role ones", async () => {
    const res = await recommendedRoute(
      req("http://localhost/api/jobs/recommended?roles=Backend%20Developer&experienceLevel=mid&remotePreference=remote&pageSize=50")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.map((j: any) => j.id).sort()).toEqual(["be-0", "be-1", "be-2", "be-3", "be-4"]);
    expect(body.jobs.every((j: any) => /backend/i.test(j.title))).toBe(true);
    expect(body.totalCount).toBe(5);
  });

  it("a user with no role, field or skills keeps the latest-jobs fallback (gate open)", async () => {
    const res = await recommendedRoute(req("http://localhost/api/jobs/recommended?pageSize=5"));
    const body = await res.json();
    expect(body.jobs).toHaveLength(5);
    expect(body.personalized).toBe(false);
  });
});

describe('item 18 real recommended, detail and reload route agreement', () => {
  it.each(['tok-pro-with-answers', 'tok-free-with-answers'])('keeps one score through actual handlers for %s', async (token) => {
    const searchRoute = (await import('@/app/api/jobs/search/route')).GET;
    const feedResponse = await recommendedRoute(req('http://localhost/api/jobs/recommended?pageSize=25', token));
    expect(feedResponse.status).toBe(200);
    const feed = await feedResponse.json();
    const row = feed.jobs[0];
    expect(typeof row.matchScore).toBe('number');
    const url = `http://localhost/api/jobs/search?id=${row.id}`;
    const first = await searchRoute(req(url, token));
    expect(first.status).toBe(200);
    const detail = (await first.json()).jobs[0];
    const reload = (await (await searchRoute(req(url, token))).json()).jobs[0];
    expect(detail.matchScore).toBe(row.matchScore);
    expect(reload.matchScore).toBe(row.matchScore);
    expect(detail.scoreRevision).toBe(row.scoreRevision);
    if (token === 'tok-pro-with-answers') {
      const proRoute = (await import('@/app/api/jobs/pro/route')).GET;
      const response = await proRoute(req(`http://localhost/api/jobs/pro?id=${row.id}`, token));
      expect(response.status).toBe(200);
      expect((await response.json()).job.matchScore).toBe(row.matchScore);
    }

  });
});

describe('item 18 saved profile revision lifecycle', () => {
  it.each(['tok-pro-with-answers', 'tok-free-with-answers'])('feed and reloaded detail agree after saved preference change for %s', async token => {
    const searchRoute=(await import('@/app/api/jobs/search/route')).GET;
    const oldFeed=await (await recommendedRoute(req('http://localhost/api/jobs/recommended?pageSize=25',token))).json();
    const id=oldFeed.jobs[0].id;
    const userId=state.users[token].id;
    const preferences=state.tables.user_preferences.find((p:any)=>p.user_id===userId)!;
    preferences.experience_level='entry';preferences.remote_preference='onsite';
    const feed=await (await recommendedRoute(req('http://localhost/api/jobs/recommended?pageSize=500',token))).json();
    const currentId=feed.jobs[0].id;
    const detail=await (await searchRoute(req(`http://localhost/api/jobs/search?id=${currentId}`,token))).json();
    const reload=await (await searchRoute(req(`http://localhost/api/jobs/search?id=${currentId}`,token))).json();
    expect(detail.jobs[0].matchScore).toBe(reload.jobs[0].matchScore);
    const matching=feed.jobs[0];
    expect(matching).toBeTruthy();
    expect(matching.matchScore).toBe(detail.jobs[0].matchScore);
    const oldJobReload=await (await searchRoute(req(`http://localhost/api/jobs/search?id=${id}`,token))).json();
    expect(oldJobReload.jobs[0].matchScore).not.toBe(oldFeed.jobs[0].matchScore);
  });
});


describe("recommended request phase telemetry", () => {
  it("logs real route stages and returns a correlatable generated id without sensitive fields", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await recommendedRoute(req("http://localhost/api/jobs/recommended?pageSize=20", "tok-free-with-answers"));
      expect(response.status).toBe(200);
      const id = response.headers.get("X-CM-Request-ID");
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      const rows = spy.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
        .filter(r => r?.msg === "recommended_request_timing" && r.requestId === id);
      expect(rows.map(r => r.stage)).toEqual(["setup", "db", "scoring", "format", "format"]);
      expect(rows.at(-1)).toMatchObject({ event: "finish", status: 200 });
      expect(rows.at(-1).candidateRows).toBeGreaterThan(0);
      expect(rows.at(-1).returnedRows).toBeLessThanOrEqual(20);
      for (const r of rows) {
        expect(Object.keys(r).every(k => ["route", "requestId", "cfRay", "event", "stage", "ts", "level", "msg", "setupWallMs", "dbWallMs", "scoringWallMs", "formatWallMs", "candidateRows", "rankedRows", "returnedRows", "totalWallMs", "status"].includes(k))).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });
});


describe("Narrow candidate query (no exact count; Pro-only columns hydrated for the returned page)", () => {
  // The candidate select on deployed main 2c09888c, for byte comparisons on the same rows.
  const MAIN_COLS = "id, title, company, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code, apply_url, description, skills, logo_url, company_id, companies(logo_url, domain)";
  const WIDE = /\b(description|skills|apply_url|logo_url|companies|last_seen_at|status|is_active)\b/;
  const url = "http://localhost/api/jobs/recommended?page=1&pageSize=25";
  const isHydrate = (q: any) => q.cols.startsWith("id, apply_url");
  const fullRow = (id: string) => state.tables.jobs.find((r: any) => r.id === id);
  const timingRows = (spy: any) => spy.mock.calls.map(([l]: any[]) => { try { return JSON.parse(String(l)); } catch { return null; } })
    .filter((r: any) => r?.msg === "recommended_request_timing");

  beforeEach(() => {
    // Realistic payload sizes: long descriptions and a company join.
    for (const r of state.tables.jobs) {
      r.description = `${r.description ?? ""} ${"Responsibilities and requirements. ".repeat(120)}`;
      r.companies = { logo_url: r.logo_url ?? null, domain: `${r.company_id}.example.com` };
    }
  });

  it("Free: candidate query has no count and no wide columns; payload stays masked", async () => {
    const res = await recommendedRoute(req(url, "tok-free-with-answers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].count).toBeUndefined();
    expect(state.queries[0].cols).not.toMatch(WIDE);
    expect(body.jobs).toHaveLength(25);
    for (const j of body.jobs) {
      expect(j).toMatchObject({ company: "Verified Employer", salary: "", salary_display: null, applyUrl: "", description: "", skills: [], logoUrl: null });
      expect(j.companyId).toBeUndefined();
      expect(j.companyGroupId).toMatch(/^[a-f0-9]{12}$/);
    }
  });

  it("Pro: one 25-row hydration; payload and paid card/detail score equal the full database row", async () => {
    // Freeze Date so the route's reference instant and the expected revision/score below are the same instant
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const now = Date.now();
    try {
    const res = await recommendedRoute(req(url, "tok-pro-with-answers"));
    const body = await res.json();
    const candidate = state.queries.filter((q) => !isHydrate(q));
    const hydrate = state.queries.filter(isHydrate);
    expect(candidate).toHaveLength(1);
    expect(candidate[0].cols).not.toMatch(WIDE);
    expect(candidate[0].count).toBeUndefined();
    expect(hydrate).toHaveLength(1);
    expect(hydrate[0].rows).toBe(25);
    const { scoreInputRevision } = await import("@/lib/matcher/scoring");
    const { sharedDisplayScore, loadDisplayScoreAnswers } = await import("@/lib/jobs/displayScore");
    const displayAnswers = await loadDisplayScoreAnswers((await import("@supabase/supabase-js")).createClient("x", "y") as any, "u_pro_answers");
    for (const j of body.jobs) {
      const row = fullRow(j.id);
      expect(j).toMatchObject({ company: row.company, companyId: row.company_id, applyUrl: row.apply_url, description: row.description, skills: row.skills, logoUrl: row.logo_url, companyDomain: row.companies.domain });
      expect(j.scoreRevision).toBe(scoreInputRevision(row, true, now));
      expect(j.matchScore).toBe(sharedDisplayScore(row, displayAnswers, true, now));
    }
    } finally {
      vi.useRealTimers();
    }
  });

  it("same page, same order and same scores as ranking the full rows (no-resume equivalence)", async () => {
    const free = await (await recommendedRoute(req(url, "tok-free-with-answers"))).json();
    const pro = await (await recommendedRoute(req(url, "tok-pro-with-answers"))).json();
    const { rankJobsByRecommendation } = await import("@/lib/jobs/recommendations");
    const { capJobsPerCompany } = await import("@/lib/jobs/capping");
    const answers = {
      roles: ["Frontend Developer"], experienceLevel: "senior", remotePreference: "remote",
      locations: ["Worldwide / Remote", "United States"], employmentTypes: ["full-time"], categories: ["engineering"],
      minSalary: null, salaryCurrency: "USD", country: "United States", countryCode: "US", resumeProfile: null,
    };
    const expected = capJobsPerCompany(rankJobsByRecommendation(state.tables.jobs, answers as any).filter((j: any) => j.matchScore > 0), 3, 30)
      .slice(0, 25).map((j: any) => j.id);
    expect(free.jobs.map((j: any) => j.id)).toEqual(expected);
    expect(pro.jobs.map((j: any) => j.id)).toEqual(expected);
  });

  it("bytes: the candidate response is much smaller than deployed main's select on the same rows", async () => {
    await recommendedRoute(req(url, "tok-free-with-answers"));
    const narrow = state.queries[0];
    const ids = new Set(narrow.ids);
    const wideBytes = new TextEncoder().encode(JSON.stringify(projectRows(state.tables.jobs.filter((r: any) => ids.has(r.id)), MAIN_COLS))).length;
    console.info(`NARROW_BYTES rows=${narrow.rows} narrow=${narrow.bytes} main=${wideBytes} ratio=${(narrow.bytes / wideBytes).toFixed(3)}`);
    expect(narrow.rows).toBeGreaterThan(300);
    expect(narrow.bytes).toBeLessThan(wideBytes / 5);
  });

  describe("with a parsed onboarding resume (Step 2 flag on)", () => {
    const STEP2 = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
    const PATH = "u_free_answers/onboarding/current.pdf";
    const profile = { jobTitles: ["Frontend Engineer"], skills: ["React", "TypeScript"], preferredRoles: [], education: [], yearsOfExperience: 4, location: null };
    beforeEach(() => {
      process.env[STEP2] = "true";
      state.tables.onboarding_resume_uploads = [{ user_id: "u_free_answers", storage_path: PATH }];
      state.tables.onboarding_resume_profiles = [{ user_id: "u_free_answers", parse_status: "parsed", source_storage_path: PATH, profile }];
    });
    afterEach(() => { delete process.env[STEP2]; });

    it("keeps description and skills in the candidate query; order and eligibility equal ranking the full rows", async () => {
      const body = await (await recommendedRoute(req(url, "tok-free-with-answers"))).json();
      expect(body.personalized).toBe(true);
      expect(state.queries[0].cols).toMatch(/\bdescription\b/);
      expect(state.queries[0].cols).toMatch(/\bskills\b/);
      const { rankJobsByRecommendation } = await import("@/lib/jobs/recommendations");
      const { capJobsPerCompany } = await import("@/lib/jobs/capping");
      const answers = {
        roles: ["Frontend Developer"], experienceLevel: "senior", remotePreference: "remote",
        locations: ["Worldwide / Remote", "United States"], employmentTypes: ["full-time"], categories: ["engineering"],
        minSalary: null, salaryCurrency: "USD", country: "United States", countryCode: "US",
        resumeProfile: { jobTitles: profile.jobTitles, skills: profile.skills, preferredRoles: [], yearsOfExperience: 4 },
      };
      const expected = capJobsPerCompany(rankJobsByRecommendation(state.tables.jobs, answers as any).filter((j: any) => j.matchScore > 0), 3, 30)
        .slice(0, 25).map((j: any) => j.id);
      expect(body.jobs.map((j: any) => j.id)).toEqual(expected);
      // Free masking unchanged with a resume.
      expect(body.jobs.every((j: any) => j.description === "" && j.skills.length === 0)).toBe(true);
    });
  });

  it("a failed hydration is a 503 (never an empty success), and the timing log shows both db stages", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      state.failWhen = (_t, cols) => cols.startsWith("id, apply_url");
      const res = await recommendedRoute(req(url, "tok-pro-with-answers"));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBeTruthy();
      const id = res.headers.get("X-CM-Request-ID");
      const rows = timingRows(spy).filter((r: any) => r.requestId === id);
      expect(rows.map((r: any) => r.stage)).toEqual(["setup", "db", "scoring", "hydrate", "hydrate"]);
      expect(rows.at(-1)).toMatchObject({ event: "finish", status: 503 });
      expect(typeof rows.at(-1).dbWallMs).toBe("number");
      expect(typeof rows.at(-1).hydrateWallMs).toBe("number");
    } finally { spy.mockRestore(); }
  });

  it("a hydration miss (row deleted after ranking) leaves out only that row", async () => {
    const before = await (await recommendedRoute(req(url, "tok-pro-with-answers"))).json();
    const victim = before.jobs[7].id;
    state.queries = [];
    const all = state.tables.jobs;
    const origPush = state.queries.push.bind(state.queries);
    state.queries.push = ((q: any) => {
      if (!isHydrate(q)) state.tables.jobs = all.filter((j: any) => j.id !== victim); // gone before hydration
      return origPush(q);
    }) as any;
    const after = await (await recommendedRoute(req(url, "tok-pro-with-answers"))).json();
    expect(after.jobs.map((j: any) => j.id)).toEqual(before.jobs.map((j: any) => j.id).filter((id: string) => id !== victim));
    expect(after.jobs.every((j: any) => j.description && j.applyUrl)).toBe(true);
  });

  // Each way a ranked job can become ineligible between the candidate query and hydration.
  const inactiveChanges: Array<[string, (row: any) => void]> = [
    ["is_active becomes false", (row) => { row.is_active = false; }],
    ["status becomes closed", (row) => { row.status = "closed"; }],
    ["status becomes expired", (row) => { row.status = "expired"; }],
    ["status becomes null", (row) => { row.status = null; }],
    ["both status and is_active change", (row) => { row.status = "closed"; row.is_active = false; }],
  ];
  it.each(inactiveChanges)("a job that goes inactive after ranking (%s) is left out of the Pro page; the rest keep their order", async (_label, change) => {
    const before = await (await recommendedRoute(req(url, "tok-pro-with-answers"))).json();
    // First, middle and last positions of the page.
    const victims = [before.jobs[0].id, before.jobs[9].id, before.jobs[before.jobs.length - 1].id];
    state.queries = [];
    const origPush = state.queries.push.bind(state.queries);
    let changed = false;
    state.queries.push = ((q: any) => {
      if (!changed && !isHydrate(q)) {
        // The candidate query has already returned these rows as active; change them before hydration runs.
        for (const id of victims) change(state.tables.jobs.find((j: any) => j.id === id));
        changed = true;
      }
      return origPush(q);
    }) as any;
    const res = await recommendedRoute(req(url, "tok-pro-with-answers"));
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(changed).toBe(true);
    expect(after.jobs.map((j: any) => j.id)).toEqual(before.jobs.map((j: any) => j.id).filter((id: string) => !victims.includes(id)));
    expect(after.jobs.every((j: any) => j.description && j.applyUrl && j.company !== "Verified Employer")).toBe(true);
    // The candidate query did see them: only hydration's recheck removed them.
    const candidate = state.queries.find((q: any) => !isHydrate(q))!;
    expect(victims.every((id) => candidate.ids.includes(id))).toBe(true);
    const hydrate = state.queries.find(isHydrate)!;
    expect(victims.some((id) => hydrate.ids.includes(id))).toBe(false);
  });

  it("a hydration query error with some jobs gone inactive is still a 503, never a partial or empty success", async () => {
    const before = await (await recommendedRoute(req(url, "tok-pro-with-answers"))).json();
    state.tables.jobs.find((j: any) => j.id === before.jobs[2].id).is_active = false;
    state.failWhen = (_t, cols) => cols.startsWith("id, apply_url");
    const res = await recommendedRoute(req(url, "tok-pro-with-answers"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------- full-corpus snapshot PROTOTYPE (flag-gated)
describe("snapshot prototype: /api/jobs/recommended/snapshot (FEED_SNAPSHOT_PROTOTYPE=on)", () => {
  let snapshotRoute: (r: Request) => Promise<Response>;
  let store: { size(): number; deleteExpired(now: number): Promise<void> };
  const BASE = "http://localhost/api/jobs/recommended";
  const GUEST = "roles=Frontend%20Developer&experienceLevel=senior";
  const call = async (url: string, token?: string) => {
    const res = await snapshotRoute(req(url, token));
    return { status: res.status, body: await res.json() };
  };
  /** Every page of one snapshot, following nextCursor. */
  async function walk(query: string, token?: string, pageSize = 25) {
    const pages: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const { status, body } = await call(`${BASE}/snapshot?${query}&pageSize=${pageSize}${cursor ? `&cursor=${cursor}` : ""}`, token);
      expect(status).toBe(200);
      pages.push(body);
      if (!body.hasNextPage) return pages;
      cursor = body.nextCursor;
    }
    throw new Error("no end");
  }
  const ids = (pages: any[]): string[] => pages.flatMap((p) => p.jobs.map((j: any) => j.id));
  const row = (i: number, title: string, daysAgo: number, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, title, company: `Co ${i}`, company_id: `co_s${i}`,
    location: "Remote (Worldwide)", category: "engineering", remote: true, is_remote: true, remote_scope: "worldwide",
    country_code: "US", job_type: "full-time", verified: true, source_type: "direct", source: "direct",
    posted_at: new Date(Date.now() - daysAgo * 864e5).toISOString(), created_at: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    first_seen_at: new Date(Date.now() - daysAgo * 864e5).toISOString(), salary_min: 90000, salary_max: 120000, currency: "USD",
    salary_period: "year", salary_text: "$90k - $120k", apply_url: `https://careers.example.invalid/${i}`, description: "FIXTURE",
    skills: ["React"], status: "active", is_active: true, logo_url: null, ...over,
  });

  beforeAll(async () => {
    process.env.FEED_SNAPSHOT_PROTOTYPE = "on";
    const mod = await import("@/app/api/jobs/recommended/snapshot/route");
    snapshotRoute = mod.GET;
    store = (await import("@/lib/jobs/feedSnapshot")).prototypeMemoryStore;
  });
  afterAll(() => {
    delete process.env.FEED_SNAPSHOT_PROTOTYPE;
  });
  beforeEach(async () => {
    await store.deleteExpired(Number.MAX_SAFE_INTEGER);
    for (const u of Object.values(state.users)) (u as any).last_sign_in_at = "2026-11-25T08:00:00Z";
  });

  it("flag off: 404, no database read", async () => {
    process.env.FEED_SNAPSHOT_PROTOTYPE = "off";
    try {
      expect((await call(`${BASE}/snapshot?${GUEST}`)).status).toBe(404);
      expect(state.queries).toEqual([]);
    } finally {
      process.env.FEED_SNAPSHOT_PROTOTYPE = "on";
    }
  });

  it("parity: on a complete input (320 rows, inside the existing 1000 pool) the snapshot emits the existing route's exact order and count", async () => {
    const snap = await walk(GUEST);
    const existing: string[] = [];
    for (let p = 1; p <= 20; p++) {
      const body = await (await recommendedRoute(req(`${BASE}?${GUEST}&page=${p}&pageSize=25`))).json();
      existing.push(...body.jobs.map((j: any) => j.id));
      if (p * 25 >= body.totalCount) break;
    }
    expect(existing.length).toBeGreaterThan(100);
    expect(ids(snap)).toEqual(existing);
    expect(snap[0].totalCount).toBe(existing.length);
    expect(new Set(ids(snap)).size).toBe(ids(snap).length);
  });

  it("whole corpus: a strong match at raw position N-1 of 1,601 rows outranks every weak row and leads page 1", async () => {
    const weak = Array.from({ length: 1600 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.01));
    const strong = row(9999, "Senior Frontend Developer", 25);
    state.tables.jobs = [...weak, strong];
    const first = (await call(`${BASE}/snapshot?${GUEST}`)).body;
    expect(first.jobs[0].id).toBe(strong.id);
    expect(first.totalCount).toBeGreaterThan(1000); // no pool cap: every eligible row is in the snapshot
    expect(state.queries.filter((q) => q.table === "feed_corpus_frozen" && q.rows === 1000).length).toBeGreaterThanOrEqual(1); // paged build reads
    // The existing route's 1000-row pool never reads it.
    const existing = await (await recommendedRoute(req(`${BASE}?${GUEST}&page=1&pageSize=25`))).json();
    expect(existing.jobs.map((j: any) => j.id)).not.toContain(strong.id);
  });

  it("insert / delete / deactivate / update between page 1 and 2: zero duplicates, removed jobs omitted and consumed, page refilled, nothing resurrected", async () => {
    const all = ids(await walk(GUEST)); // stored order of an untouched snapshot (same inputs, same order)
    const p1 = (await call(`${BASE}/snapshot?${GUEST}`)).body;
    const p1Ids: string[] = ids([p1]);
    expect(p1Ids).toEqual(all.slice(0, 25));
    const [del, deact, edited] = [all[25], all[26], all[27]];
    state.tables.jobs = state.tables.jobs.filter((r: any) => r.id !== del);
    state.tables.jobs.find((r: any) => r.id === deact).is_active = false;
    state.tables.jobs.find((r: any) => r.id === edited).title = "Frontend Developer (edited)";
    const fresh = row(777, "Senior Frontend Developer", 0, { first_seen_at: new Date(Date.now() + 1000).toISOString() });
    state.tables.jobs.push(fresh);

    const p2 = (await call(`${BASE}/snapshot?${GUEST}&cursor=${p1.nextCursor}`)).body;
    const p2Ids: string[] = p2.jobs.map((j: any) => j.id);
    expect(p2Ids.filter((id) => p1Ids.includes(id))).toEqual([]); // zero duplicates
    expect(p2Ids).not.toContain(del);
    expect(p2Ids).not.toContain(deact);
    expect(p2Ids).not.toContain(fresh.id); // membership frozen at build
    expect(p2Ids).toContain(edited); // still valid: kept at its frozen rank
    expect(p2Ids).toEqual(all.slice(25, 52).filter((id) => id !== del && id !== deact)); // refilled with the next valid rows
    expect(p2.stale).toBe(true); // a newer insert exists: flagged, pages stay consistent
    const rest: string[] = [];
    let cursor = p2.hasNextPage ? p2.nextCursor : null;
    while (cursor) {
      const b = (await call(`${BASE}/snapshot?${GUEST}&cursor=${cursor}`)).body;
      rest.push(...b.jobs.map((j: any) => j.id));
      cursor = b.hasNextPage ? b.nextCursor : null;
    }
    // Every still-valid stored ID exactly once; removed ones never return.
    expect([...p1Ids, ...p2Ids, ...rest]).toEqual(all.filter((id) => id !== del && id !== deact));
    // Inside the epoch reuse window a rebuild shares the same frozen corpus (bounded copy work): the new job is NOT yet in it.
    expect(ids(await walk(GUEST))).not.toContain(fresh.id);
    // After the reuse window a new epoch is frozen and the next natural reset includes the newly ingested job.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + (FROZEN_REUSE_SECONDS + 1) * 1000));
      expect(ids(await walk(GUEST))).toContain(fresh.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidation: filter, viewer, session-epoch and tier changes reset the continuation (409)", async () => {
    const tok = "tok-free-with-answers";
    const p1 = (await call(`${BASE}/snapshot?pageSize=10`, tok)).body;
    expect(p1.hasNextPage).toBe(true);
    const next = (extra = "", t = tok) => call(`${BASE}/snapshot?pageSize=10${extra}&cursor=${p1.nextCursor}`, t);
    expect((await next()).status).toBe(200);
    expect((await next("&remoteOnly=true")).body.error).toBe("snapshot_reset"); // filter
    expect((await next("", "tok-user-no-answers")).status).toBe(409); // another Free viewer (same tier)
    (state.users[tok] as any).last_sign_in_at = "2026-11-26T10:00:00Z";
    expect((await next()).status).toBe(409); // new sign-in
    (state.users[tok] as any).last_sign_in_at = "2026-11-25T08:00:00Z";
    expect((await next()).status).toBe(200); // token refresh alone keeps it
    state.tables.subscriptions.push({ user_id: "u_free_answers", status: "active", plan_id: "monthly", current_period_end: new Date(Date.now() + 864e5).toISOString(), grace_period_end: null, created_at: new Date().toISOString() });
    expect((await next()).status).toBe(409); // tier change Free -> Pro
    expect((await call(`${BASE}/snapshot?pageSize=10&cursor=fs1.not-a-cursor.0`, tok)).status).toBe(409);
  });

  it("serve-time masking: a Free snapshot page never carries Pro fields, and Free hydration never selects them", async () => {
    const free = (await call(`${BASE}/snapshot?pageSize=25`, "tok-free-with-answers")).body;
    expect(free.isPro).toBe(false);
    expect(free.jobs.length).toBeGreaterThan(0);
    for (const j of free.jobs) {
      expect([j.company, j.applyUrl, j.description, j.salary, j.logoUrl]).toEqual(["Verified Employer", "", "", "", null]);
      expect(j.skills).toEqual([]);
      expect(j.company_id).toBeUndefined();
    }
    for (const q of state.queries) expect(q.cols).not.toMatch(/apply_url|description|logo_url/);
    const pro = (await call(`${BASE}/snapshot?pageSize=25`, "tok-pro-with-answers")).body;
    expect(pro.isPro).toBe(true);
    expect(pro.jobs[0].applyUrl).toMatch(/^https:/);
  });

  it("serve-time eligibility: a row edited to a US-only remote job after the build is NOT served to an India-saved viewer (frozen rank, live hard eligibility)", async () => {
    const tok = "tok-free-with-answers";
    state.tables.user_preferences = [{ user_id: "u_free_answers", roles: [], locations: ["India"], employment_types: [] }];
    state.tables.jobs = Array.from({ length: 12 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.01));
    const p1 = (await call(`${BASE}/snapshot?pageSize=1`, tok)).body;
    const edited = state.tables.jobs.find((j: any) => !p1.jobs.some((x: any) => x.id === j.id))!;
    Object.assign(edited, { location: "United States", country_code: "US", country: "US", remote: true, remote_scope: "country", remote_eligibility: "US" });
    const rest = ids(await (async () => {
      const pages: any[] = [];
      let cursor: string | null = p1.nextCursor;
      while (cursor) {
        const { status, body } = await call(`${BASE}/snapshot?pageSize=3&cursor=${cursor}`, tok);
        expect(status).toBe(200);
        pages.push(body);
        cursor = body.hasNextPage ? body.nextCursor : null;
      }
      return pages;
    })());
    expect(rest).not.toContain(edited.id);
    expect(new Set(rest).size).toBe(rest.length);
  });

  it("serve-time eligibility: an edit that breaks relevance is not served, and the FROZEN date window does not slide", async () => {
    // Every row is 7d - 2h old at build, inside datePosted=7d. 5h later (inside the 6h TTL) a sliding cutoff would exclude all of them.
    state.tables.jobs = Array.from({ length: 10 }, (_, k) => row(k + 1, "Frontend Developer", 7 - 2 / 24 - k * 0.001));
    const q = `${GUEST}&datePosted=7d`;
    const p1 = (await call(`${BASE}/snapshot?${q}&pageSize=2`)).body;
    expect(p1.jobs.length).toBe(2);
    const unserved = state.tables.jobs.filter((j: any) => !p1.jobs.some((x: any) => x.id === j.id));
    const [a, ...others] = unserved;
    a.title = "Warehouse Operator"; // no longer relevant to the saved role
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 5 * 3600_000));
      const pages: any[] = [];
      let cursor: string | null = p1.nextCursor;
      while (cursor) {
        const { status, body } = await call(`${BASE}/snapshot?${q}&pageSize=3&cursor=${cursor}`);
        expect(status).toBe(200);
        pages.push(body);
        cursor = body.hasNextPage ? body.nextCursor : null;
      }
      const got = ids(pages);
      expect(got).not.toContain(a.id);
      expect(got.sort()).toEqual(others.map((j: any) => j.id).sort()); // frozen window: every still-eligible row is still served
    } finally {
      vi.useRealTimers();
    }
  });

  it("response is private, no-store", async () => {
    const res = await snapshotRoute(req(`${BASE}/snapshot?${GUEST}`));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("coherent build: live edits, deactivations and inserts DURING the multi-batch build cannot change the stored membership", async () => {
    state.tables.jobs = Array.from({ length: 1500 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.001));
    const lowest = [...state.tables.jobs].sort((a: any, b: any) => (a.id < b.id ? -1 : 1))[0]; // read in the LAST batch (id desc)
    const highest = [...state.tables.jobs].sort((a: any, b: any) => (a.id < b.id ? 1 : -1))[0]; // read in the FIRST batch
    let reads = 0;
    state.afterFrozenRead = () => {
      if (++reads !== 1) return;
      lowest.is_active = false; lowest.title = "Warehouse Operator"; // unread row leaves the live filter
      highest.posted_at = "2001-01-01T00:00:00.000Z"; // read row moves behind any boundary
      state.tables.jobs.push(row(9001, "Frontend Developer", 0.5)); // an insert
    };
    const p1 = (await call(`${BASE}/snapshot?${GUEST}&pageSize=1`)).body;
    expect(reads).toBeGreaterThan(1); // really a multi-batch build
    state.afterFrozenRead = null;
    const { prototypeMemoryStore } = await import("@/lib/jobs/feedSnapshot");
    const stored = (await (prototypeMemoryStore as any).get(p1.nextCursor.split(".")[1]))!.jobIds as string[];
    expect(new Set(stored).size).toBe(stored.length); // no duplicate
    expect(stored).toContain(lowest.id); // frozen membership: not skipped, not dropped by the mid-build edit
    expect(stored).toContain(highest.id);
    expect(stored).not.toContain(row(9001, "x", 1).id); // the mid-build insert is not in this build
    expect(stored.length).toBe(1500);
    // Serve time still re-checks hard eligibility: the deactivated/irrelevant row is not served.
    const served = ids(await walk(GUEST, undefined, 100));
    expect(served).not.toContain(lowest.id);
  }, 60000);

  it("fails closed, never a weaker build: missing function, purged epoch, no service key, over-bound corpus", async () => {
    state.tables.jobs = Array.from({ length: 30 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.01));
    state.rpcFail = { message: "Could not find the function public.freeze_feed_corpus", code: "PGRST202" };
    let r = await call(`${BASE}/snapshot?${GUEST}`);
    expect([r.status, r.body.error, r.body.jobs]).toEqual([503, "snapshot_unavailable", []]);
    state.rpcFail = { message: "snapshot_too_large", code: "54000" };
    r = await call(`${BASE}/snapshot?${GUEST}`);
    expect([r.status, r.body.error]).toEqual([503, "snapshot_too_large"]);
    state.rpcFail = null;
    state.afterFrozenRead = () => { state.tables.feed_corpus_epochs = []; }; // the epoch is purged while the build reads it
    r = await call(`${BASE}/snapshot?${GUEST}`);
    expect([r.status, r.body.error]).toEqual([503, "snapshot_unavailable"]);
    state.afterFrozenRead = null;
    state.tables.feed_corpus_epochs = [];
    state.queries = [];
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      r = await call(`${BASE}/snapshot?${GUEST}`);
      expect(r.status).toBe(503); // refused (the shared request setup itself fails without the service key); never a live read
      expect(r.body.jobs).toEqual([]);
      expect(state.queries.filter((q) => q.table === "feed_corpus_frozen")).toEqual([]);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });

  it("epoch metadata and best-effort stale mark: a job inserted AFTER the epoch capture but BEFORE this viewer's build reads stale=true, and capturedAt is reported separately from rankedAt", async () => {
    state.tables.jobs = Array.from({ length: 12 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.01));
    const first = (await call(`${BASE}/snapshot?${GUEST}&pageSize=3`)).body;
    expect(first.stale).toBe(false);
    // The DB clock and the app clock are different reads: assert order and a loose bound, never equality.
    expect(Date.parse(first.corpusCapturedAt)).not.toBeNaN();
    expect(Math.abs(Date.parse(first.snapshotBuiltAt) - Date.parse(first.corpusCapturedAt))).toBeLessThan(5_000);
    state.tables.jobs.push(row(9100, "Frontend Developer", 0.0001, { first_seen_at: new Date(Date.now() + 1000).toISOString() }));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 10_000)); // inside the reuse window: the epoch is reused, the insert is not in it
      const second = (await call(`${BASE}/snapshot?${GUEST}&pageSize=3`)).body;
      expect(second.stale).toBe(true); // truthful: newer jobs exist than the epoch holds
      expect(second.corpusCapturedAt).toBe(first.corpusCapturedAt); // epoch reused
      expect(second.snapshotBuiltAt).not.toBe(second.corpusCapturedAt); // ranked later than captured
      const { prototypeMemoryStore } = await import("@/lib/jobs/feedSnapshot");
      const st = (await (prototypeMemoryStore as any).get(second.nextCursor.split(".")[1]))!;
      expect([typeof st.epochId, st.frozenAt, st.corpusMark === null]).toEqual(["string", first.corpusCapturedAt, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admission: distinct builds beyond the in-flight bound are refused with a typed retryable 503 and the slots are released afterwards", async () => {
    state.tables.jobs = Array.from({ length: 30 }, (_, k) => row(k + 1, "Frontend Developer", 1 + k * 0.01));
    const { MAX_INFLIGHT_BUILDS } = await import("@/lib/jobs/feedSnapshot");
    const urls = Array.from({ length: MAX_INFLIGHT_BUILDS + 2 }, (_, k) => `${BASE}/snapshot?roles=Frontend%20Developer&experienceLevel=senior&q=distinct${k}`);
    let open: () => void = () => {};
    state.rpcGate = new Promise<void>((r) => { open = r; });
    const pending = urls.map((u) => snapshotRoute(req(u)).then(async (r) => ({ status: r.status, body: await r.json(), retry: r.headers.get("retry-after") })));
    await new Promise((r) => setTimeout(r, 50)); // all requests are now either holding a slot at the freeze or refused
    open();
    const results = await Promise.all(pending);
    const busy = results.filter((r) => r.body.error === "snapshot_busy");
    expect(busy.length).toBeGreaterThan(0);
    for (const b of busy) expect([b.status, b.retry]).toEqual([503, "5"]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    const after = await call(`${BASE}/snapshot?${GUEST}`); // slots released in finally
    expect(after.status).toBe(200);
  });

  it("TTL: an expired snapshot resets its cursor and the next build deletes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));
      const p1 = (await call(`${BASE}/snapshot?${GUEST}`)).body;
      expect(store.size()).toBe(1);
      vi.setSystemTime(new Date("2026-11-26T06:00:01Z"));
      expect((await call(`${BASE}/snapshot?${GUEST}&cursor=${p1.nextCursor}`)).status).toBe(409);
      await call(`${BASE}/snapshot?${GUEST}`);
      expect(store.size()).toBe(1); // the expired one was cleaned up, only the new one is stored
    } finally {
      vi.useRealTimers();
    }
  });
});
