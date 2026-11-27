/**
 * Search masking extension (checklist row 9). Test-only: asserts the CURRENT contract, changes nothing.
 * Extends paidGatingMatrix.test.ts (S1-S15), which pins gated-FIELD masking but never the
 * companyGroupId substitution or the inactive-detail branches. Synthetic fixtures + an in-memory
 * Supabase fake only: no DB, no network, no production data.
 *
 * BRANCHES PINNED HERE (all uncovered by S1-S15):
 *   G1  GET /api/jobs/search list (guest + Free): every job carries companyGroupId, an opaque keyed
 *       hash (route.ts:833-837, 924); the raw company_id key and value never appear; one company
 *       maps to one stable group id.
 *   G2  Fail-closed: COMPANY_GROUP_ID_SECRET missing -> non-Pro list AND detail refuse the response
 *       with 503 degraded (route.ts:246-257, 837-844). Never a 200 with real or unkeyed ids.
 *   G3  Inactive detail (is_active=false / status expired): even a Pro viewer gets company masked,
 *       applyUrl/salary/description emptied (route.ts:261, 297, 318-321). List queries exclude
 *       inactive rows at the query level (.eq("is_active", true).eq("status", "active"), :419).
 *   G4  No-service-key non-Pro detail: jobs_public carries no company_id, so companyGroupId is null
 *       and no company id of any kind is exposed (fail-closed by omission).
 *   G5  Pro positive controls: list and detail expose the real companyId (substitution is non-Pro only).
 *   G6  netlify jobs-search mirror: same list substitution and fail-closed contract.
 *
 * OBSERVED, NOT PINNED (reported for owner/keeper scope decision, not codified): on the Pro inactive
 * detail path, skills, matchScore, stored top_keywords and the real companyId/company_id are still
 * served although company name, salary, apply_url and description are masked (route.ts:301-302,
 * 322-323). Whether that is intended for expired jobs is a product-scope question; this file does
 * not assert either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// ---------- in-memory Supabase fake (same shape as paidGatingMatrix) ----------
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
  return { createClient: () => client };
});
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));

import { GET as searchGET } from "@/app/api/jobs/search/route";
import { handler as netlifySearchHandler } from "../../../netlify/functions/jobs-search";

// ---------- fixtures ----------
const RAW_COMPANY_ID = "co-sentinel";
const REAL_COMPANY = "Zqxv Sentinel Holdings";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID_INACTIVE = "33333333-3333-4333-8333-333333333333";
const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3600e3).toISOString();

const fullRow = (id: string, hoursAgo: number, extra: Record<string, unknown> = {}) => ({
  id, title: "Backend Engineer", company: REAL_COMPANY, company_id: RAW_COMPANY_ID, company_slug: "zqxv-sentinel",
  location: "Remote (Worldwide)", remote: true, is_remote: true, remote_scope: "worldwide", remote_eligibility: "worldwide",
  job_type: "full-time", category: "engineering", country: "United States", country_code: "US", seniority: "mid",
  verified: true, source_type: "greenhouse", status: "active", is_active: true, role_category: "backend",
  top_keywords: ["backend"], posted_at: iso(hoursAgo), created_at: iso(hoursAgo), first_seen_at: iso(hoursAgo),
  discovered_at: iso(hoursAgo), last_seen_at: iso(0), logo_url: null,
  salary_text: "SALARY-SENTINEL", salary_min: 987654, salary_max: 987659, currency: "USD", salary_period: "year",
  apply_url: "https://apply-sentinel.example/apply/1", description: "DESC-SENTINEL body", skills: ["SkillSentinelQx"],
  companies: { name: REAL_COMPANY, logo_url: null, domain: null, canonical_domain: null, category: null },
  ...extra,
});

// jobs_public mirrors the real view: gated columns are constants and there is NO company_id.
const viewRow = (r: Record<string, any>) => ({
  id: r.id, title: r.title, location: r.location, remote: r.remote, remote_scope: r.remote_scope,
  remote_eligibility: r.remote_eligibility, job_type: r.job_type, category: r.category, country: r.country,
  country_code: r.country_code, seniority: r.seniority, verified: r.verified, source_type: r.source_type,
  first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, discovered_at: r.discovered_at,
  posted_at: r.posted_at, created_at: r.created_at, status: r.status, is_active: r.is_active,
  role_category: r.role_category, top_keywords: r.top_keywords, is_remote: r.is_remote,
  company: "Verified Employer", salary_text: null, description: null, apply_url: null, skills: [],
});

function seed() {
  const active = [fullRow(ID1, 1), fullRow(ID2, 2)];
  const inactive = fullRow(ID_INACTIVE, 3, { is_active: false, status: "expired" });
  db.tables = {
    jobs: [...active, inactive],
    jobs_public: active.map(viewRow), // the view only ever exposes active rows
    subscriptions: [{
      user_id: "pro-1", status: "active", plan_id: "monthly",
      current_period_end: new Date(NOW + 10 * 864e5).toISOString(), grace_period_end: null, created_at: iso(24),
    }],
    user_preferences: [
      { user_id: "free-1", roles: ["Backend Engineer"], experience_level: "mid", remote_preference: "any", locations: [], employment_types: [], categories: ["engineering"] },
      { user_id: "pro-1", roles: ["Backend Engineer"], experience_level: "mid", remote_preference: "any", locations: [], employment_types: [], categories: ["engineering"] },
    ],
    job_descriptions: [],
  };
}

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fake.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-fake",
  SUPABASE_URL: "https://fake.supabase.co",
  COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890",
  NEXT_PUBLIC_BILLING_ENABLED: "true",
  __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
};

const TOKENS = { guest: undefined, free: "tok-free", pro: "tok-pro" } as const;
const req = (url: string, token?: string) =>
  new Request(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  Object.assign(process.env, baseEnv, { SUPABASE_SERVICE_ROLE_KEY: "service-role-fake" });
  db.users = {
    "tok-free": { id: "free-1", email: "free@example.com", user_metadata: {} },
    "tok-pro": { id: "pro-1", email: "pro@example.com", user_metadata: {} },
  };
  db.sessionToken = null;
  seed();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ---------- assertions ----------
function expectOpaqueGroupId(job: any, label: string) {
  expect(typeof job.companyGroupId, `${label}: companyGroupId type`).toBe("string");
  expect(job.companyGroupId.length, `${label}: companyGroupId non-empty`).toBeGreaterThan(0);
  expect(job.companyGroupId, `${label}: group id must not be the raw company_id`).not.toBe(RAW_COMPANY_ID);
  expect(job, `${label}: no camelCase companyId`).not.toHaveProperty("companyId");
  expect(job, `${label}: no raw company_id key`).not.toHaveProperty("company_id");
}

async function listJobs(token?: string) {
  const res = await searchGET(req("/api/jobs/search?q=backend", token));
  return { status: res.status, body: await res.json() };
}

describe("G1 list: opaque companyGroupId, raw company_id never exposed", () => {
  it.each([["guest", TOKENS.guest], ["Free", TOKENS.free]] as const)(
    "%s list: companyGroupId present and opaque, one stable id per company", async (_label, token) => {
      const { status, body } = await listJobs(token);
      expect(status).toBe(200);
      expect(body.jobs.length).toBe(2);
      for (const job of body.jobs) expectOpaqueGroupId(job, _label);
      // Same company -> same keyed id (stable join key for grouping without identity).
      expect(body.jobs[0].companyGroupId).toBe(body.jobs[1].companyGroupId);
      expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
    }
  );

  it("list excludes the seeded inactive row at the query level", async () => {
    const { status, body } = await listJobs(TOKENS.guest);
    expect(status).toBe(200);
    expect(body.jobs.map((j: any) => j.id)).not.toContain(ID_INACTIVE);
  });

  it("Pro positive control: list exposes the real companyId", async () => {
    const { status, body } = await listJobs(TOKENS.pro);
    expect(status).toBe(200);
    expect(body.jobs.length).toBe(2);
    for (const job of body.jobs) expect(job.companyId).toBe(RAW_COMPANY_ID);
  });
});

describe("G2 fail-closed when COMPANY_GROUP_ID_SECRET is missing", () => {
  it("non-Pro list refuses with 503 degraded, no rows and no company identity", async () => {
    delete process.env.COMPANY_GROUP_ID_SECRET;
    const { status, body } = await listJobs(TOKENS.guest);
    expect(status).toBe(503);
    expect(body.degraded).toBe(true);
    expect(body.jobs).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
    expect(JSON.stringify(body)).not.toContain(REAL_COMPANY);
  });

  it("non-Pro detail refuses with 503 degraded", async () => {
    delete process.env.COMPANY_GROUP_ID_SECRET;
    const res = await searchGET(req(`/api/jobs/search?id=${ID1}`, TOKENS.guest));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
  });
});

describe("G3 detail: substitution and inactive masking", () => {
  it("guest detail: companyGroupId opaque, no raw company id keys or values", async () => {
    const res = await searchGET(req(`/api/jobs/search?id=${ID1}`, TOKENS.guest));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(1);
    expectOpaqueGroupId(body.jobs[0], "guest detail");
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
  });

  it("Pro detail on an inactive job: company, salary, apply and description are masked", async () => {
    const res = await searchGET(req(`/api/jobs/search?id=${ID_INACTIVE}`, TOKENS.pro));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(1);
    const job = body.jobs[0];
    expect(job.company).toBe("Verified Employer");
    expect(job.applyUrl).toBe("");
    expect(job.salary).toBe("");
    expect(job.salary_display).toBeNull();
    expect(job.salary_original).toBeNull();
    expect(job.description).toBe("");
    // Not asserted (reported separately, see header): skills, matchScore, top_keywords, companyId.
  });
});

describe("G4 no-service-key non-Pro detail fails closed by omission", () => {
  it("jobs_public has no company_id: companyGroupId is null and no company id leaks", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await searchGET(req(`/api/jobs/search?id=${ID1}`, TOKENS.guest));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBe(1);
    const job = body.jobs[0];
    expect(job.companyGroupId).toBeNull();
    expect(job).not.toHaveProperty("companyId");
    expect(job).not.toHaveProperty("company_id");
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
  });
});

describe("G6 netlify jobs-search mirror", () => {
  const netlifyEvent = (query: Record<string, string> = {}) => ({
    httpMethod: "GET",
    headers: { "x-forwarded-for": "10.0.0.7" },
    queryStringParameters: query,
    body: null,
  });

  it("guest list: companyGroupId opaque, no raw company id in the payload", async () => {
    const res = await netlifySearchHandler(netlifyEvent({ q: "backend" }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jobs.length).toBe(2);
    for (const job of body.jobs) expectOpaqueGroupId(job, "netlify guest list");
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
  });

  it("guest list with the secret missing: 503 degraded, never a masked-200 fallback", async () => {
    delete process.env.COMPANY_GROUP_ID_SECRET;
    const res = await netlifySearchHandler(netlifyEvent({ q: "backend" }));
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.degraded).toBe(true);
    expect(JSON.stringify(body)).not.toContain(RAW_COMPANY_ID);
  });
});
