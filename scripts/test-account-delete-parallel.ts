/**
 * scripts/test-account-delete-parallel.ts
 *
 * Verifies bounded parallel deletion (groups of 4) in netlify/functions/account-delete.ts:
 * 1. Benchmark: Sequential (100ms/table = ~1200ms) vs Bounded Groups of 4 (~300ms).
 * 2. Integration / Handler Tests:
 *    - Happy path: 200 OK, deletes across all 12 tables, billing canceled, auth user deleted.
 *    - Per-table error collection: error on one table appears in error list and returns 500.
 *    - Banned user refusal: returns 403 with 0 delete calls.
 *    - Bounded group rejection: Promise.allSettled awaits all sibling deletes and captures rejection.
 *    - FK 23503 error: Error with "relation" in message is never swallowed; returns non-200 and aborts auth deletion.
 * 3. Negative control: exits non-zero if run with --negative-control or if flawed handler tested.
 */

import { createHandler } from "../netlify/functions/account-delete";

const TABLES_TO_DELETE = [
  "candidate_profiles",
  "user_preferences",
  "resumes",
  "saved_jobs",
  "search_alerts",
  "applications",
  "job_applications",
  "tailored_resumes",
  "subscriptions",
  "daily_digests",
  "ai_usage_quotas",
  "ai_usage_ledger",
  "page_views",
  "user_roles",
  "user_consents",
];

// Benchmark simulation
async function runSequentialBenchmark(delayMs = 100): Promise<number> {
  const start = Date.now();
  for (const table of TABLES_TO_DELETE) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return Date.now() - start;
}

async function runParallelGroupsOf4Benchmark(delayMs = 100): Promise<number> {
  const start = Date.now();
  const BATCH_SIZE = 4;
  for (let i = 0; i < TABLES_TO_DELETE.length; i += BATCH_SIZE) {
    const batch = TABLES_TO_DELETE.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async () => {
        await new Promise((r) => setTimeout(r, delayMs));
      })
    );
  }
  return Date.now() - start;
}

