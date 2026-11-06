/**
 * Static checks for Database rows #1 (Soft Deletes), #5 (Anonymization on
 * delete) and #26 (deleted_at tombstones):
 *  - migration 20261106h ships soft-delete columns, the tombstones table and
 *    the purge function, clearly marked NOT APPLIED with a rollback note;
 *  - the account-delete handler soft-deletes/anonymizes with hard-delete
 *    fallback, writes a fail-open tombstone, and still deletes the auth
 *    identity last.
 * Run: npx tsx scripts/test-account-deletion-anonymize.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const MIGRATION_PATH = "supabase/migrations/20261106h_soft_delete_tombstones.sql";
const HANDLER_PATH = "src/lib/account/deleteHandler.ts";

const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
const handler = fs.readFileSync(HANDLER_PATH, "utf8");

// --- Migration -------------------------------------------------------------
check("migration is marked NOT APPLIED", migration.includes("NOT APPLIED"));
check(
  "migration records itself via record-migration.cjs",
  migration.includes("record-migration.cjs 20261106h_soft_delete_tombstones")
);
check("migration creates deleted_account_tombstones", migration.includes("CREATE TABLE IF NOT EXISTS public.deleted_account_tombstones"));
check("tombstones store a SHA-256 email hash, not the address", migration.includes("email_hash") && !/email\s+TEXT/i.test(migration.split("deleted_account_tombstones")[1]?.split(";")[0] || ""));
check("migration enables RLS on tombstones", migration.includes("ALTER TABLE public.deleted_account_tombstones ENABLE ROW LEVEL SECURITY"));
check("tombstones revoke client access", migration.includes("REVOKE ALL ON public.deleted_account_tombstones FROM anon, authenticated"));
check("migration ships purge function", migration.includes("CREATE OR REPLACE FUNCTION public.purge_soft_deleted_account_data"));
check("purge function is fail-open (WARNING, not abort)", migration.includes('RAISE WARNING'));
check("purge is service-role only", migration.includes("REVOKE ALL ON FUNCTION public.purge_soft_deleted_account_data"));
check("migration documents rollback", migration.includes("ROLLBACK"));

const softDeleteTables = [
  "candidate_profiles", "user_preferences", "resumes", "tailored_resumes",
  "saved_jobs", "applications", "job_applications", "search_alerts",
  "daily_digests", "ai_usage_quotas", "ai_usage_ledger", "page_views",
  "user_roles", "user_consents", "early_access_emails",
];
for (const t of softDeleteTables) {
  check(`migration adds deleted_at to ${t}`, new RegExp(`ALTER TABLE public\\.${t}\\s+ADD COLUMN IF NOT EXISTS deleted_at`).test(migration));
}
check("migration adds anonymized_at to early_access_emails", /ALTER TABLE public\.early_access_emails\s+ADD COLUMN IF NOT EXISTS anonymized_at/.test(migration));

// --- Handler ----------------------------------------------------------------
check("handler soft-deletes via deleted_at update", handler.includes('.update({ deleted_at: nowIso })'));
check("handler falls back to hard delete pre-migration", handler.includes("isMissingSoftDeleteColumn") && handler.includes(".delete()"));
check("handler anonymizes early-access email with non-deliverable placeholder", handler.includes('@${ANONYMIZED_EMAIL_DOMAIN}') && handler.includes('ANONYMIZED_EMAIL_DOMAIN = "deleted.invalid"'));
check("handler hashes email for lookup without PII", handler.includes("sha256Hex(normalizedEmail)"));
check("handler writes tombstone with retention deadline", handler.includes('deleted_account_tombstones') && handler.includes("hard_delete_after"));
check("tombstone write is fail-open", handler.includes("Account deletion tombstone write failed (continuing)"));
check("retention window is 30 days", handler.includes("ACCOUNT_DELETION_RETENTION_DAYS = 30"));
check(
  "auth identity is still deleted after the tombstone write",
  handler.indexOf('from("deleted_account_tombstones")') > 0 &&
    handler.indexOf("auth.admin.deleteUser") > handler.indexOf('from("deleted_account_tombstones")')
);
check("storage files are still removed", handler.includes("bucketApi.remove"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
