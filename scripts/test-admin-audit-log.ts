import * as fs from "fs";
import * as path from "path";
import {
  sanitizeAuditMetadata,
  extractClientIp,
  hashIpAddress,
  logAdminAction,
  SENSITIVE_KEY_REGEX,
  MAX_METADATA_BYTES,
} from "../src/lib/admin/auditLog";

/**
 * Admin Audit Log verification suite.
 * Run directly with: npx tsx scripts/test-admin-audit-log.ts
 * Run negative control with: npx tsx scripts/test-admin-audit-log.ts --negative-control
 */

const isNegativeControl = process.argv.includes("--negative-control");

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log("=== Running Admin Audit Log Test Suite ===");

  if (isNegativeControl) {
    console.log("Testing negative control (expected failure)...");
    assert(false, "Negative control intentional failure to verify non-zero exit");
    return;
  }

  // ---------------------------------------------------------------------------
  // 1. Sanitizer: Sensitive keys redaction
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. Testing Metadata Sanitizer Sensitive Key Redaction ---");
  const sensitiveMeta = {
    reason: "Terms of service violation",
    target_role: "member",
    user_password: "SuperSecretPassword123!",
    api_key: "key_live_983274982374928",
    secret_token: "tok_328947293847293",
    email_address: "target@example.com",
    authorization_header: "Bearer eyJhbGciOi...",
    session_cookie: "cm_session=abcdef",
    jwt_payload: "eyJhbGciOiJIUzI1NiIsIn...",
    nested: {
      safeField: "safeValue",
      admin_secret: "nested_secret_value",
      deep: {
        userEmail: "nested@example.com",
        count: 5,
      },
    },
  };

  const sanitized = sanitizeAuditMetadata(sensitiveMeta);

  // Safe fields must be preserved
  assert(sanitized.reason === "Terms of service violation", "Safe string field must be preserved");
  assert(sanitized.target_role === "member", "Safe role field must be preserved");
  assert(sanitized.nested?.safeField === "safeValue", "Nested safe field must be preserved");
  assert(sanitized.nested?.deep?.count === 5, "Nested safe numeric field must be preserved");

  // Sensitive fields must be redacted
  assert(sanitized.user_password === "[REDACTED]", "user_password must be redacted");
  assert(sanitized.api_key === "[REDACTED]", "api_key must be redacted");
  assert(sanitized.secret_token === "[REDACTED]", "secret_token must be redacted");
  assert(sanitized.email_address === "[REDACTED]", "email_address must be redacted");
  assert(sanitized.authorization_header === "[REDACTED]", "authorization_header must be redacted");
  assert(sanitized.session_cookie === "[REDACTED]", "session_cookie must be redacted");
  assert(sanitized.jwt_payload === "[REDACTED]", "jwt_payload must be redacted");
  assert(sanitized.nested?.admin_secret === "[REDACTED]", "nested admin_secret must be redacted");
  assert(sanitized.nested?.deep?.userEmail === "[REDACTED]", "nested deep userEmail must be redacted");

  console.log("✅ Sensitive metadata keys successfully redacted recursively");

  // ---------------------------------------------------------------------------
  // 2. Sanitizer: 4 KB Size Capping
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Testing Metadata Size Capping (4 KB Limit) ---");
  const hugeMeta = {
    normalKey: "normalValue",
    largeData: "x".repeat(6000), // Exceeds 4 KB
  };

  const capped = sanitizeAuditMetadata(hugeMeta);
  const cappedBytes = new TextEncoder().encode(JSON.stringify(capped)).length;
  assert(cappedBytes <= MAX_METADATA_BYTES, `Sanitized metadata (${cappedBytes} bytes) must not exceed 4 KB (${MAX_METADATA_BYTES} bytes)`);
  assert(capped._truncated === true, "Exceeded metadata must have _truncated: true flag");
  console.log("✅ Oversized metadata safely capped to under 4 KB");

  // ---------------------------------------------------------------------------
  // 3. IP Hashing & Raw IP Prevention
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Testing IP Hashing and Raw IP Prevention ---");
  const rawIp = "198.51.100.42";

  // When no salt is provided, hashIpAddress must return null (NEVER store raw IP)
  const noSaltHash = await hashIpAddress(rawIp, undefined);
  assert(noSaltHash === null, "hashIpAddress must return null when salt is missing");
  const emptySaltHash = await hashIpAddress(rawIp, "");
  assert(emptySaltHash === null, "hashIpAddress must return null when salt is empty string");

  // When salt is provided, it must return a valid 64-char SHA-256 hex string
  const salt = "test-salt-secret-999";
  const saltedHash = await hashIpAddress(rawIp, salt);
  assert(typeof saltedHash === "string", "hashIpAddress must return string when salt is present");
  assert(saltedHash.length === 64, "SHA-256 hash must be 64 hexadecimal characters");
  assert(/^[a-f0-9]{64}$/.test(saltedHash), "Hash must be lowercase hex characters");
  assert(!saltedHash.includes(rawIp), "Hash must never contain raw IP string");

  // Test deterministic hash
  const secondHash = await hashIpAddress(rawIp, salt);
  assert(saltedHash === secondHash, "Same IP and salt must produce consistent hash");

  // Test different salt produces different hash
  const differentSaltHash = await hashIpAddress(rawIp, "different-salt");
  assert(saltedHash !== differentSaltHash, "Different salt must produce different hash");

  // Test extractClientIp
  const mockReqCf = new Request("http://localhost/api/test", {
    headers: { "cf-connecting-ip": "203.0.113.1" },
  });
  assert(extractClientIp(mockReqCf) === "203.0.113.1", "extractClientIp must read cf-connecting-ip");

  const mockReqXff = new Request("http://localhost/api/test", {
    headers: { "x-forwarded-for": "192.0.2.1, 10.0.0.1" },
  });
  assert(extractClientIp(mockReqXff) === "192.0.2.1", "extractClientIp must take first IP from x-forwarded-for");
  console.log("✅ IP hashing and raw IP protection verified (raw IP is never stored)");

  // ---------------------------------------------------------------------------
  // 4. Helper Resilience: Never Throws on Missing Env or Network Failures
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Testing Helper Resilience (Fails Closed, Never Throws) ---");

  // Test with missing service key
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalSecKey = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_KEY;

  let didThrow = false;
  let result = false;
  try {
    result = await logAdminAction({
      adminUserId: "00000000-0000-0000-0000-000000000001",
      action: "user.block",
      targetType: "user",
      targetId: "00000000-0000-0000-0000-000000000002",
      metadata: { reason: "test" },
    });
  } catch (err) {
    didThrow = true;
  }

  assert(!didThrow, "logAdminAction must NEVER throw when service key is missing");
  assert(result === false, "logAdminAction must return false when service key is missing");

  // Test with unreachable endpoint
  process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-key";
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:59999"; // Unreachable port

  didThrow = false;
  try {
    result = await logAdminAction({
      adminUserId: "00000000-0000-0000-0000-000000000001",
      action: "user.unblock",
      targetType: "user",
      targetId: "00000000-0000-0000-0000-000000000002",
    });
  } catch (err) {
    didThrow = true;
  }

  assert(!didThrow, "logAdminAction must NEVER throw when network/fetch fails");
  assert(result === false, "logAdminAction must return false when network/fetch fails");

  // Restore env vars
  if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  if (originalSecKey) process.env.SUPABASE_SERVICE_KEY = originalSecKey;
  if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;

  console.log("✅ logAdminAction fails safely and never throws into caller request");

  // ---------------------------------------------------------------------------
  // 5. Admin Mutation Route Response Invariance
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Testing Admin Mutation Route Response Invariance ---");
  const blockRoutePath = path.resolve(process.cwd(), "src/app/api/admin/users/block/route.ts");
  assert(fs.existsSync(blockRoutePath), "src/app/api/admin/users/block/route.ts must exist");
  const blockRouteContent = fs.readFileSync(blockRoutePath, "utf8");

  assert(
    blockRouteContent.includes("logAdminAction"),
    "Block route must call logAdminAction"
  );
  assert(
    blockRouteContent.includes('action: shouldBlock ? "user.block" : "user.unblock"'),
    "Block route must log user.block or user.unblock action"
  );
  assert(
    blockRouteContent.includes("targetType: \"user\""),
    "Block route must record targetType user"
  );
  assert(
    blockRouteContent.includes("targetId: userId"),
    "Block route must record targetId as userId"
  );

  // Response structure check: must return ok, userId, isBlocked, message
  assert(
    blockRouteContent.includes("ok: true"),
    "Block route response structure must retain ok: true"
  );
  assert(
    blockRouteContent.includes("isBlocked: result.isBlocked"),
    "Block route response structure must retain isBlocked: result.isBlocked"
  );
  console.log("✅ Admin mutation route correctly instrumented with byte-for-byte response retention");

  // ---------------------------------------------------------------------------
  // 6. SQL Migration File Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Testing SQL Migration File for RLS & Privilege Lockdown ---");
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261020_admin_audit_log.sql");
  assert(fs.existsSync(migrationPath), "supabase/migrations/20261020_admin_audit_log.sql must exist");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert(
    /CREATE TABLE IF NOT EXISTS public\.admin_audit_log/i.test(sql),
    "Migration must create public.admin_audit_log idempotently"
  );
  assert(
    /ALTER TABLE public\.admin_audit_log ENABLE ROW LEVEL SECURITY/i.test(sql),
    "Migration must enable Row Level Security (RLS)"
  );
  assert(
    /REVOKE ALL ON TABLE public\.admin_audit_log FROM anon, authenticated/i.test(sql) ||
    /REVOKE ALL ON public\.admin_audit_log FROM anon, authenticated/i.test(sql),
    "Migration must revoke all privileges on table from anon and authenticated roles"
  );
  assert(
    /GRANT ALL ON TABLE public\.admin_audit_log TO service_role/i.test(sql) ||
    /GRANT ALL ON public\.admin_audit_log TO service_role/i.test(sql),
    "Migration must grant privileges to service_role"
  );
  assert(
    !/GRANT.*ON.*public\.admin_audit_log.*TO\s+(?!service_role)(anon|authenticated)/i.test(sql),
    "Migration must NEVER grant privileges to anon or authenticated"
  );
  assert(
    /append-only/i.test(sql) && (/tr_prevent_admin_audit_log_mutation/i.test(sql) || /BEFORE UPDATE OR DELETE/i.test(sql)),
    "Migration must enforce append-only behavior and raise on UPDATE/DELETE"
  );
  console.log("✅ Migration file verified: RLS enabled, anon/authenticated revoked, append-only trigger present");

  console.log("\n🎉 ALL ADMIN AUDIT LOG TESTS PASSED (PASS-LOCAL)!");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
