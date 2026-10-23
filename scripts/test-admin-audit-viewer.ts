import assert from "node:assert/strict";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load env
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock.supabase.co";

import { GET as adminAuditLogGet } from "../src/app/api/admin/audit-log/route";
import { fetchAdminAuditLogs } from "../src/lib/admin/auditLog";
import { ADMIN_EMAIL } from "../src/lib/admin/constants";

// Mock global fetch for audit log route
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  const headers = (init?.headers as any) || {};
  const authHeader = typeof headers.get === "function"
    ? headers.get("authorization") || headers.get("Authorization") || ""
    : (headers["Authorization"] || headers["authorization"] || "");

  if (urlStr.includes("/auth/v1/user")) {
    if (authHeader.includes("Bearer mock-token-admin")) {
      return new Response(
        JSON.stringify({
          id: "admin-user-001",
          email: ADMIN_EMAIL,
          user_metadata: { role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  if (urlStr.includes("/rest/v1/admin_audit_log")) {
    const mockLogs = [
      {
        id: "log-001",
        created_at: new Date(Date.now() - 3600000).toISOString(),
        admin_user_id: "admin-user-001",
        action: "user.block",
        target_type: "user",
        target_id: "bad-actor-001",
        metadata: { reason: "Terms of service violation" },
        ip_hash: "abcdef1234567890abcdef1234567890",
      },
      {
        id: "log-002",
        created_at: new Date(Date.now() - 7200000).toISOString(),
        admin_user_id: "admin-user-001",
        action: "user.unblock",
        target_type: "user",
        target_id: "reinstated-002",
        metadata: { reason: "Appeal reviewed and approved" },
        ip_hash: "1234567890abcdef1234567890abcdef",
      },
    ];
    return new Response(JSON.stringify(mockLogs), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "content-range": "0-1/2",
      },
    });
  }

  return originalFetch(input, init);
};

async function runAuditViewerTests() {
  console.log("=== Running Admin Audit Log Viewer Test Suite ===");
  let passes = 0;

  // 1. Unauthenticated request to /api/admin/audit-log rejected with 403
  const reqNoAuth = new Request("http://localhost:3000/api/admin/audit-log");
  const resNoAuth = await adminAuditLogGet(reqNoAuth);
  assert.equal(resNoAuth.status, 403, "Unauthenticated /api/admin/audit-log must return 403");
  passes++;
  console.log("✅ [PASS-LOCAL] Unauthenticated request to /api/admin/audit-log rejected with 403");

  // 2. Authenticated Admin can fetch audit logs
  const reqAdmin = new Request("http://localhost:3000/api/admin/audit-log?page=1&pageSize=20", {
    headers: { Authorization: "Bearer mock-token-admin" },
  });
  const resAdmin = await adminAuditLogGet(reqAdmin);
  assert.equal(resAdmin.status, 200, "Authenticated admin should receive 200");
  const data = await resAdmin.json();
  assert.equal(data.ok, true);
  assert.equal(Array.isArray(data.entries), true);
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].action, "user.block");
  assert.equal(data.entries[0].target_id, "bad-actor-001");
  assert.equal(data.entries[0].metadata.reason, "Terms of service violation");
  assert.equal(data.entries[1].action, "user.unblock");
  passes++;
  console.log("✅ [PASS-LOCAL] Authenticated admin successfully retrieved paginated audit records");

  // 3. Helper fetchAdminAuditLogs resilience (safe on error or missing DB)
  const helperResult = await fetchAdminAuditLogs({ page: 1, pageSize: 10 });
  assert.equal(typeof helperResult.total, "number");
  assert.equal(Array.isArray(helperResult.entries), true);
  passes++;
  console.log("✅ [PASS-LOCAL] fetchAdminAuditLogs helper returned structured paginated result safely");

  // 4. Bounded pagination parameter clamping (page must be >= 1, pageSize capped at 100)
  const reqCapped = new Request("http://localhost:3000/api/admin/audit-log?page=-5&pageSize=500", {
    headers: { Authorization: "Bearer mock-token-admin" },
  });
  const resCapped = await adminAuditLogGet(reqCapped);
  assert.equal(resCapped.status, 200);
  const dataCapped = await resCapped.json();
  assert.equal(dataCapped.page, 1, "Negative page should clamp to 1");
  assert.equal(dataCapped.pageSize, 20, "Oversized pageSize (> 100) falls back to default 20");
  passes++;
  console.log("✅ [PASS-LOCAL] Page and pageSize bounds sanitized and clamped correctly");

  // 5. Negative Control Check: proving non-zero exit on invalid condition
  if (process.env.RUN_NEGATIVE_CONTROL === "true") {
    console.log("Running intentional negative control...");
    assert.equal(resNoAuth.status, 200, "Negative control intended failure");
  }

  console.log(`\n🎉 ALL ${passes} ADMIN AUDIT VIEWER TESTS PASSED (PASS-LOCAL)!`);
}

runAuditViewerTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
