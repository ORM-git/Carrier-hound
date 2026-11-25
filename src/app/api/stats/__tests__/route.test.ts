import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "../route";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

// In-memory mock database state
const mockDb = {
  jobsPublic: [] as Array<Record<string, any>>,
  companies: [] as Array<Record<string, any>>,
  queryError: null as any,
  queryCountOverride: null as number | null,
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
            if (filterStr === VISIBLE_SOURCE_FILTER) {
              // Simulates source filter: drops unapproved sources e.g. jobspy
              filters.push((r) => r.source !== "jobspy" && r.source_type !== "jobspy");
            }
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

  it("counts each canonical job once (no duplicate rows in query result)", async () => {
    const now = new Date();
    mockDb.jobsPublic = [
      {
        id: "canonical-job-1",
        created_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "greenhouse",
      },
      {
        id: "canonical-job-2",
        created_at: now.toISOString(),
        is_active: true,
        status: "active",
        source: "lever",
      },
    ];

    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobsToday).toBe(2);
  });

  it("excludes inactive, unapproved source or non-active status jobs", async () => {
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
        source: "jobspy", // Excluded by VISIBLE_SOURCE_FILTER
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

  it("returns 503 when count result is null or negative", async () => {
    mockDb.queryCountOverride = -1;
    const res = await GET(new Request("https://careermonke.com/api/stats"));
    expect(res.status).toBe(503);
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
