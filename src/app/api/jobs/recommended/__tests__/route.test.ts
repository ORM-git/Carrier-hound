import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const predicates: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; ascending: boolean; nullsFirst?: boolean }> = [];
    let rangeBounds: [number, number] | null = null;
    let limitCount: number | null = null;

    const run = () => {
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
            return async () => ({ data: run().data[0] ?? null, error: null });
          }
          if (prop === "select") {
            return () => b;
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

// Walks the ranked stream the way the client does: follow nextCursor and echo
// poolAnchor/poolFloor verbatim on every subsequent request. Returns the response bodies.
const walkStream = async (token: string, pages: number, pageSize = 25) => {
  let cursor: string | null = null;
  let anchor: string | null = null;
  let floor: string | null = null;
  const bodies: any[] = [];
  for (let p = 0; p < pages; p++) {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (cursor) params.set("cursor", cursor);
    if (anchor) params.set("poolAnchor", anchor);
    if (floor) params.set("poolFloor", floor);
    const res = await recommendedRoute(req(`http://localhost/api/jobs/recommended?${params.toString()}`, token));
    expect(res.status).toBe(200);
    const body = await res.json();
    bodies.push(body);
    anchor = anchor ?? body.poolAnchor ?? null;
    floor = floor ?? body.poolFloor ?? null;
    cursor = body.nextCursor;
  }
  return bodies;
};

// Follows a stream's own cursors (echoing its bounds) until hasNextPage is false or the
// turn budget is hit. Returns every body after the ones supplied.
const walkToEnd = async (token: string, seedBodies: any[], budget = 200) => {
  const bodies = [...seedBodies];
  let anchor = bodies.map((b) => b.poolAnchor).find((a) => a) ?? null;
  let floor = bodies.map((b) => b.poolFloor).find((f) => f) ?? null;
  let cursor: string | null = bodies[bodies.length - 1].nextCursor;
  let turns = 0;
  while (cursor && turns++ < budget) {
    const params = new URLSearchParams({ pageSize: "25", cursor });
    if (anchor) params.set("poolAnchor", anchor);
    if (floor) params.set("poolFloor", floor);
    const body = await (await recommendedRoute(req(`http://localhost/api/jobs/recommended?${params.toString()}`, token))).json();
    bodies.push(body);
    anchor = anchor ?? body.poolAnchor ?? null;
    floor = floor ?? body.poolFloor ?? null;
    cursor = body.nextCursor;
  }
  return bodies;
};

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

    it("Page 11 (reached by cursor walk) is NOT empty: 25 distinct items with stable pagination", async () => {
      const bodies = await walkStream("tok-free-with-answers", 11);
      const body1 = bodies[0];
      const body11 = bodies[10];

      expect(body11.jobs.length).toBe(25);
      expect(body11.totalCount).toBe(body1.totalCount);

      // Every page in the walk is completely distinct from every earlier page.
      const seen = new Set<string>();
      for (const body of bodies) {
        for (const job of body.jobs) {
          expect(seen.has(job.id)).toBe(false);
          seen.add(job.id);
        }
      }
      expect(seen.size).toBe(275);

      // Stable pagination: re-issuing the 11th request with the same cursor + anchor
      // returns the identical slice.
      const params = new URLSearchParams({ pageSize: "25" });
      let cursor: string | null = null;
      let anchor: string | null = null;
      for (let p = 0; p < 10; p++) {
        const q = new URLSearchParams({ pageSize: "25" });
        if (cursor) q.set("cursor", cursor);
        if (anchor) q.set("poolAnchor", anchor);
        const b = await (await recommendedRoute(req(`http://localhost/api/jobs/recommended?${q.toString()}`, "tok-free-with-answers"))).json();
        anchor = anchor ?? b.poolAnchor ?? null;
        cursor = b.nextCursor;
      }
      params.set("cursor", cursor!);
      params.set("poolAnchor", anchor!);
      const refetch = await (await recommendedRoute(req(`http://localhost/api/jobs/recommended?${params.toString()}`, "tok-free-with-answers"))).json();
      expect(refetch.jobs.map((j: any) => j.id)).toEqual(body11.jobs.map((j: any) => j.id));
    });

    it("User without answers falls back to latest jobs: cursor walk over the corpus stays complete and distinct", async () => {
      const bodies = await walkStream("tok-user-no-answers", 11);
      const seen = new Set<string>();
      for (const body of bodies) {
        expect(body.personalized).toBe(false);
        expect(body.jobs.length).toBe(25);
        expect(body.totalCount).toBe(320);
        for (const job of body.jobs) {
          expect(seen.has(job.id)).toBe(false);
          seen.add(job.id);
        }
      }
      expect(seen.size).toBe(275);
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
      const bodies = await walkStream("tok-free-with-answers", 11);
      for (const body of [bodies[0], bodies[10]]) {
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
      const bodies = await walkStream("tok-pro-with-answers", 11);
      for (const body of [bodies[0], bodies[10]]) {
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

      // Page 11 through getLiveJobs: follow the stream's own cursors, echoing poolAnchor.
      expect(typeof res.poolAnchor).toBe("string");
      let cursor: string | null = res.nextCursor ?? null;
      const anchor = res.poolAnchor ?? null;
      const seen = new Set(res.jobs.map((j: any) => j.id));
      let resPage11: any = null;
      for (let p = 2; p <= 11; p++) {
        expect(cursor).not.toBeNull();
        resPage11 = await getLiveJobs({
          baseUrl: "http://localhost",
          sortBy: "match",
          page: p,
          pageSize: 25,
          candidate: null,
          preferences: freePrefs,
          cursor,
          poolAnchor: anchor,
        });
        for (const job of resPage11.jobs) {
          expect(seen.has(job.id)).toBe(false);
          seen.add(job.id);
        }
        cursor = resPage11.nextCursor;
      }

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

describe("beyond-pool continuation (scroll until the domain is exhausted)", () => {
  const seed = (count: number) => {
    const corpus = generateTestCorpus(count);
    state.tables.jobs = corpus;
    state.tables.jobs_public = corpus;
  };
  // Baseline stream order: posted_at desc (nulls last), id desc - the same order the
  // route's pool and continuation queries use.
  const streamOrder = (rows: any[]) =>
    [...rows].sort((a, b) => {
      const pa = a.posted_at ?? "";
      const pb = b.posted_at ?? "";
      return pb.localeCompare(pa) || String(b.id).localeCompare(String(a.id));
    });
  const keyOf = (row: any) => `k:${row.posted_at ?? "null"}|${row.id}`;

  it("the pool's final page serves its rows and hands out the terminal sweep cursor", async () => {
    seed(1400);
    const bodies = await walkStream("tok-user-no-answers", 40);
    const seen = new Set<string>();
    for (const body of bodies) {
      expect(body.continuation).toBe(false); // pool pages are not continuation chunks
      expect(body.jobs.length).toBe(25);
      for (const j of body.jobs) {
        expect(seen.has(j.id)).toBe(false);
        seen.add(j.id);
      }
    }
    expect(seen.size).toBe(1000);
    const page40 = bodies[39];
    expect(page40.totalCount).toBe(1000); // bounded pool total, honestly reported
    expect(page40.hasNextPage).toBe(true);
    expect(page40.nextCursor).toBe("s:top"); // ranked window exhausted: terminal completeness sweep
    expect(page40.totalIsLowerBound).toBe(true);
    // The frozen window bounds: computed on the first response, echoed verbatim after.
    expect(bodies[0].poolAnchor.startsWith("k:")).toBe(true);
    expect(bodies[0].poolFloor.startsWith("k:")).toBe(true);
    for (const body of bodies.slice(1)) {
      expect(body.poolAnchor).toBe(bodies[0].poolAnchor);
      expect(body.poolFloor).toBe(bodies[0].poolFloor);
    }
    // Mid-pool pages hand out ranked pool cursors ("p:"): value-based positions in the ranked pool.
    expect(bodies[0].nextCursor.startsWith("p:")).toBe(true);
    expect(bodies[19].nextCursor.startsWith("p:")).toBe(true);
    expect(bodies[19].totalIsLowerBound).toBe(true); // pool came back full: 1000 is a lower bound
  });

  it("pool slices follow the ranked order: each cursor serves the next 25 ranked rows", async () => {
    seed(1400);
    const ordered = streamOrder(state.tables.jobs).slice(0, 1000); // no-answers: score ties -> time desc, id desc
    const bodies = await walkStream("tok-user-no-answers", 40);
    const served = bodies.flatMap((b) => b.jobs.map((j: any) => j.id));
    expect(served).toEqual(ordered.map((r) => r.id));
  });

  it("the stream continues past the pool: sweep re-covers the window, then raw chunks run to exhaustion", async () => {
    seed(1400);
    const ranked = await walkStream("tok-user-no-answers", 40);
    const poolIds = new Set<string>();
    for (const body of ranked) for (const j of body.jobs) poolIds.add(j.id);
    expect(poolIds.size).toBe(1000);

    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const phases = bodies.slice(40);
    expect(phases.length).toBeGreaterThan(40); // ~40 sweep chunks + 16 beyond-floor chunks
    for (const body of phases) {
      expect(body.continuation).toBe(true);
      expect(body.totalIsLowerBound).toBe(true);
      expect(body.totalCount).toBe(0); // chunk counts are never presented as a domain-wide total
      expect(body.hasNextPage).toBe(body.nextCursor !== null);
    }
    const sweepChunks = phases.filter((b) => b.poolFloor !== null);
    const beyondChunks = phases.filter((b) => b.poolFloor === null);
    expect(sweepChunks.length).toBeGreaterThan(0);
    expect(beyondChunks.length).toBeGreaterThanOrEqual(16); // 400 beyond-pool rows / 25 per chunk
    // The sweep re-covers ONLY frozen-window rows (the client's id-dedupe swallows them);
    // window bounds stay echoed on every sweep chunk.
    for (const body of sweepChunks) {
      expect(body.poolAnchor).toBe(ranked[0].poolAnchor);
      expect(body.poolFloor).toBe(ranked[0].poolFloor);
      for (const j of body.jobs) expect(poolIds.has(j.id)).toBe(true);
    }
    // Beyond-floor chunks carry no bounds and serve only rows the pool never contained.
    const seen = new Set<string>(poolIds);
    for (const body of beyondChunks) {
      expect(body.poolAnchor).toBeNull();
      for (const j of body.jobs) {
        expect(seen.has(j.id)).toBe(false); // zero duplicates across the beyond boundary
        seen.add(j.id);
      }
    }
    expect(seen.size).toBe(1400); // the full corpus was served: the stream ends only at genuine exhaustion
    expect(bodies[bodies.length - 1].hasNextPage).toBe(false);
  });

  it("a keyset cursor at the corpus end returns an empty terminal page", async () => {
    seed(1025);
    const bodies = await walkToEnd("tok-user-no-answers", await walkStream("tok-user-no-answers", 40));
    const beyondChunks = bodies.filter((b) => b.continuation === true && b.poolFloor === null);
    expect(beyondChunks.length).toBe(1);
    const chunk = beyondChunks[0];
    expect(chunk.jobs.length).toBe(25); // rows 1000-1024
    expect(chunk.hasNextPage).toBe(false); // scan reached the end: genuinely exhausted
    expect(chunk.nextCursor).toBeNull();

    const ordered = streamOrder(state.tables.jobs);
    const end = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(keyOf(ordered[1024]))}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(end.jobs.length).toBe(0);
    expect(end.hasNextPage).toBe(false);
    expect(end.nextCursor).toBeNull();
    expect(end.continuation).toBe(true);
  });

  it("non-keyset or malformed cursors are ignored and the normal pool page is served", async () => {
    seed(1400);
    for (const bad of ["50", "k:garbage", "k:|", "k:no-separator", "p:garbage", "p:1|2", "p:||"]) {
      const body = await (await recommendedRoute(
        req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(bad)}&page=1&pageSize=25`, "tok-user-no-answers")
      )).json();
      expect(body.jobs.length).toBe(25);
      expect(body.totalCount).toBe(1000);
      expect(body.continuation).toBe(false);
    }
  });

  it("a corpus that fits inside the pool ends after ranked pages plus one completeness sweep", async () => {
    seed(320);
    const ranked = await walkStream("tok-user-no-answers", 13);
    const seen = new Set<string>();
    for (const body of ranked.slice(0, 12)) {
      expect(body.jobs.length).toBe(25);
      expect(body.hasNextPage).toBe(true);
      for (const j of body.jobs) seen.add(j.id);
    }
    const last = ranked[12];
    expect(last.jobs.length).toBe(20); // 320 rows = 12 full pages + 20
    expect(last.hasNextPage).toBe(true);
    expect(last.nextCursor).toBe("s:top"); // the terminal sweep follows the final ranked slice
    expect(last.totalIsLowerBound).toBe(false); // pool not full: 320 is the verified total
    expect(last.poolFloor).toBeNull(); // no beyond-pool region exists for this stream
    for (const j of last.jobs) {
      expect(seen.has(j.id)).toBe(false);
      seen.add(j.id);
    }
    expect(seen.size).toBe(320); // the whole corpus was served exactly once in ranked order

    // The sweep re-covers the same 320 rows (client dedupes) and then the stream ends
    // for real: no floor, no beyond-pool continuation.
    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const sweepChunks = bodies.slice(13);
    expect(sweepChunks.length).toBeGreaterThanOrEqual(13);
    for (const body of sweepChunks) {
      expect(body.continuation).toBe(true);
      for (const j of body.jobs) expect(seen.has(j.id)).toBe(true); // only re-served window rows
    }
    expect(bodies[bodies.length - 1].hasNextPage).toBe(false);
    expect(bodies[bodies.length - 1].nextCursor).toBeNull();
  });

  it("deleting a previously seen row between requests does not shift or skip pool rows (reviewer reproduction)", async () => {
    // Regression: numeric-offset pool pages shifted on deletion, so re-fetching page 2
    // after deleting one page-1 row skipped an unseen row (reviewer reproduction on the
    // 1400-row corpus). Value-based pool cursors are immune: the ranked keyset names a
    // value position, not a row count.
    seed(1400);
    const bodies = await walkStream("tok-user-no-answers", 2);
    const [page1, baselinePage2] = bodies;
    const params = new URLSearchParams({ pageSize: "25" });
    params.set("cursor", page1.nextCursor);
    params.set("poolAnchor", page1.poolAnchor);

    const deleted = page1.jobs[0].id;
    state.tables.jobs = state.tables.jobs.filter((r: any) => r.id !== deleted);
    state.tables.jobs_public = state.tables.jobs;

    const refetch = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?${params.toString()}`, "tok-user-no-answers")
    )).json();
    expect(refetch.jobs.map((j: any) => j.id)).toEqual(baselinePage2.jobs.map((j: any) => j.id));
    expect(refetch.jobs.some((j: any) => j.id === deleted)).toBe(false);
  });

  it("deleting a previously seen row between requests does not skip any unseen row (reviewer reproduction)", async () => {
    // Regression: numeric-offset cursors skipped ordered[1025] here (reviewer reproduction).
    // With the frozen window the stream must still serve every surviving row exactly once
    // in the ranked and beyond-floor phases.
    seed(1400);
    const ordered = streamOrder(state.tables.jobs);
    const ranked = await walkStream("tok-user-no-answers", 40);
    const deleted = ranked[10].jobs[0].id;
    state.tables.jobs = state.tables.jobs.filter((r: any) => r.id !== deleted);
    state.tables.jobs_public = state.tables.jobs;
    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const served = new Set<string>();
    for (const body of bodies) for (const j of body.jobs) served.add(j.id);
    expect(served.has(ordered[1025].id)).toBe(true); // the previously skipped row arrives
    const missing = state.tables.jobs.filter((r: any) => !served.has(r.id));
    expect(missing).toEqual([]); // every surviving row served by exhaustion
    expect(served.has(deleted)).toBe(true); // served before deletion, never after
    for (const body of bodies.slice(ranked.length + 1)) {
      expect(body.jobs.some((j: any) => j.id === deleted)).toBe(false);
    }
  });

  it("inserted newer rows between requests never shift, repeat or displace the anchored pool stream", async () => {
    seed(1400);
    const bodies = await walkStream("tok-user-no-answers", 2);
    const [page1, baselinePage2] = bodies;
    const inserted = {
      ...generateTestCorpus(1)[0],
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      posted_at: new Date(Date.now() + 864e5).toISOString(), // newest row in the corpus
    };
    state.tables.jobs = [...state.tables.jobs, inserted];
    state.tables.jobs_public = state.tables.jobs;

    // With the echoed window bounds the pool is pinned: the same request returns the same
    // slice, and the insert can neither shift page 2 nor displace unseen pool-tail rows.
    const fetchNext = async (cursor: string) => {
      const params = new URLSearchParams({ pageSize: "25" });
      params.set("cursor", cursor);
      params.set("poolAnchor", page1.poolAnchor);
      params.set("poolFloor", page1.poolFloor);
      return (await recommendedRoute(
        req(`http://localhost/api/jobs/recommended?${params.toString()}`, "tok-user-no-answers")
      )).json();
    };
    const after = await fetchNext(page1.nextCursor);
    expect(after.jobs.map((j: any) => j.id)).toEqual(baselinePage2.jobs.map((j: any) => j.id));
    expect(after.jobs.some((j: any) => j.id === inserted.id)).toBe(false);

    // The bounds also pin the pool tail: the 40th page still ends on the same row, then
    // hands out the terminal sweep cursor; the beyond-floor region starts at the frozen floor.
    let cursor: string | null = page1.nextCursor;
    let last: any = null;
    for (let p = 2; p <= 40; p++) {
      last = await fetchNext(cursor!);
      cursor = last.nextCursor;
    }
    expect(last.jobs.some((j: any) => j.id === inserted.id)).toBe(false);
    expect(last.nextCursor).toBe("s:top");

    // The terminal sweep is not bounded above by the anchor: the inserted row surfaces
    // there exactly once, and the beyond-floor phase then serves the raw tail.
    const seen = new Set<string>(
      (await walkStream("tok-user-no-answers", 40)).flatMap((b: any) => b.jobs.map((j: any) => j.id))
    );
    let occurrences = 0;
    cursor = "s:top";
    let beyond = 0;
    while (cursor !== null) {
      const body = await fetchNext(cursor);
      occurrences += body.jobs.filter((j: any) => j.id === inserted.id).length;
      if (body.poolFloor === null) {
        beyond += 1;
        for (const j of body.jobs) {
          expect(seen.has(j.id)).toBe(false);
          seen.add(j.id);
        }
      }
      cursor = body.nextCursor;
    }
    expect(occurrences).toBe(1);
    expect(beyond).toBeGreaterThanOrEqual(16); // the 400 beyond-pool rows still stream to exhaustion
    expect(seen.size).toBe(1400);

    // A fresh load (no bounds) is a new stream: the inserted row surfaces at the top.
    const fresh = await (await recommendedRoute(
      req("http://localhost/api/jobs/recommended?pageSize=25", "tok-user-no-answers")
    )).json();
    expect(fresh.jobs[0].id).toBe(inserted.id);
  });

  it("heavily filtered regions never produce an empty non-terminal page (reviewer reproduction)", async () => {
    // 1200 on-role jobs: the first 1100 are US-restricted remote (ineligible for an
    // India-preference account), the last 100 are eligible India onsite.
    const base = generateTestCorpus(1)[0];
    state.tables.user_preferences.find((x: any) => x.user_id === "u_pro_answers").locations = ["India"];
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      ...base,
      id: `adv-${String(i).padStart(5, "0")}`,
      company_id: `c-${i}`,
      posted_at: new Date(Date.UTC(2026, 10, 24) - i * 60000).toISOString(),
      location: i >= 1100 ? "Bengaluru, India" : "Remote, United States",
      country_code: i >= 1100 ? "IN" : "US",
      remote: i < 1100,
      remote_scope: i < 1100 ? "remote" : "onsite",
      remote_eligibility: i < 1100 ? "country_restricted" : null,
    }));
    state.tables.jobs = rows;
    state.tables.jobs_public = rows;
    const ordered = streamOrder(rows);
    // Start strictly after raw row 999: the old code returned jobs=0 + hasNextPage=true here.
    const body = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(keyOf(ordered[999]))}&pageSize=25`, "tok-pro-with-answers")
    )).json();
    expect(body.jobs.length).toBe(25); // the eligible slice at 1100-1124 served in the same response
    expect(body.hasNextPage).toBe(true); // 75 eligible rows remain beyond it
    expect(body.nextCursor).not.toBeNull();

    // Walking the cursor serves every remaining eligible row and then ends for real.
    const seen = new Set<string>(body.jobs.map((j: any) => j.id));
    let cursor: string | null = body.nextCursor;
    while (cursor !== null) {
      const next = await (await recommendedRoute(
        req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(cursor)}&pageSize=25`, "tok-pro-with-answers")
      )).json();
      for (const j of next.jobs) {
        expect(seen.has(j.id)).toBe(false);
        seen.add(j.id);
      }
      expect(next.hasNextPage).toBe(next.nextCursor !== null);
      cursor = next.nextCursor;
    }
    expect(seen.size).toBe(100); // every eligible job served, nothing filtered out mid-stream lost
  });

  it("identical posted_at ties across a chunk boundary neither repeat nor skip rows", async () => {
    const base = generateTestCorpus(1)[0];
    const tied = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      id: `tie-${String(i).padStart(3, "0")}`,
      company_id: `tie-co-${i}`,
      posted_at: "2026-11-01T00:00:00.000Z", // all 30 rows share one timestamp
    }));
    state.tables.jobs = tied;
    state.tables.jobs_public = tied;
    const ordered = streamOrder(tied); // ties broken by id desc
    const first = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(keyOf(ordered[0]))}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(first.jobs.length).toBe(25); // ordered[1..25]
    const second = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(first.nextCursor ?? "")}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(second.jobs.length).toBe(4); // ordered[26..29]: the id tie-break carries the boundary
    const all = [...first.jobs, ...second.jobs].map((j: any) => j.id);
    expect(new Set(all).size).toBe(29);
    expect(all.sort()).toEqual(ordered.slice(1).map((r) => r.id).sort());
  });

  it("null posted_at rows sort last, are served exactly once, and keyset cursors handle the null key", async () => {
    const base = generateTestCorpus(1)[0];
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({
        ...base,
        id: `dated-${String(i).padStart(3, "0")}`,
        company_id: `dated-co-${i}`,
        posted_at: new Date(Date.UTC(2026, 9, 1) - i * 60000).toISOString(),
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        ...base,
        id: `undated-${String(i).padStart(3, "0")}`,
        company_id: `undated-co-${i}`,
        posted_at: null,
      })),
    ];
    state.tables.jobs = rows;
    state.tables.jobs_public = rows;
    const ordered = streamOrder(rows);
    expect(ordered.slice(30).map((r) => r.id)).toEqual(["undated-002", "undated-001", "undated-000"]); // nulls last, id desc
    // Cursor strictly after the last dated row: the null-posted rows arrive next, in order.
    const first = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(keyOf(ordered[29]))}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(first.jobs.map((j: any) => j.id).sort()).toEqual(["undated-000", "undated-001", "undated-002"]);
    expect(first.hasNextPage).toBe(false); // genuinely exhausted after them
    // A null-key cursor strictly after the first null row serves the remaining null rows only.
    const second = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent("k:null|undated-002")}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(second.jobs.map((j: any) => j.id).sort()).toEqual(["undated-000", "undated-001"]);
  });

  it("a slice full of one employer serves the whole slice (diversity is reorder-only, never a drop)", async () => {
    const base = generateTestCorpus(1)[0];
    const newest = Date.now();
    // 30 rows from one employer at the top of the stream, then 40 older distinct-employer rows.
    const sameCo = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      id: `mass-${String(i).padStart(3, "0")}`,
      company_id: "co_mass",
      posted_at: new Date(newest - i * 60000).toISOString(),
      created_at: new Date(newest - i * 60000).toISOString(),
    }));
    const others = Array.from({ length: 40 }, (_, i) => ({
      ...base,
      id: `other-${String(i).padStart(3, "0")}`,
      company_id: `co_other_${i}`,
      posted_at: new Date(newest - 864e5 - i * 60000).toISOString(),
      created_at: new Date(newest - 864e5 - i * 60000).toISOString(),
    }));
    state.tables.jobs = [...sameCo, ...others];
    state.tables.jobs_public = state.tables.jobs;

    const bodies = await walkStream("tok-user-no-answers", 3);
    const served = bodies.flatMap((b) => b.jobs.map((j: any) => j.id));
    // Page 1 is 25 rows all from co_mass: NOT a hard cap, so nothing is dropped or
    // replaced by lower-ranked employers. (Free user: group by the opaque companyGroupId.)
    expect(bodies[0].jobs.length).toBe(25);
    expect(new Set(bodies[0].jobs.map((j: any) => j.companyGroupId)).size).toBe(1);
    // Every mass-employer row is served across the boundary: completeness is preserved.
    const massServed = served.filter((id) => id.startsWith("mass-"));
    expect(new Set(massServed).size).toBe(30);
    expect(new Set(served).size).toBe(served.length); // zero repeats across the boundary
  });

  it("ranked-pool score/time ties across a page boundary neither repeat nor skip rows", async () => {
    const base = generateTestCorpus(1)[0];
    // 60 rows with identical posted_at: the no-answers ranking ties on score and time,
    // so the id tie-break must carry the p: cursor boundary exactly.
    const tied = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: `ptie-${String(i).padStart(3, "0")}`,
      company_id: `ptie-co-${i}`,
      posted_at: "2026-11-01T00:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
    }));
    state.tables.jobs = tied;
    state.tables.jobs_public = tied;
    const bodies = await walkStream("tok-user-no-answers", 3);
    const served = bodies.flatMap((b) => b.jobs.map((j: any) => j.id));
    expect(bodies[0].jobs.length).toBe(25);
    expect(bodies[1].jobs.length).toBe(25);
    expect(bodies[2].jobs.length).toBe(10);
    expect(bodies[2].hasNextPage).toBe(true);
    expect(bodies[2].nextCursor).toBe("s:top"); // ranked slices done: terminal completeness sweep
    expect(new Set(served).size).toBe(60);
    expect(served.sort()).toEqual(tied.map((r) => r.id).sort());

    // The sweep re-serves the same 60 tied rows (the client dedupes) and the stream then
    // ends for real: no floor, no beyond-pool region.
    const full = await walkToEnd("tok-user-no-answers", bodies);
    for (const body of full.slice(3)) {
      expect(body.continuation).toBe(true);
      for (const j of body.jobs) expect(served.includes(j.id)).toBe(true);
    }
    expect(full[full.length - 1].hasNextPage).toBe(false);
    expect(full[full.length - 1].nextCursor).toBeNull();
  });

  it("poolAnchor is echoed consistently across pool pages and is null on continuation chunks", async () => {
    seed(1400);
    const first = await (await recommendedRoute(
      req("http://localhost/api/jobs/recommended?pageSize=25", "tok-user-no-answers")
    )).json();
    expect(typeof first.poolAnchor).toBe("string");
    expect(first.poolAnchor.startsWith("k:")).toBe(true); // raw-key upper bound of the pool head

    const params = new URLSearchParams({ pageSize: "25" });
    params.set("cursor", first.nextCursor);
    params.set("poolAnchor", first.poolAnchor);
    const second = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?${params.toString()}`, "tok-user-no-answers")
    )).json();
    // The anchor is a property of the stream, not the request count: it never drifts.
    expect(second.poolAnchor).toBe(first.poolAnchor);

    const bodies = await walkStream("tok-user-no-answers", 40);
    const chunk = await (await recommendedRoute(
      req(`http://localhost/api/jobs/recommended?cursor=${encodeURIComponent(bodies[39].nextCursor)}&pageSize=25`, "tok-user-no-answers")
    )).json();
    expect(chunk.continuation).toBe(true);
    expect(chunk.poolAnchor).toBeNull(); // beyond-pool chunks are raw keyset scans; no anchor applies
  });
});

