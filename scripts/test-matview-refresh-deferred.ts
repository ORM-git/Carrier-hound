/**
 * Offline test for Deferred Materialized View Refresh decoupling (DB #68).
 *
 * Verifies:
 * 1. Migration 20261108c_matview_refresh_deferred.sql exists and is marked NOT APPLIED.
 * 2. Control table (public.matview_refresh_control) has RLS enabled and is service-role only.
 * 3. Ingest trigger function (on_ingest_run_completed_refresh_worldwide) only records a
 *    refresh request (sets is_dirty = true in control table) without refreshing inside the transaction.
 * 4. Separate service-role-only function (process_deferred_matview_refresh) processes the deferred request:
 *    - Checks is_dirty and exits early if clean.
 *    - Attempts REFRESH MATERIALIZED VIEW CONCURRENTLY first.
 *    - On concurrent failure, logs an explicit fallback warning (NOT silent).
 *    - Executes blocking fallback refresh.
 *    - Resets is_dirty = false, updates last_refreshed_at and last_refresh_mode.
 *    - Preserves staleness telemetry insert into public.matview_refresh_log.
 * 5. Direct scheduled refresh (refresh_worldwide_company_counts) logs fallback rather than silent downgrade.
 * 6. Behavioral simulation verifies request flow, process flow, and fallback warning logging.
 * 7. Negative control exits non-zero (code 1).
 *
 * Run: npx tsx scripts/test-matview-refresh-deferred.ts
 * Negative control: npx tsx scripts/test-matview-refresh-deferred.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

// ============================================================================
// SIMULATION MODEL: Replicates PL/pgSQL Deferred State Machine in Memory
// ============================================================================

export interface MatviewRefreshControlRow {
  matview_name: string;
  is_dirty: boolean;
  requested_at: Date;
  last_refreshed_at: Date | null;
  last_refresh_mode: "concurrent" | "blocking" | "failed" | null;
}

export interface MatviewRefreshLogRow {
  matview_name: string;
  refreshed_at: Date;
  duration_ms: number;
}

export class DeferredMatviewRefreshSimulator {
  public controlTable = new Map<string, MatviewRefreshControlRow>();
  public refreshLogs: MatviewRefreshLogRow[] = [];
  public warningLogs: string[] = [];

  // Hooks to simulate database behaviors
  public shouldFailConcurrent = false;
  public shouldFailBlocking = false;
  public concurrentErrorMessage = "cannot run inside a transaction block";

  constructor() {
    this.controlTable.set("worldwide_company_counts", {
      matview_name: "worldwide_company_counts",
      is_dirty: false,
      requested_at: new Date(),
      last_refreshed_at: null,
      last_refresh_mode: null,
    });
  }

  /**
   * Simulates the trigger: on_ingest_run_completed_refresh_worldwide()
   * Runs inside the ingest transaction. Only sets is_dirty = true in control table.
   */
  public triggerOnIngestRunCompleted(): void {
    const existing = this.controlTable.get("worldwide_company_counts");
    if (existing) {
      existing.is_dirty = true;
      existing.requested_at = new Date();
    } else {
      this.controlTable.set("worldwide_company_counts", {
        matview_name: "worldwide_company_counts",
        is_dirty: true,
        requested_at: new Date(),
        last_refreshed_at: null,
        last_refresh_mode: null,
      });
    }
  }

  /**
   * Simulates the separate service-role function: process_deferred_matview_refresh()
   * Runs post-commit outside the ingest transaction.
   */
  public processDeferredMatviewRefresh(matviewName = "worldwide_company_counts"): boolean {
    const control = this.controlTable.get(matviewName);
    if (!control || !control.is_dirty) {
      return false; // Early exit when clean
    }

    const started = Date.now();
    let refreshed = false;
    let mode: "concurrent" | "blocking" | "failed" = "concurrent";

    // 1. Attempt concurrent refresh
    if (!this.shouldFailConcurrent) {
      refreshed = true;
      mode = "concurrent";
    } else {
      // Log fallback rather than silent downgrade
      const warnMsg = `Materialized view ${matviewName} concurrent refresh failed (${this.concurrentErrorMessage}), falling back to blocking refresh`;
      this.warningLogs.push(warnMsg);

      // 2. Fallback to blocking refresh
      if (!this.shouldFailBlocking) {
        refreshed = true;
        mode = "blocking";
      } else {
        this.warningLogs.push(`Materialized view ${matviewName} blocking refresh failed: deadlock`);
        mode = "failed";
      }
    }

    // 3. Update control state and insert telemetry
    if (refreshed) {
      control.is_dirty = false;
      control.last_refreshed_at = new Date();
      control.last_refresh_mode = mode;

      this.refreshLogs.push({
        matview_name: matviewName,
        refreshed_at: new Date(),
        duration_ms: Math.max(0, Date.now() - started),
      });
      return true;
    } else {
      control.last_refreshed_at = new Date();
      control.last_refresh_mode = "failed";
      return false;
    }
  }

  /**
   * Simulates the direct scheduled refresh function: refresh_worldwide_company_counts()
   */
  public refreshWorldwideCompanyCountsDirect(): void {
    const started = Date.now();
    let refreshed = false;
    let mode: "concurrent" | "blocking" | "failed" = "concurrent";

    if (!this.shouldFailConcurrent) {
      refreshed = true;
      mode = "concurrent";
    } else {
      const warnMsg = `worldwide_company_counts concurrent refresh failed (${this.concurrentErrorMessage}), falling back to blocking refresh`;
      this.warningLogs.push(warnMsg);

      if (!this.shouldFailBlocking) {
        refreshed = true;
        mode = "blocking";
      } else {
        this.warningLogs.push("worldwide_company_counts refresh failed: fatal");
        mode = "failed";
      }
    }

    if (refreshed) {
      const control = this.controlTable.get("worldwide_company_counts");
      if (control) {
        control.is_dirty = false;
        control.last_refreshed_at = new Date();
        control.last_refresh_mode = mode;
      }

      this.refreshLogs.push({
        matview_name: "worldwide_company_counts",
        refreshed_at: new Date(),
        duration_ms: Math.max(0, Date.now() - started),
      });
    }
  }
}

