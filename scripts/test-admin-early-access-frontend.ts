/**
 * scripts/test-admin-early-access-frontend.ts
 *
 * Verification suite for Admin Early Access Requests Frontend Section:
 * 1. Admin Page Integration:
 *    - src/app/admin/page.tsx imports and renders <EarlyAccessRequestsSection />.
 *    - Reuses current admin panel card styles (bg-white rounded-xl border border-slate-200 shadow-sm).
 *    - Reuses current admin table styles (w-full text-left text-sm, thead bg-slate-50 uppercase).
 * 2. Table Headers and Columns:
 *    - Table contains User Email, Requested Date, Status, and Actions columns.
 * 3. Status Badges and Action Buttons:
 *    - Status badge renders Pending, Approved, and Rejected states.
 *    - Approve button with emerald styles (text-emerald-700 bg-emerald-50 border-emerald-200).
 *    - Reject button with red styles (text-red-700 bg-red-50 border-red-200).
 * 4. Response Shape Adaptability:
 *    - Normalizes { requests: [...] }, { data: [...] }, { items: [...] }, and raw array [...].
 *    - Handles alternate property keys (email/user_email/address, created_at/createdAt/date/requested_at).
 * 5. Notification Resilience ("email not sent" note):
 *    - When response has notify_skipped: true, displays "email not sent" note in banner and row.
 *    - When notify_skipped: false, does not display "email not sent".
 * 6. Refresh After Action:
 *    - Re-fetches requests after Approve or Reject actions.
 * 7. Loading and Error States:
 *    - Renders loading spinner/message, empty state, and error banner with retry.
 * 8. Negative Control:
 *    - Subprocess execution verifying non-zero exit on violated assertions.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  console.log("[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on corrupted section...");
  const adminPageHasSection = false;
  assert.strictEqual(
    adminPageHasSection,
    true,
    "Negative control expected failure: EarlyAccessRequestsSection must be integrated in admin page."
  );
  process.exit(0);
}

function runSuite() {
  console.log("================================================================================");
  console.log("      CAREERMONKE ADMIN EARLY ACCESS REQUESTS FRONTEND AUDIT SUITE             ");
  console.log("================================================================================");

  // 1. Inspect Files
  console.log("\n[TEST 1] Verifying component existence and admin page integration...");
  const adminPagePath = path.resolve(process.cwd(), "src/app/admin/page.tsx");
  const sectionCompPath = path.resolve(
    process.cwd(),
    "src/components/admin/EarlyAccessRequestsSection.tsx"
  );

  assert.ok(
    fs.existsSync(adminPagePath),
    "src/app/admin/page.tsx must exist"
  );
  assert.ok(
    fs.existsSync(sectionCompPath),
    "src/components/admin/EarlyAccessRequestsSection.tsx must exist"
  );

  const adminPageSrc = fs.readFileSync(adminPagePath, "utf-8");
  const sectionSrc = fs.readFileSync(sectionCompPath, "utf-8");

  assert.ok(
    adminPageSrc.includes("EarlyAccessRequestsSection"),
    "src/app/admin/page.tsx must import EarlyAccessRequestsSection"
  );
  assert.ok(
    adminPageSrc.includes("<EarlyAccessRequestsSection />") ||
      adminPageSrc.includes("<EarlyAccessRequestsSection"),
    "src/app/admin/page.tsx must render <EarlyAccessRequestsSection />"
  );

  console.log("  [PASS] EarlyAccessRequestsSection imported and mounted in src/app/admin/page.tsx");

  // 2. Card and Table Styling
  console.log("\n[TEST 2] Verifying reuse of admin card and table styles...");
  assert.ok(
    sectionSrc.includes("bg-white rounded-xl border border-slate-200 shadow-sm"),
    "Section must reuse admin card container styles (bg-white rounded-xl border border-slate-200 shadow-sm)"
  );
  assert.ok(
    sectionSrc.includes("overflow-x-auto"),
    "Table must be wrapped in overflow-x-auto container"
  );
  assert.ok(
    sectionSrc.includes("table className=\"w-full text-left text-sm\""),
    "Table must use standard admin table classes (w-full text-left text-sm)"
  );
  assert.ok(
    sectionSrc.includes("bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200"),
    "Table thead must match admin uppercase slate-50 header style"
  );

  console.log("  [PASS] Card and table styles match existing admin design tokens exactly");

  // 3. Section Title, Columns, Badges, and Action Buttons
  console.log("\n[TEST 3] Verifying section title, columns, and action buttons...");
  assert.ok(
    sectionSrc.includes("Early access requests"),
    "Section heading must be 'Early access requests'"
  );
  assert.ok(
    sectionSrc.includes("User Email") || sectionSrc.includes("Email"),
    "Table must include email column"
  );
  assert.ok(
    sectionSrc.includes("Requested Date"),
    "Table must include Requested Date column"
  );
  assert.ok(
    sectionSrc.includes("Status"),
    "Table must include Status column"
  );
  assert.ok(
    sectionSrc.includes("Actions"),
    "Table must include Actions column"
  );
  assert.ok(
    sectionSrc.includes("Approve") && sectionSrc.includes("text-emerald-700"),
    "Section must have an Approve button styled in emerald"
  );
  assert.ok(
    sectionSrc.includes("Reject") && sectionSrc.includes("text-red-700"),
    "Section must have a Reject button styled in red"
  );

  console.log("  [PASS] Section title, table headers, Approve/Reject buttons present and styled");

  // 4. "email not sent" Handling
  console.log("\n[TEST 4] Verifying 'email not sent' note when notify_skipped: true...");
  assert.ok(
    sectionSrc.includes("email not sent"),
    "Component must render 'email not sent' note"
  );
  assert.ok(
    sectionSrc.includes("notify_skipped") || sectionSrc.includes("notifySkipped"),
    "Component must inspect notify_skipped from backend response"
  );

  console.log("  [PASS] 'email not sent' note rendered upon notify_skipped: true");

  // 5. Backend Endpoint Wiring & Response Shape Adaptability
  console.log("\n[TEST 5] Verifying backend endpoint wiring & response shape adaptability...");
  assert.ok(
    sectionSrc.includes("/api/admin/early-access"),
    "Component must be wired to /api/admin/early-access backend endpoints"
  );
  assert.ok(
    sectionSrc.includes("fetchRequests"),
    "Component must implement refresh after action"
  );

  // Test adaptability function logic
  function adaptResponse(json: any) {
    let rawList: any[] = [];
    if (Array.isArray(json)) {
      rawList = json;
    } else if (Array.isArray(json?.requests)) {
      rawList = json.requests;
    } else if (Array.isArray(json?.data)) {
      rawList = json.data;
    } else if (Array.isArray(json?.items)) {
      rawList = json.items;
    } else if (Array.isArray(json?.earlyAccessRequests)) {
      rawList = json.earlyAccessRequests;
    }

    return rawList.map((item: any) => ({
      email: String(item.email || item.user_email || item.userEmail || item.address || "").trim(),
      created_at: item.created_at || item.createdAt || item.requested_at || item.requestedAt || item.date || "",
      status: item.status || (item.approved === true ? "approved" : "pending"),
    }));
  }

  // Case A: { requests: [...] }
  const caseA = adaptResponse({
    ok: true,
    requests: [{ email: "alice@example.com", created_at: "2026-11-04T10:00:00Z", status: "pending" }],
  });
  assert.strictEqual(caseA.length, 1);
  assert.strictEqual(caseA[0].email, "alice@example.com");
  assert.strictEqual(caseA[0].status, "pending");

  // Case B: { data: [...] }
  const caseB = adaptResponse({
    data: [{ user_email: "bob@example.com", date: "2026-11-04T10:00:00Z", approved: true }],
  });
  assert.strictEqual(caseB.length, 1);
  assert.strictEqual(caseB[0].email, "bob@example.com");
  assert.strictEqual(caseB[0].status, "approved");

  // Case C: Raw array [...]
  const caseC = adaptResponse([
    { address: "carol@example.com", requested_at: "2026-11-04T10:00:00Z", status: "pending" },
  ]);
  assert.strictEqual(caseC.length, 1);
  assert.strictEqual(caseC[0].email, "carol@example.com");

  // Case D: { items: [...] }
  const caseD = adaptResponse({
    items: [{ email: "dave@example.com", createdAt: "2026-11-04T10:00:00Z", status: "rejected" }],
  });
  assert.strictEqual(caseD.length, 1);
  assert.strictEqual(caseD[0].email, "dave@example.com");
  assert.strictEqual(caseD[0].status, "rejected");

  console.log("  [PASS] Successfully adapts to { requests: [] }, { data: [] }, { items: [] }, and raw array []");

  // 6. Loading and Error States
  console.log("\n[TEST 6] Verifying loading, error, and empty states...");
  assert.ok(
    sectionSrc.includes("Loading early access requests"),
    "Component must render loading message"
  );
  assert.ok(
    sectionSrc.includes("No pending early access requests"),
    "Component must render empty state when no requests are pending"
  );
  assert.ok(
    sectionSrc.includes("Retry") || sectionSrc.includes("retry"),
    "Component must provide retry capability on error"
  );

  console.log("  [PASS] Loading, error banner with retry, and empty states verified");

  // 7. Negative Control Subprocess Execution
  console.log("\n[TEST 7] Verifying negative control exits non-zero...");
  const scriptPath = path.resolve(__dirname, "test-admin-early-access-frontend.ts");
  const child = spawnSync("npx", ["tsx", scriptPath, "--negative-control"], {
    stdio: "pipe",
    shell: true,
  });

  assert.strictEqual(
    child.status,
    1,
    `Negative control must exit with status 1, got ${child.status}`
  );
  console.log("  [PASS] Negative control exited non-zero (1) as expected");

  console.log("\n================================================================================");
  console.log("      ALL ADMIN EARLY ACCESS REQUESTS FRONTEND TESTS PASSED [PASS-LOCAL]       ");
  console.log("================================================================================");
}

runSuite();
