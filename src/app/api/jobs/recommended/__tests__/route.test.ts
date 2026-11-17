import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";

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
            return (expr: string) => {
              const clauses = expr.split(",");
              predicates.push((r) => {
                return clauses.some((clause: string) => {
                  const parts = clause.split(".");
                  if (parts.length >= 3) {
                    const col = parts[0];
                    const op = parts[1];
                    const rawVal = parts.slice(2).join(".");
                    if (op === "eq") {
                      const boolVal = rawVal === "true" ? true : rawVal === "false" ? false : rawVal;
                      return r[col] === boolVal || String(r[col]) === String(rawVal);
                    }
                    if (op === "ilike") {
                      const term = rawVal.replace(/^%|%$/g, "").toLowerCase();
                      return String(r[col] || "").toLowerCase().includes(term);
                    }
                  }
                  return false;
                });
              });
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

    it("Route-level test: with experienceLevel=entry&remotePreference=remote&pageSize=100, assert no returned row has remote=false or matchScore=0", async () => {
      const res = await recommendedRoute(
        req(
          "http://localhost/api/jobs/recommended?experienceLevel=entry&remotePreference=remote&pageSize=100",
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