// ============================================================================
// TEST RUNNER
// ============================================================================

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("Running negative control check...");
    check("negative control: forced assertion failure", false);
    process.exit(1);
  }

  console.log("=== Test Suite: Matview Refresh Decoupling (DB #68) ===\n");

  // --------------------------------------------------------------------------
  // SECTION 1: Migration DDL & Static Security Checks
  // --------------------------------------------------------------------------
  const migPath = path.resolve("supabase/migrations/20261108c_matview_refresh_deferred.sql");
  check("migration file 20261108c_matview_refresh_deferred.sql exists", fs.existsSync(migPath));

  const migContent = fs.readFileSync(migPath, "utf8");
  check("migration marked NOT APPLIED", migContent.includes("Status:    NOT APPLIED"));
  check(
    "migration provides record-migration command",
    migContent.includes("node scripts/record-migration.cjs 20261108c_matview_refresh_deferred")
  );

  // Control table DDL
  check(
    "creates matview_refresh_control table with primary key",
    /create\s+table\s+if\s+not\s+exists\s+public\.matview_refresh_control\s*\([\s\S]*?matview_name\s+text\s+primary\s+key/i.test(migContent)
  );
  check(
    "control table includes is_dirty boolean column",
    /is_dirty\s+boolean\s+not\s+null\s+default\s+true/i.test(migContent)
  );
  check(
    "control table includes requested_at and last_refreshed_at",
    /requested_at\s+timestamptz/i.test(migContent) && /last_refreshed_at\s+timestamptz/i.test(migContent)
  );
  check(
    "control table includes last_refresh_mode check constraint",
    /last_refresh_mode\s+text\s+check\s*\(\s*last_refresh_mode\s+in\s*\('concurrent',\s*'blocking',\s*'failed'\)\s*\)/i.test(migContent)
  );

  // Security & RLS on control table
  check(
    "control table enables RLS",
    /alter\s+table\s+public\.matview_refresh_control\s+enable\s+row\s+level\s+security/i.test(migContent)
  );
  check(
    "control table revokes access from client roles",
    /revoke\s+all\s+on\s+table\s+public\.matview_refresh_control\s+from\s+anon,\s*authenticated/i.test(migContent)
  );
  check(
    "control table grants full access to service_role",
    /grant\s+all\s+on\s+table\s+public\.matview_refresh_control\s+to\s+service_role/i.test(migContent)
  );

  // Trigger function
  check(
    "trigger function on_ingest_run_completed_refresh_worldwide is SECURITY DEFINER with pinned search_path",
    /FUNCTION\s+public\.on_ingest_run_completed_refresh_worldwide\(\)[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*public,\s*pg_temp/i.test(migContent)
  );
  const triggerFuncBodyMatch = migContent.match(
    /create\s+or\s+replace\s+function\s+public\.on_ingest_run_completed_refresh_worldwide\(\)[\s\S]*?as\s+\$\$([\s\S]*?)\$\$;/i
  );
  check(
    "trigger function writes to matview_refresh_control instead of refreshing",
    Boolean(triggerFuncBodyMatch) &&
      triggerFuncBodyMatch![1].includes("insert into public.matview_refresh_control") &&
      !/refresh\s+materialized\s+view/i.test(triggerFuncBodyMatch![1])
  );

  // Separate deferred processing function
  check(
    "process_deferred_matview_refresh function declared with SECURITY DEFINER and pinned search_path",
    /FUNCTION\s+public\.process_deferred_matview_refresh\([\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*public,\s*pg_temp/i.test(migContent)
  );
  check(
    "process_deferred_matview_refresh revokes from public and grants to service_role only",
    /revoke\s+all\s+on\s+function\s+public\.process_deferred_matview_refresh\([^)]*\)\s+from\s+public,\s*anon,\s*authenticated/i.test(migContent) &&
      /grant\s+execute\s+on\s+function\s+public\.process_deferred_matview_refresh\([^)]*\)\s+to\s+service_role/i.test(migContent)
  );
  check(
    "process_deferred_matview_refresh attempts concurrent refresh first",
    /refresh\s+materialized\s+view\s+concurrently\s+public\.worldwide_company_counts/i.test(migContent)
  );
  check(
    "process_deferred_matview_refresh logs explicit fallback warning when concurrent refresh fails",
    /raise\s+warning\s+'Materialized\s+view\s+%\s+concurrent\s+refresh\s+failed\s+\(%\),\s*falling\s+back\s+to\s+blocking\s+refresh'/i.test(migContent)
  );
  check(
    "process_deferred_matview_refresh falls back to blocking refresh",
    /refresh\s+materialized\s+view\s+public\.worldwide_company_counts/i.test(migContent)
  );
  check(
    "process_deferred_matview_refresh logs duration to matview_refresh_log",
    /insert\s+into\s+public\.matview_refresh_log/i.test(migContent)
  );

  // Direct scheduled refresh
  check(
    "refresh_worldwide_company_counts logs fallback warning rather than silent downgrade",
    /raise\s+warning\s+'worldwide_company_counts\s+concurrent\s+refresh\s+failed\s+\(%\),\s*falling\s+back\s+to\s+blocking\s+refresh'/i.test(migContent)
  );

  // Catalog verification queries and rollback
  check("migration contains catalog verification queries", migContent.includes("READ-ONLY CATALOG VERIFICATION CHECKS"));
  check("migration contains documented rollback section", migContent.includes("ROLLBACK (run manually in the Supabase SQL editor"));

  // Documentation inventory
  const schemaDriftDoc = fs.readFileSync("docs/schema-drift-baseline.md", "utf8");
  check("docs/schema-drift-baseline.md catalogs matview_refresh_control", schemaDriftDoc.includes("matview_refresh_control"));

  const dataClassDoc = fs.readFileSync("docs/data-classification.md", "utf8");
  check("docs/data-classification.md catalogs matview_refresh_control", dataClassDoc.includes("matview_refresh_control"));

  // --------------------------------------------------------------------------
  // SECTION 2: Behavioral State Machine & Flow Verification
  // --------------------------------------------------------------------------
  console.log("\n--- SECTION 2: BEHAVIORAL SIMULATION & FALLBACK LOGGING ---");

  const sim = new DeferredMatviewRefreshSimulator();

  // Test 1: Clean state early exit
  const earlyExitResult = sim.processDeferredMatviewRefresh();
  check("clean state: processDeferredMatviewRefresh exits early without refreshing", earlyExitResult === false);
  check("clean state: no refresh log written", sim.refreshLogs.length === 0);

  // Test 2: Trigger records refresh request (Request flow)
  sim.triggerOnIngestRunCompleted();
  const ctrlAfterTrigger = sim.controlTable.get("worldwide_company_counts");
  check("trigger: marks control table row is_dirty = true", ctrlAfterTrigger?.is_dirty === true);
  check("trigger: no refresh log executed inside trigger transaction", sim.refreshLogs.length === 0);

  // Test 3: Post-commit deferred processing happy path (Concurrent)
  const happyResult = sim.processDeferredMatviewRefresh();
  check("process: executes refresh when dirty", happyResult === true);
  const ctrlAfterHappy = sim.controlTable.get("worldwide_company_counts");
  check("process: resets is_dirty = false", ctrlAfterHappy?.is_dirty === false);
  check("process: records last_refresh_mode = concurrent", ctrlAfterHappy?.last_refresh_mode === "concurrent");
  check("process: inserts entry into matview_refresh_log", sim.refreshLogs.length === 1);
  check("process: no fallback warnings logged on happy path", sim.warningLogs.length === 0);

  // Test 4: Fallback logging flow (Concurrent failure -> Logged Warning -> Blocking Refresh)
  sim.triggerOnIngestRunCompleted();
  sim.shouldFailConcurrent = true;
  sim.warningLogs = [];

  const fallbackResult = sim.processDeferredMatviewRefresh();
  check("fallback: successfully refreshes via blocking fallback", fallbackResult === true);
  const ctrlAfterFallback = sim.controlTable.get("worldwide_company_counts");
  check("fallback: resets is_dirty = false", ctrlAfterFallback?.is_dirty === false);
  check("fallback: records last_refresh_mode = blocking", ctrlAfterFallback?.last_refresh_mode === "blocking");
  check("fallback: logs explicit warning message (NOT silent)", sim.warningLogs.length === 1);
  check(
    "fallback: warning message includes concurrent error and fallback notice",
    sim.warningLogs[0].includes("concurrent refresh failed") &&
      sim.warningLogs[0].includes("falling back to blocking refresh")
  );
  check("fallback: inserts duration entry into matview_refresh_log", sim.refreshLogs.length === 2);

  // Test 5: Direct scheduled refresh fallback logging
  sim.warningLogs = [];
  sim.refreshWorldwideCompanyCountsDirect();
  check("direct refresh: logs warning when concurrent refresh fails", sim.warningLogs.length === 1);
  check(
    "direct refresh: warning notice identifies fallback",
    sim.warningLogs[0].includes("worldwide_company_counts concurrent refresh failed")
  );
  check("direct refresh: inserts duration entry into matview_refresh_log", sim.refreshLogs.length === 3);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
