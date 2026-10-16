import { spawnSync } from "child_process";
import {
  fetchAllAdminUsers,
  fetchAllSubscriptions,
  fetchAllBlockedUsers,
  fetchUserPageViewsCount,
  getAnalyticsStats,
  getUsersManagementList,
  getUserActivityLogs,
  ADMIN_USERS_PAGE_CAP,
  ADMIN_USERS_PER_PAGE,
  DB_CHUNK_SIZE,
} from "../src/lib/admin/analytics";

// If invoked with --negative-control, run the failing single-page assert and exit non-zero
if (process.argv.includes("--negative-control")) {
  console.log("[NEGATIVE CONTROL] Running legacy single-page reader on 120-user mock...");
  const mockUsers = Array.from({ length: 120 }, (_, i) => ({
    id: `user-${i + 1}`,
    email: `user${i + 1}@example.com`,
    created_at: new Date(Date.now() - i * 100000).toISOString(),
    user_metadata: {},
  }));

  const mockClient = {
    auth: {
      admin: {
        listUsers: async (params?: { page?: number; perPage?: number }) => {
          const page = params?.page ?? 1;
          const perPage = params?.perPage ?? 50;
          // Legacy single-page behaviour: returns only page 1 (50 items)
          const start = (page - 1) * perPage;
          return {
            data: { users: mockUsers.slice(start, start + perPage) },
            error: null,
          };
        },
      },
    },
  };

  // Legacy single-page read
  const res = mockClient.auth.admin.listUsers();
  res.then(({ data }) => {
    const count = data?.users.length || 0;
    console.log(`[NEGATIVE CONTROL] Legacy single-page returned: ${count} users`);
    if (count !== 120) {
      console.error(`[NEGATIVE CONTROL INTENDED FAILURE] Expected 120 users but got ${count}. Exiting non-zero.`);
      process.exit(1);
    }
    process.exit(0);
  });
} else {
  runSuite();
}