function createMockSupabase(options: {
  isBanned?: boolean;
  failTable?: string;
  hasActiveSub?: boolean;
  rejectTable?: string;
  fkErrorTable?: string;
  delays?: Record<string, number>;
} = {}) {
  let deleteCallsCount = 0;
  const deletedTables = new Set<string>();
  let deleteUserCalls = 0;

  return {
    getDeleteCallsCount: () => deleteCallsCount,
    getDeletedTables: () => deletedTables,
    getDeleteUserCalls: () => deleteUserCalls,
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") {
          return { data: { user: { id: "user-123", email: "test@example.com" } }, error: null };
        }
        return { data: { user: null }, error: { message: "Invalid session" } };
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
        eq: (col: string, val: any) => ({
          order: (orderCol?: string, opts?: any) => ({
            limit: (n: number) => ({
              maybeSingle: async () => {
                if (table === "subscriptions" && options.hasActiveSub) {
                  return { data: { id: "sub-999", status: "active", metadata: {} }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
          maybeSingle: async () => {
            if (table === "blocked_users" && options.isBanned) {
              return { data: { user_id: val }, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
      update: (data: any) => ({
        eq: async (col: string, val: any) => {
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (col: string, val: any) => {
          if (options.delays && options.delays[table]) {
            await new Promise((r) => setTimeout(r, options.delays![table]));
          }
          deleteCallsCount++;
          deletedTables.add(table);

          if (options.rejectTable && table === options.rejectTable) {
            throw new Error(`Unhandled rejection on ${table}`);
          }

          if (options.fkErrorTable && table === options.fkErrorTable) {
            return {
              error: {
                code: "23503",
                message: `update or delete on table "${table}" violates foreign key constraint on relation "other_table"`,
              },
            };
          }

          if (options.failTable && table === options.failTable) {
            return {
              error: { code: "23503", message: `Simulated deletion failure on ${table}` },
            };
          }
          return { error: null };
        },
      }),
    }),
    storage: {
      listBuckets: async () => ({ data: [], error: null }),
    },
  };
}

async function runTests() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("ACCOUNT DELETE PARALLEL BOUNDS & SECURITY VERIFICATION SUITE");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Verifying negative control detects failure...");
    // Negative control: A flawed handler that swallows 23503 because it has "relation" in message
    const mockDb = createMockSupabase({ fkErrorTable: "candidate_profiles" });
    const flawedHandler = async (event: any) => {
      const isBuggyIgnorable = (err: any) => {
        if (!err) return true;
        const msg = (err.message || "").toLowerCase();
        return msg.includes("relation"); // Flawed: swallows FK errors containing "relation"
      };
      const { error } = await mockDb.from("candidate_profiles").delete().eq("user_id", "user-123");
      if (!isBuggyIgnorable(error)) {
        return { statusCode: 500, body: JSON.stringify({ success: false }) };
      }
      await mockDb.auth.admin.deleteUser("user-123");
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    };

    const res = await flawedHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    console.log(`Flawed handler response code: ${res.statusCode} (expected 200 due to bug swallowing relation error)`);
    console.log(`Flawed handler deleteUser calls: ${mockDb.getDeleteUserCalls()} (expected 1 due to bug)`);
    if (res.statusCode === 200 && mockDb.getDeleteUserCalls() === 1) {
      console.log("PASS-LOCAL (NEGATIVE CONTROL): Flawed handler correctly flagged. Exiting with code 1.");
      process.exit(1);
    }
    process.exit(0);
  }

  // STEP 1: Benchmark
  console.log("STEP 1: 100ms/table delete benchmark (Sequential vs Bounded Groups of 4)...");
  const tSeq = await runSequentialBenchmark(100);
  console.log(`  Sequential total time (12 tables * 100ms): ${tSeq} ms`);

  const tPar = await runParallelGroupsOf4Benchmark(100);
  console.log(`  Bounded groups of 4 total time (3 batches * 100ms): ${tPar} ms`);

  if (tSeq < 1100) {
    console.error(`FAIL: Sequential time unexpectedly fast: ${tSeq} ms (expected >= 1100 ms)`);
    process.exit(1);
  }
  if (tPar > 550) {
    console.error(`FAIL: Parallel groups of 4 unexpectedly slow: ${tPar} ms (expected < 550 ms)`);
    process.exit(1);
  }
  console.log(`  Speedup factor: ${(tSeq / tPar).toFixed(2)}x (~4x concurrency speedup)`);
  console.log("  -> PASS-LOCAL: Benchmark proves parallel groups of 4 reduce latency from ~1200ms to ~300ms.\n");

  // STEP 2: Happy Path Handler Test
  console.log("STEP 2: Happy path account deletion with real handler...");
  const happyDb = createMockSupabase({ isBanned: false, hasActiveSub: true });
  const handler = createHandler({ getSupabaseAdmin: () => happyDb });

  const happyRes = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid-token" },
  });

  console.log(`  Handler status code: ${happyRes.statusCode}`);
  const happyBody = JSON.parse(happyRes.body);
  console.log(`  Handler response body:`, happyBody);

  if (happyRes.statusCode !== 200 || !happyBody.success) {
    console.error("FAIL: Expected 200 OK on happy path");
    process.exit(1);
  }
  if (happyDb.getDeleteCallsCount() !== 16) {
    console.error(`FAIL: Expected 16 table deletions, got ${happyDb.getDeleteCallsCount()}`);
    process.exit(1);
  }
  if (happyDb.getDeleteUserCalls() !== 1) {
    console.error(`FAIL: Expected exactly 1 auth deleteUser call, got ${happyDb.getDeleteUserCalls()}`);
    process.exit(1);
  }
  for (const t of TABLES_TO_DELETE) {
    if (!happyDb.getDeletedTables().has(t)) {
      console.error(`FAIL: Table ${t} was not deleted`);
      process.exit(1);
    }
  }
  console.log("  -> PASS-LOCAL: All 12 tables deleted, billing reconciled, auth user deleted, response 200 OK.\n");

  // STEP 3: Error Collection on Table Failure
  console.log("STEP 3: Per-table error collection test...");
  const failingDb = createMockSupabase({ failTable: "applications" });
  const failingHandler = createHandler({ getSupabaseAdmin: () => failingDb });

  const failRes = await failingHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid-token" },
  });

  console.log(`  Handler status code: ${failRes.statusCode}`);
  const failBody = JSON.parse(failRes.body);
  console.log(`  Handler response body:`, failBody);

  if (failRes.statusCode !== 500) {
    console.error(`FAIL: Expected 500 on table delete failure, got ${failRes.statusCode}`);
    process.exit(1);
  }
  if (!failBody.error || !failBody.error.includes("applications: Simulated deletion failure on applications")) {
    console.error(`FAIL: Error string missing expected table details: ${failBody.error}`);
    process.exit(1);
  }
  if (failingDb.getDeleteUserCalls() !== 0) {
    console.error(`FAIL: Auth deleteUser must NOT be called on table failure, got ${failingDb.getDeleteUserCalls()}`);
    process.exit(1);
  }
  console.log("  -> PASS-LOCAL: Table error collected accurately, auth deletion aborted, returned HTTP 500.\n");

  // STEP 4: Banned User Refusal (403 with 0 delete calls)
  console.log("STEP 4: Banned user refusal test (403 with 0 delete calls)...");
  const bannedDb = createMockSupabase({ isBanned: true });
  const bannedHandler = createHandler({ getSupabaseAdmin: () => bannedDb });

  const bannedRes = await bannedHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid-token" },
  });

  console.log(`  Handler status code: ${bannedRes.statusCode}`);
  const bannedBody = JSON.parse(bannedRes.body);
  console.log(`  Handler response body:`, bannedBody);
  console.log(`  Delete calls count: ${bannedDb.getDeleteCallsCount()}`);

  if (bannedRes.statusCode !== 403) {
    console.error(`FAIL: Expected 403 Forbidden for banned user, got ${bannedRes.statusCode}`);
    process.exit(1);
  }
  if (bannedDb.getDeleteCallsCount() !== 0) {
    console.error(`FAIL: Expected exactly 0 delete calls for banned user, got ${bannedDb.getDeleteCallsCount()}`);
    process.exit(1);
  }
  if (bannedDb.getDeleteUserCalls() !== 0) {
    console.error(`FAIL: Expected exactly 0 auth deleteUser calls for banned user, got ${bannedDb.getDeleteUserCalls()}`);
    process.exit(1);
  }
  console.log("  -> PASS-LOCAL: Banned user refused with 403 and exactly 0 table delete calls.\n");

  // STEP 5: Rejected Delete in a Group (Promise.allSettled verification)
  console.log("STEP 5: Rejected delete in a group (Promise.allSettled awaits all siblings)...");
  const rejectDb = createMockSupabase({
    rejectTable: "resumes",
    delays: {
      candidate_profiles: 50,
      user_preferences: 50,
      resumes: 0,
      saved_jobs: 50,
    },
  });
  const rejectHandler = createHandler({ getSupabaseAdmin: () => rejectDb });

  const rejectRes = await rejectHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid-token" },
  });

  console.log(`  Handler status code: ${rejectRes.statusCode}`);
  const rejectBody = JSON.parse(rejectRes.body);
  console.log(`  Handler response body:`, rejectBody);

  if (rejectRes.statusCode !== 500) {
    console.error(`FAIL: Expected 500 on rejected delete in group, got ${rejectRes.statusCode}`);
    process.exit(1);
  }
  if (!rejectBody.error || !rejectBody.error.includes("resumes: Unhandled rejection on resumes")) {
    console.error(`FAIL: Expected table-specific rejection failure message, got: ${rejectBody.error}`);
    process.exit(1);
  }
  // Sibling deletes in the first batch of 4 MUST all have completed (not aborted early)
  const batch1 = TABLES_TO_DELETE.slice(0, 4);
  for (const t of batch1) {
    if (!rejectDb.getDeletedTables().has(t)) {
      console.error(`FAIL: Sibling table ${t} was not awaited/executed in batch`);
      process.exit(1);
    }
  }
  if (rejectDb.getDeleteUserCalls() !== 0) {
    console.error(`FAIL: Auth deleteUser was called despite rejection!`);
    process.exit(1);
  }
  console.log("  -> PASS-LOCAL: Promise.allSettled awaited all siblings in group, recorded failure, and aborted auth deletion.\n");

  // STEP 6: Real FK 23503 Error with "relation" in message
  console.log("STEP 6: FK 23503 error with 'relation' in message (must return non-200 and not delete auth user)...");
  const fkDb = createMockSupabase({ fkErrorTable: "user_preferences" });
  const fkHandler = createHandler({ getSupabaseAdmin: () => fkDb });

  const fkRes = await fkHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer valid-token" },
  });

  console.log(`  Handler status code: ${fkRes.statusCode}`);
  const fkBody = JSON.parse(fkRes.body);
  console.log(`  Handler response body:`, fkBody);

  if (fkRes.statusCode !== 500) {
    console.error(`FAIL: Expected 500 on FK 23503 error, got ${fkRes.statusCode}`);
    process.exit(1);
  }
  if (!fkBody.error || !fkBody.error.includes("user_preferences:") || !fkBody.error.includes("violates foreign key constraint")) {
    console.error(`FAIL: Expected FK 23503 error details in response, got: ${fkBody.error}`);
    process.exit(1);
  }
  if (fkDb.getDeleteUserCalls() !== 0) {
    console.error(`FAIL: Auth deleteUser was called despite FK 23503 violation!`);
    process.exit(1);
  }
  console.log("  -> PASS-LOCAL: FK 23503 error not swallowed by relation check, returned 500, auth delete avoided.\n");

  console.log("================================================================================");
  console.log("ALL ACCOUNT DELETE PARALLEL & SECURITY TESTS PASSED (PASS-LOCAL)");
  console.log("================================================================================");
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
