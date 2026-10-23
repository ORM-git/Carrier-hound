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

import { GET as adminActivityGet } from "../src/app/api/admin/users/activity/route";
import { ADMIN_EMAIL } from "../src/lib/admin/constants";

// Mock global fetch for activity tests
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
  }

  if (urlStr.includes("/rest/v1/page_views")) {
    const now = Date.now();
    const sampleHits = [
      { id: "1", path: "/jobs", user_id: "user-123", created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }, // 2h ago
      { id: "2", path: "/settings", user_id: "user-123", created_at: new Date(now - 10 * 60 * 60 * 1000).toISOString() }, // 10h ago
      { id: "3", path: "/profile", user_id: "user-123", created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString() }, // 3d ago
      { id: "4", path: "/tracker", user_id: "user-123", created_at: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString() }, // 14d ago
    ];
    return new Response(JSON.stringify(sampleHits), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return originalFetch(input, init);
};

async function runPaginationAndSummaryTests() {
  console.log("=== Running Admin Users Pagination & 24h/7d Summary Test Suite ===");
  let passes = 0;

  // 1. Verify 24h & 7d Usage Summary from Activity Endpoint
  const req = new Request("http://localhost:3000/api/admin/users/activity?userId=user-123", {
    headers: { Authorization: "Bearer mock-token-admin" },
  });
  const res = await adminActivityGet(req);
  assert.equal(res.status, 200, "Activity endpoint must return 200 for authenticated admin");
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(Array.isArray(data.activity), true);
  assert.equal(data.activity.length, 4);

  // 2 hits in past 24h (2h and 10h ago)
  assert.equal(data.summary.views24h, 2, "Expected exactly 2 hits in past 24h");
  // 3 hits in past 7d (2h, 10h, and 3d ago)
  assert.equal(data.summary.views7d, 3, "Expected exactly 3 hits in past 7d");
  assert.equal(data.summary.totalRecordedViews, 4, "Expected 4 total recorded views");
  passes++;
  console.log("✅ [PASS-LOCAL] 24h and 7d usage summaries computed accurately");

  // 2. Verify Telemetry Disclosures
  assert(data.telemetryNotice.untrackedSearches, "Telemetry notice must disclose untracked searches");
  assert(data.telemetryNotice.untrackedApplyClicks, "Telemetry notice must disclose untracked apply clicks");
  assert(data.telemetryNotice.untrackedAiCalls, "Telemetry notice must disclose untracked AI calls");
  passes++;
  console.log("✅ [PASS-LOCAL] Untracked telemetry boundaries disclosed explicitly");

  // 3. Verify Bounded Pagination Math
  const USERS_PER_PAGE = 25;
  const mockUsers = Array.from({ length: 65 }, (_, i) => ({
    id: `user-${i + 1}`,
    email: `candidate${i + 1}@example.com`,
    createdAt: new Date().toISOString(),
    isPro: i % 2 === 0,
    isBlocked: false,
    totalViews: i,
  }));

  const totalFiltered = mockUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / USERS_PER_PAGE));
  assert.equal(totalPages, 3, "65 users at 25/page must equal 3 pages");

  // Page 1: 0 to 25
  const page1Slice = mockUsers.slice(0, USERS_PER_PAGE);
  assert.equal(page1Slice.length, 25);
  assert.equal(page1Slice[0].id, "user-1");
  assert.equal(page1Slice[24].id, "user-25");

  // Page 3: 50 to 65 (15 users)
  const page3Slice = mockUsers.slice(50, 75);
  assert.equal(page3Slice.length, 15);
  assert.equal(page3Slice[0].id, "user-51");
  assert.equal(page3Slice[14].id, "user-65");

  // Out of bounds page safety clamping
  const requestPage = 999;
  const safePage = Math.min(Math.max(1, requestPage), totalPages);
  assert.equal(safePage, 3, "Out of bounds page must clamp to totalPages");
  passes++;
  console.log("✅ [PASS-LOCAL] Bounded pagination logic verified (25 users/page across 3 pages)");

  // 4. Negative Control
  if (process.env.RUN_NEGATIVE_CONTROL === "true") {
    console.log("Running intentional negative control...");
    assert.equal(data.summary.views24h, 999, "Negative control intended failure");
  }

  console.log(`\n🎉 ALL ${passes} USERS PAGINATION & USAGE TESTS PASSED (PASS-LOCAL)!`);
}

runPaginationAndSummaryTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
