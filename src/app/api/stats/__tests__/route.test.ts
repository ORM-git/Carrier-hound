import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "../route";
import { HIDDEN_SOURCE_TYPE, VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// In-memory mock database state
const mockDb = {
  jobsPublic: [] as Array<Record<string, any>>,
  companies: [] as Array<Record<string, any>>,
  queryError: null as any,
  queryCountOverride: null as number | null,
  // A count query that succeeds but returns count: null (no error object).
  queryCountNull: false,
  orFilters: [] as string[],
};

vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => ({
      auth: {
        getUser: vi.fn().mockImplementation(async (token: string) => {
          if (token === "valid-user-token") {
            return {
              data: { user: { id: "user-123", email: "user@example.com" } },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error("Invalid token") };
        }),
      },
      from: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        let isCountQuery = false;

        const builder: any = {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.count === "exact") isCountQuery = true;
            return builder;
          },
          or: (filterStr: string) => {
            // The repo's PostgREST logic-tree evaluator (SQL three-valued NULL semantics), applied to
            // whatever filter string the route sends: no hand-written stand-in for the source policy.
            mockDb.orFilters.push(filterStr);
            filters.push((r) => matchesPostgrestOr(filterStr, r));
            return builder;
          },
          eq: (col: string, val: any) => {
            filters.push((r) => r[col] === val);
            return builder;
          },
          gte: (col: string, val: string) => {
            filters.push((r) => new Date(r[col]).getTime() >= new Date(val).getTime());
            return builder;
          },
          lt: (col: string, val: string) => {
            filters.push((r) => new Date(r[col]).getTime() < new Date(val).getTime());
            return builder;
          },
          then: (resolve: (val: any) => void) => {
            if (mockDb.queryError) {
              resolve({ count: null, data: null, error: mockDb.queryError });
              return;
            }
            if (mockDb.queryCountNull && isCountQuery) {
              resolve({ count: null, data: null, error: null });
              return;
            }
            if (mockDb.queryCountOverride !== null && isCountQuery) {
              resolve({ count: mockDb.queryCountOverride, data: null, error: null });
              return;
            }

            const rows = table === "jobs_public" ? mockDb.jobsPublic : mockDb.companies;
            const matched = rows.filter((r) => filters.every((f) => f(r)));
            resolve({
              count: isCountQuery ? matched.length : null,
              data: isCountQuery ? null : matched,
              error: null,
            });
          },
        };
        return builder;
      },
    }),
  };
});

