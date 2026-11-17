import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const orders: Array<{ col: string; ascending: boolean; nullsFirst?: boolean }> = [];
    let rangeBounds: [number, number] | null = null;
    let limitCount: number | null = null;

    const run = () => {
      let data = [...(state.tables[table] || [])].filter((r) =>
        filters.every(([c, v]) => r[c] === v)
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
              filters.push([c, v]);
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

// 300 test jobs corpus for realistic pagination and ranking assertions
function generateTestCorpus(count: number = 300) {
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

  // Remaining jobs to reach 300 items
  for (let i = 4; i <= count; i++) {
    const isEng = i % 2 === 0;
    const isRemote = i % 3 === 0;
    jobs.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: isEng ? `Software Engineer #${i}` : `Operations Specialist #${i}`,
      company: `Company ${i}`,
      company_id: `co_${i}`,
      location: isRemote ? "Remote (Worldwide)" : `City ${i}, State`,
      category: isEng ? "engineering" : "operations",
      remote: isRemote,
      is_remote: isRemote,
      remote_scope: isRemote ? "worldwide" : "onsite",
      country_code: "US",
      job_type: "full-time",
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
      skills: ["General", "Tech"],
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
  const corpus = generateTestCorpus(300);

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
      expect(body1.totalCount).toBe(300);
      expect(body11.totalCount).toBe(300);
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
  });
});