async function runSuite() {
  console.log("================================================================================");
  console.log("TEST SUITE: ADMIN ANALYTICS BOUNDED READS & PAGINATION VERIFICATION");
  console.log("================================================================================\n");

  let passes = 0;
  let total = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    total++;
    if (condition) {
      passes++;
      console.log(`[PASS] ${testName}`);
    } else {
      console.error(`[FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: 120 users over 3 pages (50, 50, 20) -> Assert total is 120
  // ---------------------------------------------------------------------------
  console.log("--- 1. PAGINATED USER FETCHING (120 USERS ACROSS 3 PAGES) ---");
  const mock120Users = Array.from({ length: 120 }, (_, i) => ({
    id: `user-${i + 1}`,
    email: `user${i + 1}@example.com`,
    created_at: new Date(1700000000000 - i * 60000).toISOString(),
    last_sign_in_at: new Date(1700000000000 - i * 30000).toISOString(),
    user_metadata: {},
  }));

  const requestedPages: number[] = [];
  const mockUserClient = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page?: number; perPage?: number }) => {
          const p = page ?? 1;
          const limit = perPage ?? 50;
          requestedPages.push(p);
          const start = (p - 1) * limit;
          const slice = mock120Users.slice(start, start + limit);
          return { data: { users: slice }, error: null };
        },
      },
    },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        range: async (_from: number, _to: number) => ({ data: [], error: null }),
      }),
    }),
  };

  const usersResult = await fetchAllAdminUsers(mockUserClient);
  assert(usersResult.length === 120, `fetchAllAdminUsers returns all 120 users (got ${usersResult.length})`);
  assert(
    requestedPages.length === 3 && requestedPages[0] === 1 && requestedPages[1] === 2 && requestedPages[2] === 3,
    `fetchAllAdminUsers fetched exactly 3 pages [${requestedPages.join(", ")}]`
  );

  // Negative control verification via child process
  console.log("--- 1b. NEGATIVE CONTROL PROOF (SINGLE-PAGE READER EXITS NON-ZERO) ---");
  const negResult = spawnSync("npx", ["tsx", "scripts/test-admin-analytics-reads.ts", "--negative-control"], {
    encoding: "utf-8",
    shell: true,
  });
  assert(
    negResult.status !== 0,
    `Negative control exited non-zero as expected (exit code: ${negResult.status})`
  );
  console.log(`[RAW NEGATIVE CONTROL OUTPUT]:\n${negResult.stdout.trim()}\n${negResult.stderr.trim()}`);

  // ---------------------------------------------------------------------------
  // TEST 2: Page count exceeding hard cap -> Throws error
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. HARD CAP PROTECTION ON USER LISTING ---");
  let infinitePagesCalled = 0;
  const mockInfiniteClient = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page?: number; perPage?: number }) => {
          infinitePagesCalled++;
          // Never returns a short page; always returns 50 users
          const dummy = Array.from({ length: perPage || 50 }, (_, i) => ({
            id: `infinite-user-p${page}-${i}`,
            email: `inf-p${page}-${i}@example.com`,
          }));
          return { data: { users: dummy }, error: null };
        },
      },
    },
  };

  let capErrorThrown = false;
  let capErrorMessage = "";
  try {
    // Testing with custom low maxPages to verify safety cap
    await fetchAllAdminUsers(mockInfiniteClient, { maxPages: 5, perPage: 50 });
  } catch (err: any) {
    capErrorThrown = true;
    capErrorMessage = err.message || "";
  }
  assert(capErrorThrown, "fetchAllAdminUsers throws error when page count exceeds hard cap");
  assert(
    capErrorMessage.includes("Safety cap of 5 pages"),
    `Error message references safety cap limit (${capErrorMessage})`
  );
  assert(infinitePagesCalled === 5, `Loop stopped immediately at cap limit (called ${infinitePagesCalled} times)`);

  // Also verify default cap constant
  assert(ADMIN_USERS_PAGE_CAP === 200, `Default ADMIN_USERS_PAGE_CAP is 200 (max 10,000 users at 50/page)`);

  // ---------------------------------------------------------------------------
  // TEST 3: 2500 subscriptions across 3 chunks (1000, 1000, 500)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. CHUNKED SUBSCRIPTIONS FETCHING (2500 ROWS OVER 3 CHUNKS) ---");
  const mock2500Subs = Array.from({ length: 2500 }, (_, i) => ({
    user_id: `user-${i + 1}`,
    status: i % 2 === 0 ? "active" : "canceled",
    current_period_end: new Date(Date.now() + 86400000).toISOString(),
  }));

  const subsRangesRequested: Array<{ from: number; to: number }> = [];
  const mockSubsClient = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        range: async (from: number, to: number) => {
          subsRangesRequested.push({ from, to });
          const slice = mock2500Subs.slice(from, to + 1);
          return { data: slice, error: null };
        },
      }),
    }),
  };

  const subsResult = await fetchAllSubscriptions(mockSubsClient);
  assert(subsResult.length === 2500, `fetchAllSubscriptions returned all 2500 rows (got ${subsResult.length})`);
  assert(
    subsRangesRequested.length === 3,
    `Subscriptions fetched in exactly 3 chunks (got ${subsRangesRequested.length})`
  );
  assert(
    subsRangesRequested[0].from === 0 && subsRangesRequested[0].to === 999 &&
    subsRangesRequested[1].from === 1000 && subsRangesRequested[1].to === 1999 &&
    subsRangesRequested[2].from === 2000 && subsRangesRequested[2].to === 2999,
    `Range bounds match expected chunks: [0..999], [1000..1999], [2000..2999]`
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Assert query strings sent to .select(...) do NOT contain '*'
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. SELECT COLUMN QUERY STRING AUDIT (ZERO SELECT '*') ---");
  const interceptedSelectQueries: Array<{ table: string; columns: string }> = [];

  const auditMockClient = {
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: mock120Users.slice(0, 10) },
          error: null,
        }),
        getUserById: async (id: string) => ({
          data: { user: mock120Users[0] },
          error: null,
        }),
      },
    },
    from: (table: string) => ({
      select: (columns: string) => {
        interceptedSelectQueries.push({ table, columns });
        return {
          range: async (_from: number, _to: number) => ({ data: [], error: null }),
          gte: (_col: string, _val: any) => ({
            order: (_col2: string, _opts: any) => ({
              range: async (_from: number, _to: number) => ({ data: [], error: null }),
            }),
          }),
          eq: (_col: string, _val: any) => ({
            order: (_col2: string, _opts: any) => ({
              limit: async (_n: number) => ({ data: [], error: null }),
            }),
          }),
        };
      },
    }),
  };

  // Run all functions through audit client
  await fetchAllSubscriptions(auditMockClient);
  await fetchAllBlockedUsers(auditMockClient);
  await fetchUserPageViewsCount(auditMockClient);
  await getAnalyticsStats(7, auditMockClient);
  await getUsersManagementList(undefined, auditMockClient);
  await getUserActivityLogs("user-1", auditMockClient);

  console.log(`Intercepted ${interceptedSelectQueries.length} database .select(...) queries:`);
  let hasWildcard = false;
  for (const q of interceptedSelectQueries) {
    const isWild = q.columns.includes("*");
    console.log(`  Table: ${q.table.padEnd(16)} | Select: "${q.columns}" ${isWild ? "[WILDCARD!]" : "[PRUNED]"}`);
    if (isWild) hasWildcard = true;
  }

  assert(!hasWildcard, "Zero queries in analytics.ts send '*' to .select(...)");
  assert(interceptedSelectQueries.length >= 6, `At least 6 distinct select queries audited (got ${interceptedSelectQueries.length})`);

  // ---------------------------------------------------------------------------
  // TEST 5: Parity with old function output on a 10-user fixture
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. FIDELITY & PARITY ON 10-USER FIXTURE ---");
  const fixture10Users = Array.from({ length: 10 }, (_, i) => ({
    id: `fix-user-${i + 1}`,
    email: `fixture${i + 1}@careermonke.test`,
    created_at: new Date(1700000000000 - i * 100000).toISOString(),
    last_sign_in_at: new Date(1700000000000 - i * 50000).toISOString(),
    banned_until: i === 3 ? new Date(Date.now() + 86400000).toISOString() : null,
    user_metadata: {
      is_pro: i === 1,
      is_blocked: i === 7,
      blocked_at: i === 7 ? "2026-10-10T00:00:00Z" : undefined,
      blocked_reason: i === 7 ? "TOS violation" : undefined,
    },
  }));

  const fixtureSubs = [
    { user_id: "fix-user-1", status: "active", current_period_end: new Date(Date.now() + 86400000).toISOString() },
    { user_id: "fix-user-5", status: "active", current_period_end: new Date(Date.now() + 86400000).toISOString() },
    { user_id: "fix-user-9", status: "canceled", current_period_end: new Date(Date.now() - 86400000).toISOString() },
  ];

  const fixtureBlocked = [
    { user_id: "fix-user-2", blocked_at: "2026-10-11T12:00:00Z", reason: "Spam account" },
  ];

  const fixturePageViews = [
    { path: "/jobs", user_id: "fix-user-1", ip_hash: "hash1", created_at: new Date().toISOString() },
    { path: "/jobs", user_id: "fix-user-1", ip_hash: "hash1", created_at: new Date().toISOString() },
    { path: "/radar", user_id: "fix-user-2", ip_hash: "hash2", created_at: new Date().toISOString() },
    { path: "/", user_id: null, ip_hash: "hash3", created_at: new Date().toISOString() },
  ];

  // Legacy reference implementation replicating original unpaginated code
  function legacyGetUsersManagementList(users: any[], subs: any[], blocked: any[], views: any[]) {
    const now = new Date();
    const activeSubs = new Set(
      subs
        .filter((s: any) => s.status === "active" && (!s.current_period_end || new Date(s.current_period_end) > now))
        .map((s: any) => s.user_id)
    );
    const blockedUsersMap = new Map<string, { blockedAt?: string; reason?: string }>();
    for (const b of blocked) {
      blockedUsersMap.set(b.user_id, { blockedAt: b.blocked_at, reason: b.reason });
    }
    const userViewsCount = new Map<string, number>();
    for (const v of views) {
      if (v.user_id) {
        userViewsCount.set(v.user_id, (userViewsCount.get(v.user_id) || 0) + 1);
      }
    }

    return users.map((u) => {
      const isPro = activeSubs.has(u.id) || u.user_metadata?.is_pro === true;
      const blockedRecord = blockedUsersMap.get(u.id);
      const isBlocked =
        Boolean(u.banned_until && new Date(u.banned_until) > now) ||
        u.user_metadata?.is_blocked === true ||
        Boolean(blockedRecord);

      return {
        id: u.id,
        email: u.email || "anonymous",
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at,
        isPro,
        isBlocked,
        totalViews: userViewsCount.get(u.id) || 0,
        blockedAt: blockedRecord?.blockedAt || u.user_metadata?.blocked_at,
        blockedReason: blockedRecord?.reason || u.user_metadata?.blocked_reason,
      };
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Client providing the fixture
  const fixtureClient = {
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: fixture10Users },
          error: null,
        }),
      },
    },
    from: (table: string) => ({
      select: (_cols: string) => ({
        range: async (from: number, to: number) => {
          if (table === "subscriptions") return { data: fixtureSubs.slice(from, to + 1), error: null };
          if (table === "blocked_users") return { data: fixtureBlocked.slice(from, to + 1), error: null };
          if (table === "page_views") return { data: fixturePageViews.slice(from, to + 1), error: null };
          return { data: [], error: null };
        },
        gte: (_col: string, _val: any) => ({
          order: (_col2: string, _opts: any) => ({
            range: async (from: number, to: number) => ({
              data: fixturePageViews.slice(from, to + 1),
              error: null,
            }),
          }),
        }),
      }),
    }),
  };

  const expectedUsersOutput = legacyGetUsersManagementList(fixture10Users, fixtureSubs, fixtureBlocked, fixturePageViews);
  const actualUsersOutput = await getUsersManagementList(undefined, fixtureClient);

  assert(
    JSON.stringify(actualUsersOutput) === JSON.stringify(expectedUsersOutput),
    "New getUsersManagementList output matches legacy implementation with 100% fidelity"
  );

  console.log(`\n10-User Fixture Results Sample (first 3 users):`);
  console.log(JSON.stringify(actualUsersOutput.slice(0, 3), null, 2));

  console.log("\n================================================================================");
  console.log(`ADMIN ANALYTICS BOUNDED READS TESTS COMPLETE: ${passes}/${total} CHECKS PASSED (100%)`);
  console.log("================================================================================");
}
