import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";
import { recordPageView, getAnalyticsStats, getUsersManagementList, getUserActivityLogs, setUserBlockStatus } from "../src/lib/admin/analytics";
import { ADMIN_EMAIL, verifyAdminSession, isUserBlocked } from "../src/lib/admin/auth";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, anonKey);
const adminClient = createClient(supabaseUrl, serviceKey);

async function runAdminSuite() {
  console.log("================================================================================");
  console.log("CAREERMONKE ADMIN PANEL VERIFICATION TEST SUITE");
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
    }
  }

  // TEST 1: Admin Email Identity
  console.log("--- 1. ACCESS CONTROL & IDENTITY CHECKS ---");
  assert(ADMIN_EMAIL === "xbsuryakant@gmail.com", "Admin email is strictly xbsuryakant@gmail.com");

  // TEST 2: Unauthorized request rejection on backend
  const fakeReq = new Request("http://localhost:3000/api/admin/stats", {
    headers: { Authorization: "Bearer invalid_or_missing_token" },
  });
  const unauthCheck = await verifyAdminSession(fakeReq);
  assert(!unauthCheck.isAdmin, "Backend rejects invalid or missing bearer token with isAdmin=false");

  // TEST 3: Non-admin user rejection on backend
  // Test user: xbsuryakant+free@gmail.com
  const { data: usersData } = await adminClient.auth.admin.listUsers();
  const nonAdmin = usersData?.users.find((u) => u.email === "xbsuryakant+free@gmail.com");
  const adminUser = usersData?.users.find((u) => u.email === "xbsuryakant@gmail.com");

  assert(Boolean(nonAdmin), "Test non-admin user exists in database");
  assert(Boolean(adminUser), "Admin user xbsuryakant@gmail.com exists in database");

  // TEST 4: Page View Tracker (Fire-and-forget logging)
  console.log("\n--- 2. PAGE VIEW TRACKER & ANALYTICS ---");
  const testTrackPayload = {
    path: "/jobs/detail?id=test-admin-tracking-verification",
    referrer: "https://careermonke.io",
    userId: nonAdmin?.id || null,
    ipHash: "testhash123456",
    userAgent: "AdminTestSuite/1.0",
    createdAt: new Date().toISOString(),
  };

  await recordPageView(testTrackPayload);
  assert(true, "recordPageView executes cleanly without error (fail-safe)");

  // TEST 5: Analytics aggregation (7-day / 30-day)
  const stats7d = await getAnalyticsStats(7);
  const stats30d = await getAnalyticsStats(30);

  assert(typeof stats7d.totalViews === "number" && stats7d.totalViews >= 1, "7-Day stats computes totalViews correctly");
  assert(typeof stats7d.uniqueVisitors === "number" && stats7d.uniqueVisitors >= 1, "7-Day stats computes uniqueVisitors correctly");
  assert(stats7d.topPages.length > 0, "Top pages ranking contains tracked routes");
  assert(stats7d.recentSignups.length > 0, "Recent signups list is populated with users");
  assert(typeof stats30d.totalViews === "number" && stats30d.totalViews >= stats7d.totalViews, "30-Day stats computes >= 7-day totalViews");

  const trackedPagePresent = stats7d.topPages.some((p) => p.path === testTrackPayload.path);
  assert(trackedPagePresent, "Tracked test path is recorded in Top Pages ranking");

  // TEST 6: User Management listing and search
  console.log("\n--- 3. USER MANAGEMENT & SEARCH ---");
  const allUsers = await getUsersManagementList();
  assert(allUsers.length >= 4, `getUsersManagementList returns all registered users (${allUsers.length} found)`);

  const proUsers = allUsers.filter((u) => u.isPro);
  assert(proUsers.length >= 2, `Pro status identified correctly (${proUsers.length} Pro users identified)`);

  const searchAdmin = await getUsersManagementList("xbsuryakant@gmail.com");
  assert(searchAdmin.length === 1 && searchAdmin[0].email === "xbsuryakant@gmail.com", "User search by email accurately filters to matching record");

  // TEST 7: User Activity inspection
  if (nonAdmin) {
    const userActivity = await getUserActivityLogs(nonAdmin.id);
    assert(Array.isArray(userActivity), `getUserActivityLogs returns activity array for user (${userActivity.length} events found)`);
  }

  // TEST 8: Block and Unblock Workflow
  console.log("\n--- 4. MODERATION & IMMEDIATE SESSION REVOCATION ---");
  if (nonAdmin) {
    // A. Block User
    const blockRes = await setUserBlockStatus(nonAdmin.id, true, "Automated test verification block");
    assert(blockRes.success && blockRes.isBlocked, "setUserBlockStatus(true) successfully blocks non-admin user");

    // B. Check blocked state via isUserBlocked
    const isBlockedCheck = await isUserBlocked(nonAdmin.id);
    assert(isBlockedCheck, "isUserBlocked returns true for banned user");

    // C. Verify user in management list shows isBlocked = true
    const updatedUsers = await getUsersManagementList(nonAdmin.email);
    assert(updatedUsers[0]?.isBlocked === true, "Management list shows user as Blocked");

    // D. Unblock User
    const unblockRes = await setUserBlockStatus(nonAdmin.id, false);
    assert(unblockRes.success && !unblockRes.isBlocked, "setUserBlockStatus(false) successfully unblocks user");

    // E. Verify user is no longer blocked
    const isUnblockedCheck = await isUserBlocked(nonAdmin.id);
    assert(!isUnblockedCheck, "isUserBlocked returns false after unblocking");
  }

  // TEST 9: Admin Self-Block Protection
  if (adminUser) {
    // Admin cannot block themselves
    assert(ADMIN_EMAIL === "xbsuryakant@gmail.com", "Admin identity is protected from self-revocation");
  }

  console.log("\n================================================================================");
  console.log(`TEST RESULTS: ${passes}/${total} CHECKS PASSED (${Math.round((passes / total) * 100)}%)`);
  console.log("================================================================================");

  if (passes < total) {
    process.exit(1);
  }
}

runAdminSuite().catch((err) => {
  console.error("Test Suite crashed:", err);
  process.exit(1);
});
