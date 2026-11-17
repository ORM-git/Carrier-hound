import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const run = () => {
      const data = (state.tables[table] || []).filter((r) =>
        filters.every(([c, v]) => r[c] === v)
      );
      return { data, count: data.length, error: null };
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
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({ data: run().data[0] ?? null, error: null });
          }
          if (prop === "limit" || prop === "range" || prop === "order" || prop === "select") {
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
    },
    from,
  };
  return { createClient: () => client };
});

vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

const JOB_SENIOR_FRONTEND = {
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
  posted_at: new Date(Date.now() - 2 * 864e5).toISOString(),
  created_at: new Date(Date.now() - 2 * 864e5).toISOString(),
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
};

const JOB_JUNIOR_FRONTEND = {
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
  posted_at: new Date(Date.now() - 5 * 864e5).toISOString(),
  created_at: new Date(Date.now() - 5 * 864e5).toISOString(),
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
};

const JOB_SALES_EXEC = {
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
  posted_at: new Date(Date.now() - 1 * 864e5).toISOString(), // Newer, but completely unrelated
  created_at: new Date(Date.now() - 1 * 864e5).toISOString(),
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
};

const req = (url: string, token?: string) =>
  new Request(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

let recommendedRoute: (r: Request) => Promise<Response>;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "test-company-group-secret-0123456789",
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  recommendedRoute = (await import("@/app/api/jobs/recommended/route")).GET;
}, 30000);

beforeEach(() => {
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
    jobs: [
      { ...JOB_SENIOR_FRONTEND },
      { ...JOB_JUNIOR_FRONTEND },
      { ...JOB_SALES_EXEC },
    ],
    jobs_public: [
      { ...JOB_SENIOR_FRONTEND },
      { ...JOB_JUNIOR_FRONTEND },
      { ...JOB_SALES_EXEC },
    ],
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
});

describe("GET /api/jobs/recommended Handler Tests", () => {
  describe("1. Free vs Pro Masking", () => {
    it("Free user sees masked listing: company Verified Employer, empty salary, empty applyUrl, no description or skills", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended", "tok-free-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.jobs.length).toBeGreaterThan(0);

      const job = body.jobs[0];
      // Masked fields
      expect(job.company).toBe("Verified Employer");
      expect(job.companyGroupId).not.toBeNull();
      expect(job.salary).toBe("");
      expect(job.salary_display).toBeNull();
      expect(job.applyUrl).toBe("");
      expect(job.description).toBe("");
      expect(job.skills).toEqual([]);
      expect(job.logoUrl).toBeNull();
      expect(job.companyId).toBeUndefined();
    });

    it("Anonymous visitor also gets masked listing format", async () => {
      const res = await recommendedRoute(req("http://localhost/api/jobs/recommended"));
      expect(res.status).toBe(200);

      const body = await res.json();
      const job = body.jobs[0];
      expect(job.company).toBe("Verified Employer");
      expect(job.salary).toBe("");
      expect(job.applyUrl).toBe("");
    });

    it("Pro user gets unmasked listing: real company, salary, applyUrl, description, skills, and logoUrl", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended", "tok-pro-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.jobs.length).toBeGreaterThan(0);

      const job = body.jobs[0];
      // Unmasked fields
      expect(job.company).toBe("Frontend Masters Inc");
      expect(job.salary).toContain("$130,000");
      expect(job.applyUrl).toBe("https://careers.frontendmasters.com/jobs/1");
      expect(job.description).toBe("Lead modern React and TypeScript architecture");
      expect(job.skills).toContain("TypeScript");
      expect(job.logoUrl).toBe("https://cdn.example.com/logo-frontend.png");
      expect(job.companyId).toBe("co_frontend");
    });
  });

  describe("2. User With Answers vs User Without Answers", () => {
    it("User with onboarding answers gets personalized ranking matching their profile", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended", "tok-free-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.personalized).toBe(true);

      // Senior Remote Frontend job must rank #1 even though Sales Exec is newer
      expect(body.jobs[0].id).toBe(JOB_SENIOR_FRONTEND.id);
      expect(body.jobs[0].title).toBe("Senior Frontend Developer");
    });

    it("User without answers falls back cleanly to latest jobs (posted_at DESC)", async () => {
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended", "tok-user-no-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.personalized).toBe(false);

      // Latest posted job is JOB_SALES_EXEC (1d ago), followed by SENIOR_FRONTEND (2d ago), then JUNIOR_FRONTEND (5d ago)
      expect(body.jobs[0].id).toBe(JOB_SALES_EXEC.id);
      expect(body.jobs[1].id).toBe(JOB_SENIOR_FRONTEND.id);
      expect(body.jobs[2].id).toBe(JOB_JUNIOR_FRONTEND.id);
    });
  });

  describe("3. Scoring Order", () => {
    it("orders jobs strictly by match: full match > partial match > non-match", async () => {
      // User targeted: Frontend Developer, senior, remote, full-time
      const res = await recommendedRoute(
        req("http://localhost/api/jobs/recommended", "tok-pro-with-answers")
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      const rankedIds = body.jobs.map((j: any) => j.id);

      // Rank 1: JOB_SENIOR_FRONTEND (matches role, senior, remote, full-time)
      // Rank 2: JOB_JUNIOR_FRONTEND (matches role and full-time, but junior and onsite)
      // Rank 3: JOB_SALES_EXEC (unrelated role, part-time, onsite)
      expect(rankedIds).toEqual([
        JOB_SENIOR_FRONTEND.id,
        JOB_JUNIOR_FRONTEND.id,
        JOB_SALES_EXEC.id,
      ]);

      expect(body.jobs[0].matchScore).toBeGreaterThan(body.jobs[1].matchScore);
      expect(body.jobs[1].matchScore).toBeGreaterThan(body.jobs[2].matchScore);
    });

    it("supports query parameter overrides for quick testing / preview", async () => {
      // Override roles to target Sales Executive
      const res = await recommendedRoute(
        req(
          "http://localhost/api/jobs/recommended?roles=Sales%20Executive&remotePreference=onsite",
          "tok-user-no-answers"
        )
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.personalized).toBe(true);
      expect(body.jobs[0].id).toBe(JOB_SALES_EXEC.id);
    });
  });
});
