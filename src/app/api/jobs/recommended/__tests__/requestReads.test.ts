// Per-request preference/resume reads for /api/jobs/recommended.
// Payload snapshots (__snapshots__/requestReads.*.json) were generated from the route BEFORE the
// request-local reads change, so a match proves identical Free/Pro payloads, order, scores and revisions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

const READ_TABLES = ["user_preferences", "onboarding_resume_profiles", "onboarding_resume_uploads"];
const STEP2_FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const PATH = (u: string) => `${u}/onboarding/resume.pdf`;

const entitlement = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/billing/serverEntitlement", () => ({
  getServerEntitlement: async (userId: string) => {
    entitlement.calls.push(userId);
    return { isPro: userId.startsWith("pro") };
  },
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

let tables: Record<string, any[]> = {};
let reads: Array<{ table: string; userId: unknown }> = [];
// Per table: upcoming outcomes for reads of that table ("error" | "throw"); empty = normal read.
let faults: Record<string, Array<"error" | "throw">> = {};

function builder(table: string) {
  const preds: Array<(r: any) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  let range: [number, number] | null = null;
  let userId: unknown;
  const run = () => {
    if (READ_TABLES.includes(table)) {
      reads.push({ table, userId });
      const fault = faults[table]?.shift();
      if (fault === "throw") throw new Error(`injected throw on ${table}`);
      if (fault === "error") return { data: null, error: { message: `injected error on ${table}` } };
    }
    let data = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
    data.sort((a, b) => {
      for (const o of orders) {
        if (a[o.col] === b[o.col]) continue;
        if (a[o.col] == null) return 1;
        if (b[o.col] == null) return -1;
        return (a[o.col] > b[o.col] ? 1 : -1) * (o.asc ? 1 : -1);
      }
      return 0;
    });
    if (range) data = data.slice(range[0], range[1] + 1);
    return { data, error: null };
  };
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
      if (prop === "maybeSingle") return async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; };
      if (prop === "eq") return (c: string, v: unknown) => { if (c === "user_id") userId = v; preds.push((r) => r[c] === v); return b; };
      if (prop === "in") return (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b; };
      if (prop === "or") return (expr: string) => { preds.push((r) => matchesPostgrestOr(expr, r)); return b; };
      if (prop === "ilike") return (c: string, p: string) => { const t = p.replace(/^%|%$/g, "").toLowerCase(); preds.push((r) => String(r[c] || "").toLowerCase().includes(t)); return b; };
      if (prop === "not") return (c: string, op: string, v: any) => {
        if (op === "is") preds.push((r) => r[c] != null);
        else { const t = String(v).replace(/^%|%$/g, "").toLowerCase(); preds.push((r) => !String(r[c] || "").toLowerCase().includes(t)); }
        return b;
      };
      if (prop === "gte") return (c: string, v: any) => { preds.push((r) => r[c] != null && r[c] >= v); return b; };
      if (prop === "order") return (col: string, o?: { ascending?: boolean }) => { orders.push({ col, asc: o?.ascending !== false }); return b; };
      if (prop === "range") return (f: number, t: number) => { range = [f, t]; return b; };
      return () => b; // select and anything else: no-op (whole rows; the payload formatter picks fields)
    },
  });
  return b;
}

const client = {
  auth: { getUser: async (token: string) => ({ data: { user: token.startsWith("tok-") ? { id: token.slice(4) } : null }, error: null }) },
  from: builder,
};