describe("GET /api/stats query bounds and metric truth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://mock.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
    };
    mockDb.jobsPublic = [];
    mockDb.companies = [];
    mockDb.queryError = null;
    mockDb.queryCountOverride = null;
    mockDb.queryCountNull = false;
    mockDb.orFilters = [];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("counts jobs at the inclusive start boundary (UTC midnight exactly)", async () => {
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

    mockDb.jobsPublic = [
      {
        id: "job-midnight-start",
        created_at: todayMidnight.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(1);
  });

  it("excludes jobs created prior to today UTC midnight", async () => {
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const priorDayInstant = new Date(todayMidnight.getTime() - 1); // 1 ms before midnight

    mockDb.jobsPublic = [
      {
        id: "job-yesterday",
        created_at: priorDayInstant.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(0);
  });

  it("excludes jobs at or after next UTC midnight (exclusive next midnight)", async () => {
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));

    mockDb.jobsPublic = [
      {
        id: "job-next-midnight",
        created_at: nextMidnight.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(0);
  });

  it("excludes old jobs refreshed today (last_seen_at refreshed but created_at is old)", async () => {
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const yesterday = new Date(todayMidnight.getTime() - 3600_000);

    mockDb.jobsPublic = [
      {
        id: "old-job-refreshed",
        created_at: yesterday.toISOString(), // Immutable first discovery
        last_seen_at: now.toISOString(),     // Refreshed today
        updated_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "workday",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(0);
  });

  it("counts listing rows, not canonical roles: one role from two boards counts twice (metric qualification)", async () => {
    // jobs_public is a plain projection of public.jobs (no DISTINCT). Row identity is enforced at
    // ingestion: UNIQUE (source_id, source_job_id) and UNIQUE apply_url, with dedupe_hash advisory
    // (#643), so the same role on two boards is two rows. See jobIdentityForDailyCount.test.ts.
    const now = new Date();
    const base = { created_at: now.toISOString(), is_active: true, status: "active", dedupe_hash: "same-role-hash" };
    mockDb.jobsPublic = [
      { ...base, id: "board-a-row", source_type: "greenhouse", source_id: "board-a", source_job_id: "42" },
      { ...base, id: "board-b-row", source_type: "lever", source_id: "board-b", source_job_id: "777" },
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(2);
  });

  it("source policy uses the real VISIBLE_SOURCE_FILTER: NULL source_type kept, source_type jobspy hidden, the 'source' column ignored", async () => {
    const now = new Date().toISOString();
    const row = (id: string, extra: Record<string, unknown>) => ({ id, created_at: now, is_active: true, status: "active", ...extra });
    mockDb.jobsPublic = [
      row("null-source-type", { source_type: null, source: null }),
      row("missing-source-type", {}),
      row("greenhouse", { source_type: "greenhouse", source: "greenhouse" }),
      row("aggregator", { source_type: "aggregator", source: "adzuna" }),
      row("jobspy-type", { source_type: HIDDEN_SOURCE_TYPE, source: "linkedin" }),
      // The policy keys on source_type only: a 'source' value of jobspy alone is not hidden.
      row("jobspy-source-name-only", { source_type: "ats", source: "jobspy" }),
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(mockDb.orFilters).toContain(VISIBLE_SOURCE_FILTER);
    expect((await res.json()).jobsToday).toBe(5);
  });

  it("excludes inactive, hidden-source (source_type jobspy) or non-active status jobs", async () => {
    const now = new Date();
    mockDb.jobsPublic = [
      {
        id: "inactive-job",
        created_at: now.toISOString(),
        is_active: false,
        status: "active",
        source: "greenhouse",
      },
      {
        id: "closed-job",
        created_at: now.toISOString(),
        is_active: true,
        status: "closed",
        source: "greenhouse",
      },
      {
        id: "jobspy-job",
        created_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "linkedin",
        source_type: HIDDEN_SOURCE_TYPE, // Excluded by VISIBLE_SOURCE_FILTER (keys on source_type)
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(0);
  });

  it("returns true zero when 0 jobs were found today", async () => {
    mockDb.jobsPublic = [];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(0);
    expect(typeof body.updatedAt).toBe("string");
  });

  it("returns 503 Service unavailable on database query failure (never 0)", async () => {
    mockDb.queryError = new Error("PostgREST connection refused");
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.jobsToday).toBeUndefined();
    expect(body.error).toBe("Service unavailable");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 when the count is negative", async () => {
    mockDb.queryCountOverride = -1;
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(503);
  });

  it("returns 503 (never 0) when the count query succeeds without error but count is null", async () => {
    mockDb.queryCountNull = true;
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.jobsToday).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("anonymous callers receive strictly { jobsToday, updatedAt } with edge cache headers", async () => {
    const now = new Date();
    mockDb.jobsPublic = [
      {
        id: "job-1",
        created_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(1);
    expect(typeof body.updatedAt).toBe("string");
    // Ensure ZERO corpus totals exposed to anonymous visitors
    expect(body.totalJobs).toBeUndefined();
    expect(body.activeJobs).toBeUndefined();
    expect(body.companies).toBeUndefined();
    expect(body.companiesScanned).toBeUndefined();

    // Verify cache headers
    expect(res.headers.get("cache-control")).toContain("public, s-maxage=60");
    expect(res.headers.get("vary")).toBe("Authorization");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("authenticated callers receive full corpus metrics with no-store cache headers", async () => {
    const now = new Date();
    mockDb.jobsPublic = [
      {
        id: "job-1",
        created_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
    ];
    mockDb.companies = [{ id: "c1", name: "Acme" }];

    const req = new Request("https://careermonke.com/api/stats", {
      headers: { Authorization: "Bearer valid-user-token" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(1);
    expect(body.activeJobs).toBe(1);
    expect(body.companies).toBe(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
