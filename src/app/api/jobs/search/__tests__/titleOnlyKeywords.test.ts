import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Rows 9/10: stored top_keywords are derived from the locked description, so guest/Free search
// responses (list and detail) must carry title-only keywords. Real handler + real entitlement,
// in-memory Supabase fake (same shape as launchFreeVsProHandlers.test.ts).

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

// Appears only in the locked description and the stored keywords derived from it, never in the title.
const SENTINEL = "zqxvdescsentinel";
const ID = "11111111-1111-4111-8111-111111111111";
const JOB = {
  id: ID, title: "Senior Engineer", company: "Acme Corp", location: "Remote", category: "engineering",
  remote: true, remote_scope: "worldwide", country_code: "US", job_type: "full-time", verified: true,
  posted_at: new Date().toISOString(), created_at: new Date().toISOString(),
  apply_url: "https://careers.acme.com/apply/1", description: `Work with ${SENTINEL} daily`, skills: ["TypeScript"],
  top_keywords: [SENTINEL, "TypeScript"], company_id: "co_1", status: "active", is_active: true,
  companies: { name: "Acme Corp", logo_url: null },
};

const req = (url: string, token?: string) => new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
let search: (r: Request) => Promise<Response>;

beforeAll(async () => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "group-secret-for-tests-0123456789",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  search = (await import("@/app/api/jobs/search/route")).GET;
}, 60000);

beforeEach(() => {
  state.users = {
    "tok-free": { id: "u_free", email: "free@example.com", user_metadata: {} },
    "tok-claim": { id: "u_claim", email: "claim@example.com", user_metadata: { is_pro: true } },
    "tok-pro": { id: "u_pro", email: "pro@example.com", user_metadata: {} },
  };
  state.tables = {
    jobs: [{ ...JOB }],
    // The live view still exposes stored top_keywords; the route must not rely on a migration.
    jobs_public: [{ ...JOB, company: "Verified Employer", description: null, skills: [], apply_url: null }],
    subscriptions: [{
      user_id: "u_pro", status: "active", plan_id: "monthly",
      current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), grace_period_end: null,
      created_at: new Date().toISOString(),
    }],
  };
});

const body = async (url: string, token?: string) => JSON.stringify(await (await search(req(url, token))).json());

describe("search route keywords: non-Pro is title-only", () => {
  for (const [who, token] of [["guest", undefined], ["Free", "tok-free"], ["metadata-claimed Pro", "tok-claim"]] as const) {
    it(`${who}: list and detail never carry description-derived stored keywords`, async () => {
      for (const url of ["http://localhost/api/jobs/search", `http://localhost/api/jobs/search?id=${ID}`]) {
        const text = await body(url, token);
        expect(text).toContain(ID); // the job is actually returned
        expect(text).not.toContain(SENTINEL);
      }
    });
  }

  it("Pro control: stored keywords still served on list and detail", async () => {
    for (const url of ["http://localhost/api/jobs/search", `http://localhost/api/jobs/search?id=${ID}`]) {
      expect(await body(url, "tok-pro")).toContain(SENTINEL);
    }
  });
});

describe("row 72: Pro search list is lean, the single-job detail stays complete", () => {
  it("Pro list row: empty description, lean flag, derived buckets, skills/applyUrl/score kept; detail carries the full description", async () => {
    const list = await (await search(req("http://localhost/api/jobs/search", "tok-pro"))).json();
    const row = list.jobs.find((j: any) => j.id === ID);
    expect(row.description).toBe("");
    expect(row.lean).toBe(true);
    expect(row.experienceBuckets).toContain("5+ Years");
    expect(row.skills).toEqual([]);   // raw skills stay server-side on lean rows
    expect(row.evidencedSkills).toEqual(expect.arrayContaining(["TypeScript"]));
    expect(row.applyUrl).toBe(JOB.apply_url);
    expect(typeof row.scoreRevision).toBe("string");
    const detail = await (await search(req(`http://localhost/api/jobs/search?id=${ID}`, "tok-pro"))).json();
    const d = detail.jobs?.[0] ?? detail.job ?? detail;
    expect(d.description).toBe(JOB.description);
    expect(d.lean).toBeUndefined();
    expect(d.scoreRevision).toBe(row.scoreRevision);
  });
  it("guest and Free list rows carry no lean fields", async () => {
    for (const token of [undefined, "tok-free"]) {
      const list = await (await search(req("http://localhost/api/jobs/search", token))).json();
      const row = list.jobs.find((j: any) => j.id === ID);
      expect(row.lean).toBeUndefined();
      expect(row.experienceBuckets).toBeUndefined();
      expect(row.description).toBe("");
    }
  });
});