const SKILLS: Record<string, string[]> = { frontend: ["React", "TypeScript"], data: ["SQL", "Tableau"], backend: ["Go", "Postgres"], design: ["Figma"] };
const TITLES = ["Senior Frontend Developer", "Frontend Engineer", "Data Analyst", "Senior Data Analyst", "Backend Engineer", "Product Designer", "Account Executive", "Junior Frontend Developer"];
function corpus() {
  return Array.from({ length: 48 }, (_, i) => {
    const title = TITLES[i % TITLES.length];
    const kind = /Frontend/.test(title) ? "frontend" : /Data/.test(title) ? "data" : /Backend/.test(title) ? "backend" : "design";
    const posted = new Date(NOW.getTime() - (i + 1) * 3 * 3600e3).toISOString();
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title, company: `Company ${i % 13}`, company_id: `co_${i % 13}`,
      location: i % 3 === 0 ? "Bengaluru, India" : "Remote (Worldwide)", remote: i % 3 !== 0, remote_scope: i % 3 === 0 ? "onsite" : "worldwide",
      remote_eligibility: null, country: i % 3 === 0 ? "India" : "United States", country_code: i % 3 === 0 ? "IN" : "US",
      job_type: i % 5 === 0 ? "contract" : "full-time", category: kind === "data" ? "data" : kind === "design" ? "design" : "engineering",
      salary_min: 50000 + i * 1000, salary_max: 90000 + i * 1000, salary_period: "year", currency: "USD", salary_text: null,
      posted_at: posted, created_at: posted, first_seen_at: posted, status: "active", is_active: true,
      description: `${title} working with ${SKILLS[kind].join(" and ")}`, skills: SKILLS[kind], apply_url: `https://jobs.example.com/${i + 1}`,
      logo_url: null, companies: { logo_url: null, domain: `company${i % 13}.example.com` },
    };
  });
}
const prefsRow = (userId: string) => ({
  user_id: userId, roles: ["Frontend Developer"], experience_level: "senior", remote_preference: "remote",
  locations: ["United States"], employment_types: ["full-time"], categories: ["engineering"], min_salary: null, salary_currency: "USD",
});
const resumeRows = (userId: string, profile: any) => ({
  onboarding_resume_uploads: [{ user_id: userId, storage_path: PATH(userId) }],
  onboarding_resume_profiles: [{ user_id: userId, parse_status: "parsed", source_storage_path: PATH(userId), profile }],
});
const REAL_RESUME = { jobTitles: ["Data Analyst"], skills: ["SQL", "Tableau"], preferredRoles: [], education: [], yearsOfExperience: 3, location: null };
const EMPTY_RESUME = { jobTitles: [], skills: [], preferredRoles: [], education: [], yearsOfExperience: null, location: null };

