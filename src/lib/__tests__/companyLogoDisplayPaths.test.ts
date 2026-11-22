import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Display paths of the company-logo contract: a logo stored ONLY on the nested companies row reaches cards
// and detail (search listing, /api/jobs/pro detail + batch unlock, service.ts single + batch mapping);
// external URLs never reach the UI; Free/guest masking still hides branding.

const SB = "https://fake.supabase.co";
const HOSTED = `${SB}/storage/v1/object/public/company-logos/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab.png`;
const FAVICON = "https://www.google.com/s2/favicons?domain=acme.com&sz=128";

const state = vi.hoisted(() => ({
  users: {} as Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }>,
  tables: {} as Record<string, any[]>,
}));

vi.mock("@supabase/supabase-js", () => {
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const run = () => {
      const data = (state.tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v));
      return { data, count: data.length, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
        if (prop === "eq") return (c: string, v: unknown) => (filters.push([c, v]), b);
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: run().data[0] ?? null, error: null });
        return () => b;
      },
    });
    return b;
  }
  const client = {
    auth: { getUser: async (token: string) => (state.users[token] ? { data: { user: state.users[token] }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    from,
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };
  return { createClient: () => client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
// Browser client used by service.ts: a signed-in Pro session plus the same in-memory tables.
vi.mock("@/lib/supabase/client", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const server: any = (createClient as any)();
  return { createClient: () => ({ ...server, auth: { getSession: async () => ({ data: { session: { access_token: "tok-pro" } } }) } }) };
});

const ID = "11111111-1111-4111-8111-111111111111";
const JOB = {
  id: ID, title: "Senior Engineer", company: "Acme Corp", location: "Remote", category: "engineering", remote: true,
  remote_scope: "worldwide", country_code: "US", job_type: "full-time", verified: true, posted_at: new Date().toISOString(),
  created_at: new Date().toISOString(), salary_text: "$100k", apply_url: "https://careers.acme.com/apply/1", description: "Build",
  skills: ["TypeScript"], company_id: "co_1", status: "active", is_active: true,
  logo_url: null, // nested-only: the logo exists only on the companies row
  companies: { name: "Acme Corp", logo_url: HOSTED, canonical_domain: "acme.com", domain: "acme.com", category: "MNC_BIGTECH" },
};
const req = (url: string, token?: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });

let search: (r: Request) => Promise<Response>;
let proGET: (r: Request) => Promise<Response>;
let proPOST: (r: Request) => Promise<Response>;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: "service-role-fake", COMPANY_GROUP_ID_SECRET: "group-secret-for-tests-0123456789",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  search = (await import("@/app/api/jobs/search/route")).GET;
  const pro = await import("@/app/api/jobs/pro/route");
  proGET = pro.GET;
  proPOST = pro.POST;
}, 60000);

beforeEach(() => {
  state.users = { "tok-free": { id: "u_free", email: "f@example.com", user_metadata: {} }, "tok-pro": { id: "u_pro", email: "p@example.com", user_metadata: {} } };
  state.tables = {
    jobs: [structuredClone(JOB)],
    jobs_public: [structuredClone(JOB)],
    subscriptions: [{ user_id: "u_pro", status: "active", plan_id: "monthly", current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), grace_period_end: null, created_at: new Date().toISOString() }],
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.__CAREERMONKE_LEGACY_JOBS_SERVICE;
});

describe("API routes: nested-only logos reach Pro cards and detail", () => {
  it("Pro search listing and /api/jobs/pro detail + batch unlock carry the nested hosted logo and domain", async () => {
    const listed = (await (await search(req("http://localhost/api/jobs/search", "tok-pro"))).json()).jobs[0];
    expect(listed.logoUrl).toBe(HOSTED);

    const detail = (await (await proGET(req(`http://localhost/api/jobs/pro?id=${ID}`, "tok-pro"))).json()).job;
    expect(detail).toMatchObject({ logo_url: HOSTED, logoUrl: HOSTED, company_domain: "acme.com" });

    const batch = await proPOST(req("http://localhost/api/jobs/pro", "tok-pro", { method: "POST", body: JSON.stringify({ ids: [ID] }), headers: { "Content-Type": "application/json" } }));
    const unlocked = (await batch.json()).jobs?.[0];
    expect(unlocked).toMatchObject({ logo_url: HOSTED, company_domain: "acme.com" });
  });

  it("an external/favicon logo never reaches the UI (initials)", async () => {
    state.tables.jobs[0].companies.logo_url = FAVICON;
    state.tables.jobs[0].logo_url = "https://unavatar.io/acme.com";
    const listed = (await (await search(req("http://localhost/api/jobs/search", "tok-pro"))).json()).jobs[0];
    expect(listed.logoUrl).toBeNull();
    const detail = (await (await proGET(req(`http://localhost/api/jobs/pro?id=${ID}`, "tok-pro"))).json()).job;
    expect(detail.logo_url).toBeNull();
  });

  it("a malformed hosted URL (bad %-escape) degrades to initials in list, detail and ticker instead of throwing", async () => {
    const BAD = `${SB}/storage/v1/object/public/company-logos/%E0%A4%A.png`;
    state.tables.jobs[0].companies.logo_url = BAD;
    state.tables.jobs[0].logo_url = BAD;
    const listRes = await search(req("http://localhost/api/jobs/search", "tok-pro"));
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).jobs[0].logoUrl).toBeNull();
    const detailRes = await proGET(req(`http://localhost/api/jobs/pro?id=${ID}`, "tok-pro"));
    expect(detailRes.status).toBe(200);
    expect((await detailRes.json()).job.logo_url).toBeNull();
    const { eligibleLogoUrl } = await import("@/lib/companies/logoEligibility"); // the ticker sanitizer and tile use this
    expect(eligibleLogoUrl(BAD, SB)).toBeNull();
  });

  it("Free and guest listings stay masked: no company, no logo", async () => {
    for (const token of ["tok-free", undefined]) {
      const listed = (await (await search(req("http://localhost/api/jobs/search", token))).json()).jobs[0];
      expect(listed.company).toBe("Verified Employer");
      expect(listed.logoUrl ?? null).toBeNull();
    }
    expect((await proGET(req(`http://localhost/api/jobs/pro?id=${ID}`, "tok-free"))).status).toBe(403);
  });
});

describe("service.ts mapping: nested-only logo reaches cards and detail", () => {
  it("getLiveJobById (Pro detail) maps nested companies.logo_url + domain from /api/jobs/pro", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => proGET(req(`http://localhost${url}`, "tok-pro", init)));
    const { getLiveJobById } = await import("@/lib/jobs/service");
    const job = await getLiveJobById(ID, true);
    expect(job?.logoUrl).toBe(HOSTED);
    expect(job?.companyDomain).toBe("acme.com");
  });

  it("batch Pro unlock merge picks up the nested logo + domain (resume-scored jobs_public -> Pro unlock)", async () => {
    process.env.__CAREERMONKE_LEGACY_JOBS_SERVICE = "true";
    // jobs_public rows carry no branding; the logo only arrives through the Pro unlock response.
    state.tables.jobs_public = [{ ...structuredClone(JOB), companies: null }];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      String(url).startsWith("/api/jobs/pro") ? proPOST(req(`http://localhost${url}`, "tok-pro", init)) : new Response("{}", { status: 404 })
    );
    const { getLiveJobs } = await import("@/lib/jobs/service");
    const res = await getLiveJobs({ isPro: true, pageSize: 5 });
    const job = res.jobs.find((j) => j.id === ID);
    expect(job?.logoUrl).toBe(HOSTED);
    expect(job?.companyDomain).toBe("acme.com");
  });
});
