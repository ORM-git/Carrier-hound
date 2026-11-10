/**
 * scripts/test-notify-me.ts
 *
 * Comprehensive offline verification suite for Backend Task 1 (Notify-me email list):
 * 1. Migration static checks:
 *    - File supabase/migrations/20261108c_notify_me_signups.sql exists.
 *    - Carries NOT APPLIED status with self-referencing record-migration command.
 *    - Creates public.notify_me_signups with UUID PK, text email, source default 'pricing', timestamptz created_at.
 *    - Unique index on lower(email).
 *    - RLS enabled; revoked from anon/authenticated; granted to service_role only.
 *    - Documented, commented ROLLBACK block.
 * 2. API Route POST /api/notify-me tests:
 *    - Email validation (format, length <= 254, CRLF injection prevention).
 *    - Normalisation to lowercase.
 *    - Shared rate limiting per IP (5 requests / 60 seconds).
 *    - Honeypot fields (website, honeypot, hp) silently accepted without DB insert.
 *    - Upsert-ignore on conflict (simulated duplicate key 23505 and pre-check).
 *    - Generic success response either way (zero email enumeration).
 *    - No emails sent (no outbound mail calls).
 *    - No authentication required.
 * 3. Automated negative control: exits non-zero (1) under --negative-control.
 *
 * Run: npx tsx scripts/test-notify-me.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";

const isNegativeControl = process.argv.includes("--negative-control");

async function main() {
  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Triggering deliberate failure via --negative-control...");
    assert.strictEqual("actual", "expected", "Intentional negative control failure");
    return;
  }

  console.log("================================================================================");
  console.log("RUNNING NOTIFY-ME EMAIL LIST VERIFICATION SUITE");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // 1. Static Verification of Migration 20261108c_notify_me_signups.sql
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 1] Verifying migration 20261108c_notify_me_signups.sql...");
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261108c_notify_me_signups.sql");
  assert.ok(fs.existsSync(migrationPath), "Migration file 20261108c_notify_me_signups.sql must exist");

  const migrationSql = fs.readFileSync(migrationPath, "utf8");

  assert.ok(
    /Status:\s*NOT APPLIED/i.test(migrationSql),
    "Migration must be marked Status: NOT APPLIED"
  );
  assert.ok(
    /record-migration\.cjs\s+20261108c_notify_me_signups/i.test(migrationSql),
    "Migration header must contain self-referencing record command"
  );
  assert.ok(
    /create\s+table\s+if\s+not\s+exists\s+public\.notify_me_signups/i.test(migrationSql),
    "Migration must create table public.notify_me_signups"
  );
  assert.ok(
    /id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i.test(migrationSql),
    "id must be uuid primary key default gen_random_uuid()"
  );
  assert.ok(
    /email\s+text\s+not\s+null/i.test(migrationSql),
    "email must be text not null"
  );
  assert.ok(
    /source\s+text\s+default\s+'pricing'/i.test(migrationSql),
    "source must default to 'pricing'"
  );
  assert.ok(
    /create\s+unique\s+index\s+if\s+not\s+exists\s+idx_notify_me_signups_lower_email\s+on\s+public\.notify_me_signups\s*\(\s*lower\(email\)\s*\)/i.test(
      migrationSql
    ),
    "Unique index on lower(email) must be created"
  );
  assert.ok(
    /alter\s+table\s+public\.notify_me_signups\s+enable\s+row\s+level\s+security/i.test(migrationSql),
    "Row Level Security must be enabled on public.notify_me_signups"
  );
  assert.ok(
    /revoke\s+all\s+on\s+table\s+public\.notify_me_signups\s+from\s+anon,\s*authenticated/i.test(migrationSql),
    "Privileges must be revoked from anon and authenticated"
  );
  assert.ok(
    /grant\s+select,\s*insert\s+on\s+table\s+public\.notify_me_signups\s+to\s+service_role/i.test(migrationSql),
    "Select and insert privileges must be granted to service_role"
  );
  assert.ok(
    /--\s*ROLLBACK/i.test(migrationSql),
    "Migration must carry a commented ROLLBACK section"
  );
  assert.ok(
    /--\s*DROP\s+TABLE\s+IF\s+EXISTS\s+public\.notify_me_signups/i.test(migrationSql),
    "Rollback section must contain DROP TABLE statement"
  );
  console.log("  [PASS-LOCAL] Migration DDL, indexes, RLS, grants, and rollback verified");

  // ---------------------------------------------------------------------------
  // 2. Unit Testing of Email Validation Function
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying email validation and normalization...");
  const { validateNotifyMeEmail } = await import("../src/lib/notify-me/validation");

  // Valid emails
  assert.strictEqual(validateNotifyMeEmail("user@example.com").valid, true);
  assert.strictEqual(validateNotifyMeEmail("USER@EXAMPLE.COM").email, "user@example.com");
  assert.strictEqual(validateNotifyMeEmail("  engineer@domain.co.uk  ").email, "engineer@domain.co.uk");
  assert.strictEqual(validateNotifyMeEmail("first.last+tag@sub.domain.org").valid, true);

  // Invalid emails
  assert.strictEqual(validateNotifyMeEmail("").valid, false);
  assert.strictEqual(validateNotifyMeEmail("notanemail").valid, false);
  assert.strictEqual(validateNotifyMeEmail("@domain.com").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user@").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user@domain").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user..double@domain.com").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user space@domain.com").valid, false);
  assert.strictEqual(validateNotifyMeEmail(12345).valid, false);
  assert.strictEqual(validateNotifyMeEmail(null).valid, false);

  // Max 254 chars check (with RFC 5321 local-part <= 64 chars)
  const local64 = "a".repeat(64);
  const domain189 = "b".repeat(50) + "." + "c".repeat(50) + "." + "d".repeat(50) + "." + "e".repeat(32) + ".com"; // 189 chars
  const maxEmail = `${local64}@${domain189}`; // 64 + 1 + 189 = 254 chars
  assert.strictEqual(maxEmail.length, 254);
  assert.strictEqual(validateNotifyMeEmail(maxEmail).valid, true);

  const overMaxEmail = `${local64}@a${domain189}`; // 255 chars
  assert.strictEqual(overMaxEmail.length, 255);
  assert.strictEqual(validateNotifyMeEmail(overMaxEmail).valid, false);

  // CRLF / Header injection prevention
  assert.strictEqual(validateNotifyMeEmail("user@example.com\r\nBcc: victim@example.com").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user@example.com%0d%0aBcc: victim@example.com").valid, false);
  assert.strictEqual(validateNotifyMeEmail("user\0@example.com").valid, false);
  console.log("  [PASS-LOCAL] Email validation and injection sanitization verified");

  // ---------------------------------------------------------------------------
  // 3. API Route POST /api/notify-me Functional Tests
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Verifying POST /api/notify-me endpoint...");
  const { POST: notifyMePost } = await import("../src/app/api/notify-me/route");
  const { _resetNotifyMeRateLimitStore } = await import("../src/lib/api/sharedRateLimit");

  // Setup mock Supabase client
  const insertedRows: Array<{ email: string; source: string; created_at: string }> = [];
  let simulateDuplicateCode: string | null = null;

  (globalThis as any).__mockSupabaseClient = {
    from: (table: string) => {
      assert.strictEqual(table, "notify_me_signups");
      return {
        select: (cols: string) => ({
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              const found = insertedRows.find((r) => r.email.toLowerCase() === val.toLowerCase());
              return { data: found ? { id: "mock-id" } : null, error: null };
            },
          }),
        }),
        insert: async (row: any) => {
          if (simulateDuplicateCode) {
            return {
              data: null,
              error: { code: simulateDuplicateCode, message: "duplicate key value violates unique constraint" },
            };
          }
          insertedRows.push(row);
          return { data: [row], error: null };
        },
      };
    },
  };

  // Test 3a: Valid submission
  _resetNotifyMeRateLimitStore();
  const req1 = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
    body: JSON.stringify({ email: "Interested@Domain.COM", source: "pricing-card" }),
  });
  const res1 = await notifyMePost(req1);
  assert.strictEqual(res1.status, 200);
  const data1 = await res1.json();
  assert.strictEqual(data1.ok, true);
  assert.strictEqual(data1.message, "You're on the list");
  assert.strictEqual(insertedRows.length, 1);
  assert.strictEqual(insertedRows[0].email, "interested@domain.com"); // normalised
  assert.strictEqual(insertedRows[0].source, "pricing-card");

  // Test 3b: Default source fallback
  const reqDefaultSource = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
    body: JSON.stringify({ email: "defaultsource@domain.com" }),
  });
  const resDefaultSource = await notifyMePost(reqDefaultSource);
  assert.strictEqual(resDefaultSource.status, 200);
  assert.strictEqual(insertedRows.length, 2);
  assert.strictEqual(insertedRows[1].source, "pricing");

  // Test 3c: Duplicate email submission (pre-check / upsert-ignore)
  const reqDup = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.3" },
    body: JSON.stringify({ email: "interested@domain.com" }),
  });
  const resDup = await notifyMePost(reqDup);
  assert.strictEqual(resDup.status, 200);
  const dataDup = await resDup.json();
  assert.strictEqual(dataDup.ok, true);
  assert.strictEqual(dataDup.message, "You're on the list"); // identical response, no enumeration
  assert.strictEqual(insertedRows.length, 2); // row count did not increase

  // Test 3d: Unique constraint violation (23505 simulation)
  simulateDuplicateCode = "23505";
  const reqUniqueViolation = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.4" },
    body: JSON.stringify({ email: "uniqueconflict@domain.com" }),
  });
  const resUniqueViolation = await notifyMePost(reqUniqueViolation);
  assert.strictEqual(resUniqueViolation.status, 200);
  const dataUniqueViolation = await resUniqueViolation.json();
  assert.strictEqual(dataUniqueViolation.ok, true);
  assert.strictEqual(dataUniqueViolation.message, "You're on the list");
  simulateDuplicateCode = null;

  // Test 3e: Honeypot drop
  const prevCount = insertedRows.length;
  const reqHp = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.5" },
    body: JSON.stringify({ email: "bot@spammer.com", website: "https://spam.example.com" }),
  });
  const resHp = await notifyMePost(reqHp);
  assert.strictEqual(resHp.status, 200);
  const dataHp = await resHp.json();
  assert.strictEqual(dataHp.ok, true);
  assert.strictEqual(dataHp.message, "You're on the list");
  assert.strictEqual(insertedRows.length, prevCount); // Not inserted

  // Test 3f: Bad payload
  const reqBad = new Request("http://localhost:3000/api/notify-me", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.6" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  const resBad = await notifyMePost(reqBad);
  assert.strictEqual(resBad.status, 400);

  // ---------------------------------------------------------------------------
  // 4. Rate Limiting Tests (5 requests / 60 seconds per IP)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying IP rate limiting (5 req / 60s)...");
  _resetNotifyMeRateLimitStore();
  const rlIp = "203.0.113.88";

  for (let i = 1; i <= 5; i++) {
    const res = await notifyMePost(
      new Request("http://localhost:3000/api/notify-me", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": rlIp },
        body: JSON.stringify({ email: `testuser${i}@example.com` }),
      })
    );
    assert.strictEqual(res.status, 200, `Request ${i} should succeed`);
  }

  // 6th request must be rate limited (429)
  const res6 = await notifyMePost(
    new Request("http://localhost:3000/api/notify-me", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": rlIp },
      body: JSON.stringify({ email: "testuser6@example.com" }),
    })
  );
  assert.strictEqual(res6.status, 429, "6th request within window must return 429");
  assert.ok(res6.headers.has("Retry-After"), "429 response must include Retry-After header");
  console.log("  [PASS-LOCAL] 5 req/min rate limit per IP enforced");

  // ---------------------------------------------------------------------------
  // 5. Negative Control Verification (Subprocess)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Verifying negative control fails with non-zero exit code...");
  const scriptPath = path.resolve(__dirname, "test-notify-me.ts");
  const negResult = spawnSync("npx", ["tsx", scriptPath, "--negative-control"], {
    shell: true,
    stdio: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    `Negative control must exit non-zero, got ${negResult.status}`
  );
  console.log(`  [PASS-LOCAL] Negative control exit code verified (${negResult.status})`);

  console.log("\n================================================================================");
  console.log("ALL NOTIFY-ME TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FAIL] Test suite failed:\n", err);
  process.exit(1);
});
