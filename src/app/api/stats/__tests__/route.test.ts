import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "../route";
import { HIDDEN_SOURCE_TYPE, VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";
import { __resetRetainedCountForTests, RETAINED_COUNT_DEADLINE_MS } from "@/lib/api/retainedJobsToday";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

// In-memory mock database state
const mockDb = {
  jobs: [] as Array<Record<string, any>>,
  jobsPublic: [] as Array<Record<string, any>>,
  tables: [] as string[],
  signals: [] as AbortSignal[],
  hang: false,
  jobsQueries: 0,
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
        mockDb.tables.push(table);
        if (table === "jobs") mockDb.jobsQueries++;
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
          abortSignal: (sig: AbortSignal) => {
            mockDb.signals.push(sig);
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
            if (mockDb.hang && table === "jobs") return; // never settles
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

            const rows = table === "jobs" ? mockDb.jobs : table === "jobs_public" ? mockDb.jobsPublic : mockDb.companies;
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
    __resetRetainedCountForTests();
    mockDb.signals = [];
    mockDb.hang = false;
    mockDb.jobsQueries = 0;
    mockDb.jobs = [];
    mockDb.tables = [];
    mockDb.jobsPublic = [];
    mockDb.companies = [];
    mockDb.queryError = null;
    mockDb.queryCountOverride = null;
    mockDb.queryCountNull = false;
    mockDb.orFilters = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  // 2026-11-25T10:00:00Z = 15:30 IST. IST midnight that day = 2026-11-24T18:30:00Z.
  const NOW = "2026-11-25T10:00:00.000Z";
  const IST_MIDNIGHT = "2026-11-24T18:30:00.000Z";

  it("counts retained rows at the inclusive IST-midnight start boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    mockDb.jobs = [{ id: "at-ist-midnight", created_at: IST_MIDNIGHT }];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    expect((await res.json()).jobsToday).toBe(1);
  });

  it("excludes a row 1 ms before IST midnight, and a row created after query start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    mockDb.jobs = [
      { id: "just-before-ist-midnight", created_at: "2026-11-24T18:29:59.999Z" },
      { id: "after-query-start", created_at: "2026-11-25T10:00:00.001Z" },
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(0);
  });

  it("uses the IST day, not the UTC day: 00:10 IST counts rows from after IST midnight and drops the previous IST day's rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T18:40:00.000Z")); // 26 Nov 00:10 IST, still 25 Nov UTC
    mockDb.jobs = [
      { id: "ist-today", created_at: "2026-11-25T18:35:00.000Z" },
      { id: "ist-yesterday-but-utc-today", created_at: "2026-11-25T12:00:00.000Z" },
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(1);
  });

  it("IST rollover across month, year and leap boundaries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cases: Array<[string, string]> = [
      ["2026-12-31T20:00:00.000Z", "2026-12-31T18:30:00.000Z"], // 1 Jan 2027 01:30 IST
      ["2026-02-28T19:00:00.000Z", "2026-02-28T18:30:00.000Z"], // 1 Mar 2026 00:30 IST
      ["2028-02-28T19:00:00.000Z", "2028-02-28T18:30:00.000Z"], // 29 Feb 2028 00:30 IST (leap day)
    ];
    for (const [now, midnight] of cases) {
      vi.setSystemTime(new Date(now));
      mockDb.jobs = [
        { id: "in", created_at: midnight },
        { id: "out", created_at: new Date(new Date(midnight).getTime() - 1).toISOString() },
      ];
      const res = await GET(new Request("https://careermonke.com/api/stats"));
      expect((await res.json()).jobsToday).toBe(1);
    }
  });

  it("counts ALL retained rows: no active, status or source filter (matches the owner-run 4,530 / 965 counts)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const base = { created_at: "2026-11-25T05:00:00.000Z" };
    mockDb.jobs = [
      { ...base, id: "active", is_active: true, status: "active", source_type: "greenhouse" },
      { ...base, id: "inactive", is_active: false, status: "active" },
      { ...base, id: "closed", is_active: true, status: "closed" },
      { ...base, id: "jobspy", is_active: true, status: "active", source_type: HIDDEN_SOURCE_TYPE },
      { ...base, id: "null-fields" },
    ];
    // jobs_public holds a smaller visible set; it must not influence the count.
    mockDb.jobsPublic = [{ ...base, id: "active", is_active: true, status: "active" }];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(5);
    expect(mockDb.orFilters).not.toContain(VISIBLE_SOURCE_FILTER);
    expect(mockDb.tables[0]).toBe("jobs");
  });

  it("excludes old jobs refreshed today (last_seen_at refreshed but created_at is old)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    mockDb.jobs = [
      { id: "old-job-refreshed", created_at: "2026-11-20T00:00:00.000Z", last_seen_at: NOW, updated_at: NOW },
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(0);
  });

  it("counts rows, not unique vacancies: one role on two boards counts twice (metric qualification)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const base = { created_at: "2026-11-25T05:00:00.000Z", dedupe_hash: "same-role-hash" };
    mockDb.jobs = [
      { ...base, id: "board-a-row", source_id: "board-a", source_job_id: "42" },
      { ...base, id: "board-b-row", source_id: "board-b", source_job_id: "777" },
    ];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect((await res.json()).jobsToday).toBe(2);
  });

  it("concurrent requests share ONE in-flight count query (single-flight)", async () => {
    mockDb.jobs = [{ id: "a", created_at: new Date(Date.now() - 1000).toISOString() }];
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => GET(new Request("https://careermonke.com/api/stats"))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(mockDb.jobsQueries).toBe(1);
  });

  it("a count that hangs hits the server deadline: aborted, 503 no-store, and the failure is not cached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockDb.hang = true;
    const pending = GET(new Request("https://careermonke.com/api/stats"));
    await vi.advanceTimersByTimeAsync(RETAINED_COUNT_DEADLINE_MS + 10);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockDb.signals[0]?.aborted).toBe(true);
    // next request runs a fresh query (failure not cached, in-flight slot released)
    mockDb.hang = false;
    mockDb.jobs = [{ id: "a", created_at: new Date(Date.now() - 1000).toISOString() }];
    const ok = await GET(new Request("https://careermonke.com/api/stats"));
    expect(ok.status).toBe(200);
    expect(mockDb.jobsQueries).toBe(2);
  });

  it("anonymous response never leaks row fields: body is exactly { jobsToday, updatedAt }", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    mockDb.jobs = [{ id: "secret-id", created_at: "2026-11-25T05:00:00.000Z", company: "Acme", apply_url: "https://x.example/job" }];
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["jobsToday", "updatedAt"]);
    expect(JSON.stringify(body)).not.toContain("secret-id");
    expect(JSON.stringify(body)).not.toContain("Acme");
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
    mockDb.jobs = [{ id: "job-1", created_at: now.toISOString() }];
    mockDb.jobs[0].created_at = new Date(now.getTime() - 1000).toISOString();

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
    mockDb.jobs = [{ id: "job-1", created_at: new Date(now.getTime() - 1000).toISOString() }];
    mockDb.jobsPublic = [{ id: "job-1", created_at: now.toISOString(), is_active: true, status: "active", source: "greenhouse" }];
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
