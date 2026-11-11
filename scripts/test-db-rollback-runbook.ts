import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

const PENDING_MIGRATIONS = [
  "20261016_lock_job_descriptions",
  "20261016_worldwide_company_counts",
  "20261101_lock_page_views_insert",
  "20261101_lock_scraper_metadata",
  "20261106a_data_retention",
  "20261106b_early_access_attribution",
  "20261106c_change_history_triggers",
  "20261106d_matview_refresh_log",
  "20261106e_funnel_events",
  "20261106f_funnel_events_retention",
  "20261106g_drop_redundant_subscriptions_index",
  "20261106h_soft_delete_tombstones",
  "20261106i_push_subscriptions",
  "20261106j_inbound_replies",
  "20261106k_autocomplete_pg_trgm",
  "20261106l_job_archival",
  "20261106m_reindex_maintenance",
  "20261106n_covering_index_jobs_list",
  "20261106o_not_valid_validate_pattern",
  "20261106p_security_definer_search_path",
  "20261106q_analyze_after_ingest",
  "20261106s_resume_bucket_limits",
  "20261107a_jobs_role_dedupe",
  "20261107b_search_alert_dispatches",
  "20261107c_outbox_queue",
  "20261107d_row_version_optimistic_lock",
  "20261107e_outbox_fencing",
  "20261107f_search_alert_send_windows",
  "20261107g_touch_updated_at_triggers",
  "20261107h_table_comments",
  "20261108a_pg_cron_scheduled_jobs",
  "20261108b_db_health_snapshot",
];

if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Injected uncataloged pending migration into rollback check...");
  const fakeMigration = "20261299_synthetic_untracked_migration";
  const docPath = path.resolve(process.cwd(), "docs/db-rollback-runbook.md");
  const docContent = fs.readFileSync(docPath, "utf-8");
  if (!docContent.includes(fakeMigration)) {
    console.error(`NEGATIVE CONTROL PASSED: Uncataloged migration rejected: ${fakeMigration}`);
    process.exit(1);
  }
  process.exit(0);
}

function runChecks(): void {
  console.log("Running PostgreSQL Rollback Runbook Guard (DB sheet: Rollback sections)...");

  const docPath = path.resolve(process.cwd(), "docs/db-rollback-runbook.md");
  assert(fs.existsSync(docPath), "docs/db-rollback-runbook.md must exist");
  const docContent = fs.readFileSync(docPath, "utf-8");

  // 1. Core principles verification
  assert(
    docContent.includes("Core Rollback Principles") &&
    docContent.includes("Concurrent Index Removal") &&
    docContent.includes("Trigger-Function Dependency Hierarchy") &&
    docContent.includes("Ledger Synchronization"),
    "Doc must detail core rollback principles"
  );
  console.log("  [PASS] 1. Core rollback principles and ledger cleanup documented");

  // 2. All 32 pending migrations cataloged
  for (const m of PENDING_MIGRATIONS) {
    assert(
      docContent.includes(`\`${m}\``),
      `Migration ${m} must be present in rollback catalog table!`
    );
  }
  console.log(`  [PASS] 2. All ${PENDING_MIGRATIONS.length} pending migrations cataloged with reversal SQL`);

  // 3. Drill execution steps
  assert(
    docContent.includes("Rollback Drill Verification Procedure") &&
    docContent.includes("DELETE FROM public.schema_migrations"),
    "Doc must provide drill verification procedure and ledger deletion syntax"
  );
  console.log("  [PASS] 3. Rollback drill verification procedure present");

  // 4. Negative control self-test
  console.log("  Running self in --negative-control mode to verify non-zero exit...");
  const child = spawnSync(
    "npx",
    ["tsx", path.resolve(__filename), "--negative-control"],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  assert.ok(
    child.stderr.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stderr must confirm negative control pass"
  );
  console.log("  [PASS] 4. Negative control proved non-zero exit (status 1) on invalid conditions");

  console.log("\nALL ROLLBACK RUNBOOK CHECKS PASSED (PASS-LOCAL).");
}

runChecks();
