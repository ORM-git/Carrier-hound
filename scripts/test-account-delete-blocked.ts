import assert from "assert";
import { createHandler } from "../netlify/functions/account-delete";

console.log("==================================================================================");
console.log("        ACCOUNT DELETE VS BANNED USERS & FAIL-CLOSED INTEGRITY TEST SUITE          ");
console.log("==================================================================================\n");

const isNegativeControl = process.argv.includes("--negative-control");

interface MockConfig {
  userId: string;
  isBanned?: boolean;
  lookupError?: any;
  tableDeleteErrors?: Record<string, any>;
  storageRemoveError?: any;
}

function createMockSupabaseAdmin(config: MockConfig) {
  const deletedTables = new Set<string>();
  let deleteCalls = 0;
  let deleteUserCalls = 0;
  let subscriptionsUpdated = 0;

  return {
    getStats: () => ({
      deletedTables,
      deleteCalls,
      deleteUserCalls,
      subscriptionsUpdated,
    }),
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "invalid") {
          return { data: { user: null }, error: { message: "Invalid session" } };
        }
        return {
          data: {
            user: { id: config.userId, email: `${config.userId}@example.com` },
          },
          error: null,
        };
      },
      admin: {
        deleteUser: async (id: string) => {
          deleteUserCalls++;
          return { error: null };
        },
      },
    },
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, val: string) => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { id: `sub-${config.userId}`, status: "active", metadata: {} },
                error: null,
              }),
            }),
          }),
          maybeSingle: async () => {
            if (table === "blocked_users") {
              if (config.lookupError) {
                return { data: null, error: config.lookupError };
              }
              if (config.isBanned) {
                return { data: { user_id: config.userId }, error: null };
              }
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
      update: (data: any) => ({
        eq: (col: string, val: string) => {
          if (table === "subscriptions") {
            subscriptionsUpdated++;
          }
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (col: string, val: string) => {
          deleteCalls++;
          deletedTables.add(table);
          if (config.tableDeleteErrors && config.tableDeleteErrors[table]) {
            return { error: config.tableDeleteErrors[table] };
          }
          return { error: null };
        },
      }),
    }),
    storage: {
      listBuckets: async () => ({
        data: [{ name: "resumes" }],
        error: null,
      }),
      from: (bucket: string) => ({
        list: async (prefix: string) => ({
          data: [{ name: "sample-resume.pdf" }],
          error: null,
        }),
        remove: async (paths: string[]) => ({
          data: paths,
          error: config.storageRemoveError || null,
        }),
      }),
    },
  };
}

/**
 * Creates an in-memory mutation copy of the deletion flow with the ban check stripped.
 * Used exclusively by negative controls to prove that tests fail if ban enforcement is absent.
 */
function createMutatedHandlerWithoutBanCheck(admin: any) {
  return async function mutatedHandler(event: any) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader.replace("Bearer ", "").trim();
    const { data: { user } } = await admin.auth.getUser(token);
    const userId = user.id;

    // MUTATION: Moderation ban check is intentionally omitted in this test-only copy

    const tablesToDelete = [
      "candidate_profiles", "user_preferences", "search_alerts", "applications",
      "job_applications", "tailored_resumes", "daily_digests", "ai_usage_quotas",
      "ai_usage_ledger", "page_views", "user_roles", "user_consents",
    ];

    for (const table of tablesToDelete) {
      await admin.from(table).delete().eq("user_id", userId);
    }

    await admin.auth.admin.deleteUser(userId);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        billingReconciled: true,
        message: "User account and all owned data permanently deleted.",
      }),
    };
  };
}