describe("frozen-window terminal sweep (v4 stream stability)", () => {
  const seed = (count: number) => {
    const corpus = generateTestCorpus(count);
    state.tables.jobs = corpus;
    state.tables.jobs_public = corpus;
  };
  const streamOrder = (rows: any[]) =>
    [...rows].sort((a, b) => {
      const pa = a.posted_at ?? "";
      const pb = b.posted_at ?? "";
      return pb.localeCompare(pa) || String(b.id).localeCompare(String(a.id));
    });

  it("reviewer promotion reproduction inverted: deleting a seen row mid-stream omits nothing", async () => {
    // The reviewer's v3 reproduction: 1050 rows, a seen row deleted after page 1, and the
    // row that deletion promoted into the ranked pool (inv-1049) went permanently missing.
    // Under the frozen window every surviving row must still be served exactly once.
    const base = generateTestCorpus(1)[0];
    const rows = Array.from({ length: 1050 }, (_, i) => ({
      ...base,
      id: `inv-${String(i).padStart(4, "0")}`,
      company_id: `inv-co-${i}`,
      posted_at: i < 1000 ? new Date(Date.UTC(2026, 10, 24) - i * 60000).toISOString() : null,
      created_at: i < 1000 ? "2026-11-01T00:00:00.000Z" : "2026-12-01T00:00:00.000Z",
    }));
    state.tables.jobs = rows;
    state.tables.jobs_public = rows;
    const first = await (await recommendedRoute(
      req("http://localhost/api/jobs/recommended?pageSize=25", "tok-user-no-answers")
    )).json();
    expect(first.jobs.length).toBe(25);
    const deletedId = first.jobs[3].id;
    state.tables.jobs = state.tables.jobs.filter((r: any) => r.id !== deletedId);
    state.tables.jobs_public = state.tables.jobs;

    const bodies = await walkToEnd("tok-user-no-answers", [first]);
    const served = new Set<string>();
    for (const body of bodies) for (const j of body.jobs) served.add(j.id);
    const missing = state.tables.jobs.filter((r: any) => !served.has(r.id));
    expect(missing).toEqual([]); // nothing lost: the exact failure the reviewer reproduced
    expect(served.has("inv-1049")).toBe(true); // the promotion row itself arrives
    expect(served.has(deletedId)).toBe(true); // served before deletion, never after
    expect(served.size).toBe(1050); // 1049 survivors plus the row served pre-deletion
    expect(bodies[bodies.length - 1].hasNextPage).toBe(false);
  });

  it("a row whose raw key rewrites above the anchor mid-stream is caught by the terminal sweep", async () => {
    seed(1400);
    const ranked = await walkStream("tok-user-no-answers", 2);
    const seen = new Set<string>(ranked.flatMap((b: any) => b.jobs.map((j: any) => j.id)));
    const ordered = streamOrder(state.tables.jobs);
    const target = ordered[500]; // unseen window row
    expect(seen.has(target.id)).toBe(false);
    state.tables.jobs = state.tables.jobs.map((r: any) =>
      r.id === target.id ? { ...r, posted_at: "2026-12-25T00:00:00.000Z" } : r
    );
    state.tables.jobs_public = state.tables.jobs;

    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const occurrences = bodies.reduce(
      (n: number, b: any) => n + b.jobs.filter((j: any) => j.id === target.id).length,
      0
    );
    expect(occurrences).toBe(1); // omitted from ranked paging, healed exactly once by the sweep
    const sweepServed = bodies.some(
      (b: any) => b.poolFloor !== null && b.continuation === true && b.jobs.some((j: any) => j.id === target.id)
    );
    expect(sweepServed).toBe(true);
  });

  it("a backdated insert inside the frozen window is served without displacing any original row", async () => {
    seed(1400);
    const ranked = await walkStream("tok-user-no-answers", 40);
    const ordered = streamOrder(state.tables.jobs);
    const inserted = {
      ...generateTestCorpus(1)[0],
      id: "backdated-0000-4000-8000-000000000001",
      company_id: "backdated-co",
      posted_at: new Date(
        (Date.parse(ordered[499].posted_at) + Date.parse(ordered[500].posted_at)) / 2
      ).toISOString(), // lands mid-window in the no-answers time ranking
      created_at: "2026-12-20T00:00:00.000Z",
    };
    state.tables.jobs = [...state.tables.jobs, inserted];
    state.tables.jobs_public = state.tables.jobs;

    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const counts = new Map<string, number>();
    for (const body of bodies) for (const j of body.jobs) counts.set(j.id, (counts.get(j.id) ?? 0) + 1);
    const missing = state.tables.jobs.filter((r: any) => !counts.has(r.id));
    expect(missing).toEqual([]); // no original row displaced or lost
    expect(counts.get(inserted.id)).toBeGreaterThanOrEqual(1); // the insert is served
    expect(bodies[bodies.length - 1].hasNextPage).toBe(false);
  });

  it("the frozen floor keeps the beyond-pool region stable when the pool shrinks below 1000 mid-stream", async () => {
    seed(1400);
    const ranked = await walkStream("tok-user-no-answers", 2);
    const ordered = streamOrder(state.tables.jobs);
    const doomed = new Set<string>(ordered.slice(100, 300).map((r: any) => r.id)); // 200 in-window rows
    state.tables.jobs = state.tables.jobs.filter((r: any) => !doomed.has(r.id));
    state.tables.jobs_public = state.tables.jobs;

    const bodies = await walkToEnd("tok-user-no-answers", ranked);
    const counts = new Map<string, number>();
    for (const body of bodies) for (const j of body.jobs) counts.set(j.id, (counts.get(j.id) ?? 0) + 1);
    const missing = state.tables.jobs.filter((r: any) => !counts.has(r.id));
    expect(missing).toEqual([]); // every surviving row arrives even though the pool now holds 800
    for (const row of ordered.slice(1000)) {
      expect(counts.get(row.id)).toBe(1); // the beyond-pool region serves each row exactly once
    }
    expect(bodies[bodies.length - 1].hasNextPage).toBe(false);
  });
});
