import assert from "assert";

console.log("=".repeat(80));
console.log("           SELF-SERVE DATA EXPORT ENDPOINT COVERAGE AUDIT        ");
console.log("=".repeat(80) + "\n");

process.env.NODE_ENV = "test";

const {
  handleAccountExportRequest,
  ACCOUNT_EXPORT_USER_ID_TABLES,
  ACCOUNT_EXPORT_EMAIL_TABLES,
} = require("../src/lib/account/exportHandler");
const {
  ACCOUNT_DELETE_USER_ID_TABLES,
} = require("../src/lib/account/deleteHandler");

function makeReq(token?: string) {
  return {
    headers: {
      get: (name: string) =>
        token && name.toLowerCase() === "authorization" ? `Bearer ${token}` : null,
    },
  } as any;
}

function createMockAdmin(opts: {
  user?: any;
  rows?: Record<string, any[]>;
  failTables?: string[];
}) {
  const queried: Array<{ table: string; column: string; value: string }> = [];
  const failTables = new Set(opts.failTables || []);
  return {
    queried,
    auth: {
      getUser: async () => ({ data: { user: opts.user || null }, error: opts.user ? null : { message: "bad token" } }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: string) => {
          queried.push({ table, column, value });
          if (failTables.has(table)) {
            return Promise.resolve({ data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } });
          }
          return Promise.resolve({ data: opts.rows?.[table] || [], error: null });
        },
      }),
    }),
    storage: {
      from: (_bucket: string) => ({
        list: async () => ({ data: [], error: null }),
      }),
    },
  };
}

const USER = { id: "user-123", email: "User@Example.com" };

async function main() {
  // 1. Missing header -> 401
  {
    const res = await handleAccountExportRequest(makeReq(), { getSupabaseAdmin: () => createMockAdmin({ user: USER }) });
    assert.strictEqual(res.status, 401, "missing auth header must be 401");
    console.log("ok - missing Authorization header returns 401");
  }

  // 2. Invalid token -> 401
  {
    const res = await handleAccountExportRequest(makeReq("bad"), { getSupabaseAdmin: () => createMockAdmin({ user: null }) });
    assert.strictEqual(res.status, 401, "invalid token must be 401");
    console.log("ok - invalid token returns 401");
  }

  // 3. Table coverage: every deletion-covered user_id table plus subscriptions
  {
    const admin = createMockAdmin({ user: USER, rows: { candidate_profiles: [{ id: 1 }] } });
    const res = await handleAccountExportRequest(makeReq("tok"), { getSupabaseAdmin: () => admin });
    assert.strictEqual(res.status, 200, "happy path must be 200");
    for (const table of ACCOUNT_DELETE_USER_ID_TABLES) {
      assert.ok(
        ACCOUNT_EXPORT_USER_ID_TABLES.includes(table),
        `export must cover deletion-owned table ${table}`
      );
      assert.ok(
        admin.queried.some((q: any) => q.table === table && q.column === "user_id" && q.value === USER.id),
        `export must query ${table} by user_id`
      );
    }
    assert.ok(
      admin.queried.some((q: any) => q.table === "subscriptions"),
      "export must include subscriptions rows"
    );
    console.log("ok - all user-owned tables queried by user_id, subscriptions included");
  }

  // 4. Early-access rows matched by lowercase email
  {
    const admin = createMockAdmin({ user: USER });
    await handleAccountExportRequest(makeReq("tok"), { getSupabaseAdmin: () => admin });
    for (const table of ACCOUNT_EXPORT_EMAIL_TABLES) {
      assert.ok(
        admin.queried.some((q: any) => q.table === table && q.column === "email" && q.value === "user@example.com"),
        `export must query ${table} by normalized email`
      );
    }
    console.log("ok - email-linked tables queried by normalized email");
  }

  // 5. Payload shape + download headers
  {
    const admin = createMockAdmin({ user: USER, rows: { saved_jobs: [{ job_id: "j1" }] } });
    const res = await handleAccountExportRequest(makeReq("tok"), { getSupabaseAdmin: () => admin });
    const body = await res.json();
    assert.strictEqual(body.export_version, 1);
    assert.strictEqual(body.user.id, USER.id);
    assert.deepStrictEqual(body.tables.saved_jobs, [{ job_id: "j1" }]);
    assert.ok(body.generated_at, "generated_at present");
    const cd = res.headers.get("content-disposition") || "";
    assert.ok(cd.includes("attachment"), "must be an attachment download");
    assert.strictEqual(res.headers.get("cache-control"), "no-store", "exports must not be cached");
    console.log("ok - payload shape, attachment disposition, no-store cache");
  }

  // 6. Missing tables are tolerated, not fatal
  {
    const admin = createMockAdmin({ user: USER, failTables: ["user_consents", "page_views"] });
    const res = await handleAccountExportRequest(makeReq("tok"), { getSupabaseAdmin: () => admin });
    assert.strictEqual(res.status, 200, "missing tables must not fail the export");
    console.log("ok - non-existent tables skipped (42P01 tolerated)");
  }

  console.log("\nAll account-export checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
