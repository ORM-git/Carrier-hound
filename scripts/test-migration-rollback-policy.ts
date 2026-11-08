/**
 * Offline static test for migration rollback documentation (Database row
 * "Rollback sections"): every migration in supabase/migrations must carry a
 * commented ROLLBACK section with at least one commented undo statement (or
 * an explicit manual-restore NOTE), so a bad migration always has a
 * documented way back. Previously 41 migrations had no rollback section;
 * this PR documents all of them and this suite keeps the rule enforced.
 * Run: npx tsx scripts/test-migration-rollback-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const DIR = "supabase/migrations";
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
check("migrations directory is non-empty", files.length >= 56);

// The general rollback/recovery guide the per-file sections complement.
check(
  "general rollback guide exists (supabase/scripts/rollback-notes.md)",
  fs.existsSync("supabase/scripts/rollback-notes.md") &&
    /snapshot|pg_dump/i.test(fs.readFileSync("supabase/scripts/rollback-notes.md", "utf8"))
);

const MARKER = /^\s*--\s*=*\s*ROLLBACK/im;                 // commented ROLLBACK header
const UNDO = /^\s*--[^\n]*\b(DROP|ALTER|REVOKE|GRANT|RESET|DELETE FROM|TRUNCATE|CREATE INDEX|CREATE TABLE|re-apply)\b/im;
const NOTE = /^\s*--\s*NOTE:/im;

const missingMarker: string[] = [];
const missingUndo: string[] = [];
const executableRollback: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(`${DIR}/${f}`, "utf8");
  if (!MARKER.test(src)) missingMarker.push(f);
  if (!UNDO.test(src) && !NOTE.test(src)) missingUndo.push(f);
  // an uncommented ROLLBACK; statement would execute inside the migration
  for (const line of src.split("\n")) {
    if (/^\s*ROLLBACK\s*;/i.test(line)) { executableRollback.push(f); break; }
  }
}
check("every migration has a commented ROLLBACK header", missingMarker.length === 0);
if (missingMarker.length) console.log("  missing marker: " + missingMarker.join(", "));
check(
  "every migration has a commented undo statement or manual-restore NOTE",
  missingUndo.length === 0
);
if (missingUndo.length) console.log("  missing undo: " + missingUndo.join(", "));
check(
  "no migration contains an executable (uncommented) ROLLBACK statement",
  executableRollback.length === 0
);
if (executableRollback.length) console.log("  executable: " + executableRollback.join(", "));

// Anchors against real files (house formats already on main).
const n = fs.readFileSync(`${DIR}/20261106n_covering_index_jobs_list.sql`, "utf8");
check(
  "anchor: 20261106n keeps its commented ROLLBACK block with DROP INDEX",
  n.includes("-- ROLLBACK (run manually as one autocommit statement") &&
    n.includes("--   DROP INDEX CONCURRENTLY IF EXISTS public.jobs_active_list_covering_idx;")
);
const c = fs.readFileSync(`${DIR}/20261105c_database_safety.sql`, "utf8");
check(
  "anchor: 20261105c keeps its ROLLBACK INSTRUCTIONS with commented ALTER ROLE RESET",
  /--\s*ROLLBACK INSTRUCTIONS/i.test(c) && /^\s*--\s*alter role authenticator reset statement_timeout/im.test(c)
);

// The 41 migrations this PR documented: all must now carry marker + undo/NOTE.
const PREVIOUSLY_UNDOCUMENTED = [
  "20261001_filter_upgrades.sql", "20261001_ingestion_pipeline.sql",
  "20261001_phase1_storage_optimization.sql", "20261008_phase1_candidate_and_tracker.sql",
  "20261008_phase2_daily_digest_cron.sql", "20261008_phase3_subscriptions_and_billing.sql",
  "20261008_phase4_user_preferences_and_onboarding.sql", "20261009_candidate_profile_location.sql",
  "20261009_production_fixes.sql", "20261010_lock_paid_jobs_data.sql",
  "20261010_tailored_resumes.sql", "20261011_admin_page_views_and_blocked_users.sql",
  "20261011_ai_usage_quotas.sql", "20261016_lock_job_descriptions.sql",
  "20261016_worldwide_company_counts.sql", "20261019_webhook_events.sql",
  "20261020_admin_audit_log.sql", "20261020_rate_limits.sql",
  "20261028_ats_board_ingestion.sql", "20261029_early_access_emails.sql",
  "20261030_early_access_approved.sql", "20261031_account_delete_and_private_resumes.sql",
  "20261101_company_logos_bucket.sql", "20261101_lock_page_views_insert.sql",
  "20261101_lock_scraper_metadata.sql", "20261101_user_preferences_eligibility_filter.sql",
  "20261103_plans_addons_usage.sql", "20261103b_consume_set_fn.sql",
  "20261103c_fulfil_payment_fn.sql", "20261103d_consume_atomic_fn.sql",
  "20261103e_weekly_price_692.sql", "20261103f_subscriptions_unique_user.sql",
  "20261103g_fulfil_payment_upgrade_extend.sql", "20261103h_ai_idempotency_scoped.sql",
  "20261104_early_access_approval_fields.sql", "20261104a_global_ai_budget.sql",
  "20261104b_payment_order_mode_isolation.sql", "20261105a_failed_events.sql",
  "20261105b_email_suppressions.sql", "20261105b_web_vitals.sql",
  "20261106b_early_access_attribution.sql",
];
const stillBare = PREVIOUSLY_UNDOCUMENTED.filter((f) => {
  const p = `${DIR}/${f}`;
  if (!fs.existsSync(p)) return true;
  const src = fs.readFileSync(p, "utf8");
  return !(MARKER.test(src) && (UNDO.test(src) || NOTE.test(src)));
});
check(
  `all ${PREVIOUSLY_UNDOCUMENTED.length} previously undocumented migrations now have rollback sections`,
  stillBare.length === 0
);
if (stillBare.length) console.log("  still bare: " + stillBare.join(", "));

// Re-declaration safety: a migration that re-declares another migration's
// objects must not claim dropping them as its own rollback (spot anchor).
const pf = fs.readFileSync(`${DIR}/20261009_production_fixes.sql`, "utf8");
check(
  "anchor: 20261009_production_fixes rollback notes re-declared tables instead of dropping them",
  /--\s+NOTE: re-declares table public\.candidate_profiles/.test(pf)
);

console.log(`\n${passed} passed, ${failed} failed (${files.length} migrations scanned)`);
process.exit(failed ? 1 : 0);