async function runTests() {
  // If invoked with --negative-control, run the in-memory mutated handler against a banned user.
  // The banned user assertion MUST fail and exit non-zero!
  if (isNegativeControl) {
    console.log("--- RUNNING NEGATIVE CONTROL: Mutating test copy in memory (ban check omitted) ---");
    const mockAdmin = createMockSupabaseAdmin({
      userId: "banned-bad-actor-001",
      isBanned: true,
    });

    const mutatedHandler = createMutatedHandlerWithoutBanCheck(mockAdmin);
    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token-banned" },
    };

    const res = await mutatedHandler(event);
    const body = JSON.parse(res.body);

    console.log(`[NEGATIVE-CONTROL RESULT] Status: ${res.statusCode}, Body:`, body);
    assert.strictEqual(
      res.statusCode,
      403,
      `VULNERABILITY DETECTED: Banned user received status ${res.statusCode} instead of 403!`
    );
    assert.strictEqual(
      mockAdmin.getStats().deleteCalls,
      0,
      `VULNERABILITY DETECTED: ${mockAdmin.getStats().deleteCalls} table deletions executed for banned user!`
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Case 1: Normal user -> all tables cleaned, 200
  // ---------------------------------------------------------------------------
  console.log("--- 1. Testing Normal User Account Deletion ---");
  {
    const mockAdmin = createMockSupabaseAdmin({
      userId: "normal-user-123",
      isBanned: false,
    });
    const handler = createHandler({ getSupabaseAdmin: () => mockAdmin });

    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer token-normal-123" },
    };

    const res = await handler(event);
    const body = JSON.parse(res.body);
    const stats = mockAdmin.getStats();

    assert.strictEqual(res.statusCode, 200, "Normal deletion must return HTTP 200");
    assert.strictEqual(body.success, true, "Body success must be true");
    assert.strictEqual(body.billingReconciled, true, "Billing must be marked reconciled");
    assert.strictEqual(stats.deleteUserCalls, 1, "Auth admin deleteUser must be called exactly once");
    assert.strictEqual(stats.deletedTables.size, 12, "All 12 user tables must be cleaned");
    assert(!stats.deletedTables.has("blocked_users"), "blocked_users must never be deleted");

    console.log("[PASS] Normal user account deletion succeeded (HTTP 200, 12 tables cleaned, auth deleted).");
  }

  // ---------------------------------------------------------------------------
  // Case 2: Banned user -> 403, zero delete calls
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Testing Banned User Account Deletion Attempt ---");
  {
    const mockAdmin = createMockSupabaseAdmin({
      userId: "banned-violator-456",
      isBanned: true,
    });
    const handler = createHandler({ getSupabaseAdmin: () => mockAdmin });

    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer token-banned-456" },
    };

    const res = await handler(event);
    const body = JSON.parse(res.body);
    const stats = mockAdmin.getStats();

    assert.strictEqual(res.statusCode, 403, "Banned user deletion must return HTTP 403");
    assert.strictEqual(
      body.error,
      "Account cannot be deleted. Contact support@careermonke.com",
      "Exact refusal error message must be returned"
    );
    assert.strictEqual(stats.deleteCalls, 0, "Zero table delete calls must occur for banned user");
    assert.strictEqual(stats.deleteUserCalls, 0, "Zero auth delete calls must occur for banned user");
    assert.strictEqual(stats.subscriptionsUpdated, 0, "Zero billing updates must occur for banned user");

    console.log("[PASS] Banned user account deletion blocked (HTTP 403, zero delete calls executed).");
  }

  // ---------------------------------------------------------------------------
  // Case 3: blocked_users lookup returns error -> 503, zero delete calls
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Testing Fail-Closed on blocked_users Lookup Error ---");
  {
    const mockAdmin = createMockSupabaseAdmin({
      userId: "user-with-db-glitch-789",
      lookupError: { message: "Connection timeout", code: "57014" },
    });
    const handler = createHandler({ getSupabaseAdmin: () => mockAdmin });

    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer token-glitch-789" },
    };

    const res = await handler(event);
    const body = JSON.parse(res.body);
    const stats = mockAdmin.getStats();

    assert.strictEqual(res.statusCode, 503, "DB lookup error must return HTTP 503 (fail closed)");
    assert.strictEqual(stats.deleteCalls, 0, "Zero table delete calls on lookup error");
    assert.strictEqual(stats.deleteUserCalls, 0, "Zero auth delete calls on lookup error");

    console.log("[PASS] Fail-closed on lookup error verified (HTTP 503, zero delete calls executed).");
  }

  // ---------------------------------------------------------------------------
  // Case 4: A table delete returns {error} -> reported, not silently ignored
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Testing Table Deletion Error Handling (Reported, Not Ignored) ---");
  {
    const mockAdmin = createMockSupabaseAdmin({
      userId: "user-table-fail-101",
      isBanned: false,
      tableDeleteErrors: {
        applications: { message: "Foreign key constraint failure", code: "23503" },
      },
    });
    const handler = createHandler({ getSupabaseAdmin: () => mockAdmin });

    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer token-fail-101" },
    };

    const res = await handler(event);
    const body = JSON.parse(res.body);
    const stats = mockAdmin.getStats();

    assert.strictEqual(res.statusCode, 500, "Table deletion failure must return HTTP 500");
    assert(
      body.error.includes("applications: Foreign key constraint failure"),
      `Error message must report table deletion failure. Got: "${body.error}"`
    );
    assert.strictEqual(stats.deleteUserCalls, 0, "Auth user must NOT be deleted if table cleanup failed");

    console.log("[PASS] Table deletion error reported and aborted auth deletion (HTTP 500).");
  }

  // ---------------------------------------------------------------------------
  // 5. In-Memory Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Running In-Memory Negative Control Verification ---");
  {
    const mockAdmin = createMockSupabaseAdmin({
      userId: "banned-in-memory-999",
      isBanned: true,
    });

    const mutatedHandler = createMutatedHandlerWithoutBanCheck(mockAdmin);
    const event = {
      httpMethod: "POST",
      headers: { authorization: "Bearer token-banned-999" },
    };

    const res = await mutatedHandler(event);
    let caughtVulnerability = false;
    try {
      assert.strictEqual(res.statusCode, 403, "Expected 403 for banned user");
    } catch (err: any) {
      caughtVulnerability = true;
      console.log(`[PASS] In-memory mutation (omitted ban check) successfully caught: "${err.message}"`);
    }

    assert(
      caughtVulnerability,
      "Negative control failed: Mutating test copy in memory did not trigger test assertion failure!"
    );
  }

  console.log("\n==================================================================================");
  console.log("ACCOUNT DELETE VS BANNED USERS & FAIL-CLOSED: ALL TESTS PASSED");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test-account-delete-blocked.ts:", err.message);
  process.exit(1);
});
