/**
 * Cross-route privacy matrix extension (checklist row 47). Test-only: asserts the CURRENT
 * contract, changes nothing. Extends paidGatingMatrix.test.ts (S1-S15) to job-derived
 * surfaces outside that inventory. Synthetic fixtures + module mocks only: no DB, no
 * network, no production data.
 *
 * SURFACES PINNED HERE:
 *   X1  GET /api/stats            anonymous and invalid-token callers receive EXACTLY
 *                                 {jobsToday, updatedAt} - never activeJobs/totalJobs/
 *                                 companies/companiesScanned; any Authorization header
 *                                 keeps the response no-store (no shared-cache poisoning).
 *                                 Authenticated caller gets aggregates (positive control).
 *   X2  netlify/functions/stats   mirror of X1: anonymous body is exactly {jobsToday, updatedAt}.
 *   X3  GET /api/radar            reads job data ONLY through the jobs_public masked view:
 *                                 the raw jobs table is never queried, and a sentinel real
 *                                 company planted in raw jobs never appears in the response.
 *                                 (Source-level view qualification, not a live security proof.)
 *   X4  GET /api/jobs/capabilities response values are strictly booleans: no env values,
 *                                 account data or strings leak through the flags surface.
 *
 * EXCLUDED WITH REASONS (not gaps):
 *   - /api/ticker + netlify ticker: deliberate public brand-marketing surface serving real
 *     company names/logos (user-requested). Its correlation scope vs masked listings is an
 *     owner-level scope question, not a settled contract: no failing guard here.
 *   - /api/jobs/capabilities env flags: covered above (X4).
 *   - /api/me/quota, /api/account/export: own-account data, different contract.
 *   - /api/ai, /api/ai/stream: no job/company/score fields in the surface.
 *   - /api/track: write-only analytics ingest.
 *   - /api/admin/*: admin authorization boundary (verifyAdminSession), out of this matrix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- hoisted fakes ----------
const h = vi.hoisted(() => {
  const REAL_CORP = "REAL-SECRET-CORP-SENTINEL";
  return {
    REAL_CORP,
    tablesQueried: [] as string[],
    goodTokens: new Set<string>(),
  };
});

function makeChain(table: string) {
  let head = false;
  const chain: any = {};
  const terminal = () => {
    if (table === "jobs") {
      // Raw table sentinel: if any route reads it, the real name is right there to leak.
      return { data: [{ id: "raw1", company: h.REAL_CORP }], error: null, count: 1 };
    }
    if (table === "jobs_public") {
      if (head) return { data: null, error: null, count: 2 };
      return {
        data: [
          { id: "v1", company: "Verified Employer", title: "Engineer", location: "Bengaluru, Karnataka, India", country_code: "IN", remote_scope: null, remote_eligibility: null, verified: true },
          { id: "v2", company: "Verified Employer", title: "Designer", location: null, country_code: null, remote_scope: "worldwide", remote_eligibility: "anyone", verified: false },
        ],
        error: null,
        count: 2,
      };
    }
    if (table === "ingest_runs") return { data: null, error: null, count: 0 };
    if (table === "companies") return { data: null, error: null, count: 42 };
    return { data: [], error: null, count: 0 };
  };
  for (const m of ["or", "eq", "order", "limit", "range", "in", "neq", "filter", "gt", "lt", "gte", "lte", "like", "ilike", "not"])
    chain[m] = () => chain;
  chain.select = (_cols?: any, opts?: any) => {
    if (opts?.head) head = true;
    return chain;
  };
  chain.maybeSingle = async () => ({
    data: table === "ingest_runs"
      ? { finished_at: "2026-11-27T09:00:00Z", total_active: 2, total_verified: 1 }
      : null,
    error: null,
  });
  chain.single = chain.maybeSingle;
  chain.then = (resolve: any, reject: any) => Promise.resolve(terminal()).then(resolve, reject);
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) =>
        h.goodTokens.has(token)
          ? { data: { user: { id: "u1", email: "u1@example.com", user_metadata: {} } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from: (table: string) => {
      h.tablesQueried.push(table);
      return makeChain(table);
    },
  }),
}));

vi.mock("@/lib/api/retainedJobsToday", () => ({
  countRetainedJobsToday: async () => ({ ok: true, count: 7, asOf: "2026-11-27T10:00:00.000Z" }),
}));

vi.mock("@/lib/api/sharedRateLimit", async (importActual) => ({
  ...(await importActual<any>()),
  checkSharedRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
}));

vi.mock("@/lib/ai/serviceHandler", async (importActual) => ({
  ...(await importActual<any>()),
  getClientIpFromRequest: () => "203.0.113.9",
  checkRateLimit: async () => ({ allowed: true }),
}));

vi.mock("@/lib/monitoring/sentryErrorReporter", () => ({
  reportRequestErrorToSentry: () => {},
}));

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => ({ env: {} }),
}));

// ---------- imports under test ----------
import { GET as statsGET } from "@/app/api/stats/route";
import { GET as radarGET } from "@/app/api/radar/route";
import { GET as capabilitiesGET } from "@/app/api/jobs/capabilities/route";
import { handler as netlifyStatsHandler } from "../../../netlify/functions/stats";

const AGGREGATE_KEYS = ["activeJobs", "totalJobs", "companies", "companiesScanned"];

beforeEach(() => {
  h.tablesQueried.length = 0;
  h.goodTokens.clear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key";
});

describe("X1/X2 stats aggregate gating", () => {
  it("anonymous /api/stats returns exactly {jobsToday, updatedAt} and no aggregate counts", async () => {
    const res = await statsGET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["jobsToday", "updatedAt"]);
    for (const k of AGGREGATE_KEYS) expect(body).not.toHaveProperty(k);
  });

  it("an invalid Bearer token is treated as anonymous and the response is no-store", async () => {
    const res = await statsGET(
      new Request("https://careermonke.com/api/stats", {
        headers: { Authorization: "Bearer garbage-token" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["jobsToday", "updatedAt"]);
    for (const k of AGGREGATE_KEYS) expect(body).not.toHaveProperty(k);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Vary")).toContain("Authorization");
  });

  it("authenticated /api/stats returns the aggregate metrics (positive control)", async () => {
    h.goodTokens.add("good-token");
    const res = await statsGET(
      new Request("https://careermonke.com/api/stats", {
        headers: { Authorization: "Bearer good-token" },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeJobs).toBe(2);
    expect(body.companies).toBe(42);
    expect(body.jobsToday).toBe(7);
  });

  it("netlify stats mirror: anonymous body is exactly {jobsToday, updatedAt}", async () => {
    const res = await netlifyStatsHandler({ httpMethod: "GET", headers: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(["jobsToday", "updatedAt"]);
    for (const k of AGGREGATE_KEYS) expect(body).not.toHaveProperty(k);
  });
});

describe("X3 radar reads only the masked view", () => {
  it("never queries the raw jobs table and never leaks its sentinel company", async () => {
    const res = await radarGET(new Request("https://careermonke.com/api/radar"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(body.header.totalActive).toBe(2);
    expect(body.header.totalVerified).toBe(1);
    expect(h.tablesQueried).toContain("jobs_public");
    expect(h.tablesQueried).not.toContain("jobs");
    expect(text).not.toContain(h.REAL_CORP);
    expect(text).not.toContain("Verified Employer"); // masked placeholder is not a company (899)
  });
});

describe("X4 capabilities exposes booleans only", () => {
  it("every top-level response value is a boolean", async () => {
    const res = await capabilitiesGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = Object.keys(body);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(typeof body[k], `key ${k}`).toBe("boolean");
  });
});