let GET: (req: Request) => Promise<Response>;
const call = async (token: string | null, query = "") => {
  const res = await GET(new Request(`http://localhost/api/jobs/recommended?pageSize=20${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { status: res.status, body: await res.json() };
};
const readsOf = (table: string) => reads.filter((r) => r.table === table).length;
const prefReads = () => readsOf("user_preferences");
const resumeReads = () => readsOf("onboarding_resume_profiles"); // one resume read = profile + pointer query
const snap = (name: string, body: unknown) => expect(JSON.stringify(body, null, 2)).toMatchFileSnapshot(`./__snapshots__/requestReads.${name}.json`);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
    COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
    __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
  });
  (globalThis as any).__mockSupabaseClient = client;
  GET = (await import("@/app/api/jobs/recommended/route")).GET;
}, 30000);
afterAll(() => {
  vi.useRealTimers();
  delete (globalThis as any).__mockSupabaseClient;
});
beforeEach(() => {
  const jobs = corpus();
  tables = { jobs, jobs_public: jobs, user_preferences: [prefsRow("free-a"), prefsRow("pro-a")] };
  reads = [];
  faults = {};
  entitlement.calls = [];
});
afterEach(() => { delete process.env[STEP2_FLAG]; });

// [name, token, query, flag on, extra setup, expected preference reads, expected resume reads]
type Case = [string, string | null, string, boolean, () => void, number, number];
const withResume = (u: string, p: any) => () => Object.assign(tables, resumeRows(u, p));
const CASES: Case[] = [
  ["guest", null, "", false, () => {}, 0, 0],
  ["free-prefs-flag-off", "tok-free-a", "", false, () => {}, 1, 0],
  ["pro-prefs-flag-off", "tok-pro-a", "", false, () => {}, 1, 0],
  ["free-prefs-real-resume", "tok-free-a", "", true, withResume("free-a", REAL_RESUME), 1, 1],
  ["pro-prefs-real-resume", "tok-pro-a", "", true, withResume("pro-a", REAL_RESUME), 1, 1],
  ["pro-prefs-null-resume", "tok-pro-a", "", true, () => {}, 1, 1],
  ["pro-prefs-empty-resume", "tok-pro-a", "", true, withResume("pro-a", EMPTY_RESUME), 1, 1],
  ["free-missing-prefs-real-resume", "tok-free-b", "", true, withResume("free-b", REAL_RESUME), 1, 1],
  ["pro-missing-prefs-real-resume", "tok-pro-b", "", true, withResume("pro-b", REAL_RESUME), 1, 1],
  ["pro-missing-prefs-no-resume", "tok-pro-b", "", true, () => {}, 1, 1],
  ["pro-explicit-filters", "tok-pro-a", "&roles=Data%20Analyst&experienceLevel=mid&location=remote&jobType=full-time", false, () => {}, 1, 0],
  ["free-explicit-filters-resume", "tok-free-a", "&roles=Backend%20Engineer&workModel=remote&country_code=US", true, withResume("free-a", REAL_RESUME), 1, 1],
  // Failed first read: recovered by one retry (the old route's separate read), never cached as an empty profile.
  ["pro-prefs-error-once", "tok-pro-a", "", true, () => { faults.user_preferences = ["error"]; Object.assign(tables, resumeRows("pro-a", REAL_RESUME)); }, 2, 1],
  ["pro-prefs-error-always", "tok-pro-a", "", true, () => { faults.user_preferences = ["error", "error", "error"]; Object.assign(tables, resumeRows("pro-a", REAL_RESUME)); }, 2, 1],
  ["pro-prefs-throws-always", "tok-pro-a", "", true, () => { faults.user_preferences = ["throw", "throw", "throw"]; Object.assign(tables, resumeRows("pro-a", REAL_RESUME)); }, 2, 0],
  ["free-resume-error-once", "tok-free-a", "", true, () => { faults.onboarding_resume_uploads = ["error"]; Object.assign(tables, resumeRows("free-a", REAL_RESUME)); }, 1, 2],
  ["free-resume-error-always", "tok-free-a", "", true, () => { faults.onboarding_resume_uploads = ["error", "error", "error"]; Object.assign(tables, resumeRows("free-a", REAL_RESUME)); }, 1, 2],
];

describe("/api/jobs/recommended request-local preference and resume reads", () => {
  for (const [name, token, query, flag, setup, prefN, resumeN] of CASES) {
    it(`${name}: payload, order, display scores and revisions unchanged`, async () => {
      if (flag) process.env[STEP2_FLAG] = "true";
      setup();
      const { status, body } = await call(token, query);
      expect(status).toBe(200);
      await snap(name, body);
    });
    it(`${name}: ${prefN} preference read(s), ${resumeN} resume read(s), entitlement checked once`, async () => {
      if (flag) process.env[STEP2_FLAG] = "true";
      setup();
      await call(token, query);
      expect({ prefs: prefReads(), resume: resumeReads() }).toEqual({ prefs: prefN, resume: resumeN });
      expect(reads.every((r) => r.userId === token?.slice(4))).toBe(true);
      expect(entitlement.calls).toEqual(token ? [token.slice(4)] : []);
    });
  }

  it("separate users in concurrent requests read only their own rows and get their own payloads", async () => {
    process.env[STEP2_FLAG] = "true";
    Object.assign(tables, resumeRows("pro-b", REAL_RESUME));
    const [a, b] = await Promise.all([call("tok-pro-a"), call("tok-pro-b")]);
    const solo = async (t: string) => { reads = []; return call(t); };
    expect(a.body).toEqual((await solo("tok-pro-a")).body);
    expect(b.body).toEqual((await solo("tok-pro-b")).body);
    expect(a.body.jobs.map((j: any) => j.id)).not.toEqual(b.body.jobs.map((j: any) => j.id));
  });

  it("a later request re-reads: nothing is cached across requests", async () => {
    await call("tok-pro-a");
    tables.user_preferences = [{ ...prefsRow("pro-a"), roles: ["Data Analyst"], categories: ["data"] }];
    const first = reads.length;
    const after = await call("tok-pro-a");
    expect(reads.length - first).toBe(1);
    expect(after.body.jobs[0].title).toMatch(/Data Analyst/);
  });
});
