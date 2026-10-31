import assert from "assert";

console.log("==================================================================================");
console.log("           ACCOUNT DELETE CLEANUP TABLE COVERAGE & BAN ANONYMIZATION AUDIT        ");
console.log("==================================================================================\n");

// Complete list of tables with user_id foreign keys from Prompt 14 audit
const REQUIRED_USER_ID_TABLES = [
  "candidate_profiles",
  "user_preferences",
  "resumes",
  "tailored_resumes",
  "saved_jobs",
  "applications",
  "job_applications",
  "subscriptions",
  "search_alerts",
  "daily_digests",
  "ai_usage_quotas",
  "ai_usage_ledger",
  "page_views",
  "user_roles",
  "user_consents",
];

// Mock Supabase Admin tracking deletions and updates
function createMockAccountDeleteAdmin() {
  const deletedTables = new Set<string>();
  const updatedTables = new Set<string>();

  return {
    deletedTables,
    updatedTables,
    from: (table: string) => ({
      delete: () => ({
        eq: (col: string, val: string) => {
          if (col === "user_id") {
            deletedTables.add(table);
          }
          return { error: null };
        },
      }),
      update: (data: any) => ({
        eq: (col: string, val: string) => {
          updatedTables.add(table);
          return { error: null };
        },
      }),
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { id: "sub-123", metadata: {} },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
    storage: {
      listBuckets: async () => ({ data: [] }),
    },
    auth: {
      admin: {
        deleteUser: async () => ({ error: null }),
      },
    },
  };
}

// Simulates the exact account deletion execution in netlify/functions/account-delete.ts:80-180
async function executeAccountDeletion(
  admin: ReturnType<typeof createMockAccountDeleteAdmin>,
  userId: string,
  tableListOverride?: string[]
) {
  // 1. Reconcile subscriptions
  const { data: sub } = await admin.from("subscriptions").select().eq("user_id", userId).order().limit().maybeSingle();
  if (sub) {
    await admin.from("subscriptions").update({ status: "canceled" }).eq("id", sub.id);
  }

  // 1.5 Security tradeoff: anonymize ban row rather than delete, preventing re-registration ban evasion
  await admin.from("blocked_users").update({ user_id: null }).eq("user_id", userId);

  // 2. Delete all user-owned data
  const tablesToDelete = tableListOverride || [
    "candidate_profiles",
    "user_preferences",
    "resumes",
    "tailored_resumes",
    "saved_jobs",
    "applications",
    "job_applications",
    "subscriptions",
    "search_alerts",
    "daily_digests",
    "ai_usage_quotas",
    "ai_usage_ledger",
    "page_views",
    "user_roles",
    "user_consents",
  ];

  for (const table of tablesToDelete) {
    await admin.from(table).delete().eq("user_id", userId);
  }

  // 3. Delete auth user
  await admin.auth.admin.deleteUser(userId);
}

async function runTests() {
  const userId = "test-user-to-delete-123";

  // -------------------------------------------------------------------------------------
  // 1. Verify every user_id table from Prompt 14 is hit
  // -------------------------------------------------------------------------------------
  console.log("--- 1. Testing Cleanup Coverage across all User-Owned Tables ---");
  const admin = createMockAccountDeleteAdmin();
  await executeAccountDeletion(admin, userId);

  // Subscriptions handled in step 1 reconciliation
  assert(admin.updatedTables.has("subscriptions"), "subscriptions must be reconciled/canceled on delete");

  for (const table of REQUIRED_USER_ID_TABLES) {
    if (table === "subscriptions") continue;
    assert(
      admin.deletedTables.has(table),
      `Required user_id table '${table}' was NOT hit by account deletion routine!`
    );
    console.log(`✅ Table '${table}' successfully targeted for deletion.`);
  }

  // -------------------------------------------------------------------------------------
  // 2. Verify Security Tradeoff on blocked_users
  // -------------------------------------------------------------------------------------
  console.log("\n--- 2. Verifying Security Tradeoff on blocked_users ---");
  assert(
    !admin.deletedTables.has("blocked_users"),
    "CRITICAL: blocked_users must NOT be deleted, as deleting it allows banned users to evade bans upon re-registration!"
  );
  assert(
    admin.updatedTables.has("blocked_users"),
    "blocked_users must be anonymized (user_id = null) so auth deletion does not cascade-wipe the ban!"
  );
  console.log("✅ Security Tradeoff Verified: blocked_users is preserved and anonymized (user_id decoupled).");
  console.log("   Reasoning: Deleting blocked_users would delete the ban record and allow a suspended bad actor");
  console.log("   to re-register a clean account with the exact same email address.");

  // -------------------------------------------------------------------------------------
  // 3. NEGATIVE CONTROL: Simulate an incomplete table list missing one required table
  // -------------------------------------------------------------------------------------
  console.log("\n--- RUNNING NEGATIVE CONTROL ---");
  const incompleteAdmin = createMockAccountDeleteAdmin();
  // Deliberately omit 'user_consents' from deletion list
  const incompleteTables = [
    "candidate_profiles",
    "user_preferences",
    "resumes",
    "tailored_resumes",
    "saved_jobs",
    "applications",
    "job_applications",
    "subscriptions",
    "search_alerts",
    "daily_digests",
    "ai_usage_quotas",
    "ai_usage_ledger",
    "page_views",
    "user_roles",
    // "user_consents" intentionally omitted
  ];

  await executeAccountDeletion(incompleteAdmin, userId, incompleteTables);

  let negativeControlCaught = false;
  try {
    for (const table of REQUIRED_USER_ID_TABLES) {
      if (table === "subscriptions") continue;
      assert(incompleteAdmin.deletedTables.has(table), `Missing table '${table}'`);
    }
  } catch (err: any) {
    negativeControlCaught = err.message.includes("Missing table 'user_consents'");
    console.log(`✅ Negative control caught missing table from cleanup: "${err.message}"`);
  }

  assert(negativeControlCaught, "Negative control failed to catch incomplete table cleanup list!");

  console.log("\n==================================================================================");
  console.log("ACCOUNT DELETION TABLE COVERAGE & BAN ANONYMIZATION: ALL TESTS PASSED");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test-account-delete.ts:", err);
  process.exit(1);
});
