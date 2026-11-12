/**
 * CareerMonke — Operational Log Retention Purge Runner
 *
 * Calls public.purge_operational_logs (migration 20261106a) with the
 * service role, prints the per-table result table, and records the run in
 * cron_run_logs. Requires the migration to be applied first; fails closed
 * with a clear message when the function is missing.
 *
 * Also calls public.archive_expired_jobs (migration 20261106l, Database row
 * #8) to move long-expired jobs into jobs_archive; that step is fail-open
 * and skips with a warning until the migration is applied.
 *
 * Also calls public.reindex_bloated_indexes (migration 20261106m, Database
 * row #11) to rebuild bloated public-schema indexes; that step is fail-open
 * and skips with a warning until the migration is applied.
 *
 * Usage:
 *   npx tsx scripts/retention-cron.ts         # real purge
 *   npx tsx scripts/retention-cron.ts --dry   # counts only, no deletes
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { reportCronFailure } from "./lib/cron-sentry";
import { startCronHeartbeat } from "./lib/cron-heartbeat";
import { summarizeReindexResults, type ReindexRow } from "../src/lib/maintenance/reindex";

type PurgeRow = {
  table_name: string;
  cutoff: string;
  rows_matched: number;
  rows_deleted: number;
};

type ArchiveRow = {
  cutoff: string;
  rows_matched: number;
  rows_archived: number;
};


async function main() {
  const dry = process.argv.slice(2).includes("--dry");

  console.log("============================================================");
  console.log("  CareerMonke Retention Purge Cron Runner");
  console.log("============================================================");
  console.log(`Execution Mode: ${dry ? "DRY RUN (counts only)" : "REAL PURGE"}\n`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const startTime = Date.now();
  const { data, error } = await supabase.rpc("purge_operational_logs", {
    dry_run: dry,
  });

  if (error) {
    console.error(`✗ FAILED: purge_operational_logs RPC error: ${error.message}`);
    if (/could not find|does not exist|function/i.test(error.message)) {
      console.error(
        "Migration 20261106a_data_retention.sql is not applied yet. Apply it in the Supabase SQL editor first."
      );
    }
    await supabase.from("cron_run_logs").insert({
      job_type: "retention_purge",
      status: "failed",
      error_message: error.message.slice(0, 500),
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
    });
    process.exit(1);
  }

  const rows = (data || []) as PurgeRow[];
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("------------------------------------------------------------");
  for (const r of rows) {
    console.log(
      `${r.table_name.padEnd(18)} matched=${String(r.rows_matched).padStart(6)}  deleted=${String(r.rows_deleted).padStart(6)}  cutoff=${r.cutoff}`
    );
  }
  console.log("------------------------------------------------------------");
  console.log(`Status:         ✓ SUCCESS`);
  console.log(`Duration:       ${durationSec}s`);
  console.log("------------------------------------------------------------\n");

  await supabase.from("cron_run_logs").insert({
    job_type: "retention_purge",
    status: "success",
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
    metadata: { dry_run: dry, results: rows },
  });

  // Job archival (migration 20261106l): moves long-expired jobs out of the
  // hot table into jobs_archive. Fail-open: until the migration is applied
  // the function is missing - warn and skip without failing the cron run.
  const archiveStart = Date.now();
  const { data: archiveData, error: archiveError } = await supabase.rpc(
    "archive_expired_jobs",
    { dry_run: dry }
  );

  if (archiveError) {
    if (/could not find|does not exist|function|PGRST202/i.test(archiveError.message)) {
      console.log(
        "- Skipping job archival: archive_expired_jobs is not applied yet (migration 20261106l_job_archival.sql)."
      );
    } else {
      console.warn(
        `- Job archival RPC error (non-fatal): ${archiveError.message}`
      );
      try {
        await supabase.from("cron_run_logs").insert({
          job_type: "job_archival",
          status: "failed",
          error_message: archiveError.message.slice(0, 500),
          started_at: new Date(archiveStart).toISOString(),
          completed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.warn(`- cron_run_logs insert failed (non-fatal): ${logErr}`);
      }
    }
  } else {
    const ar = ((archiveData || []) as ArchiveRow[])[0];
    if (ar) {
      console.log(
        `Job archival:    matched=${ar.rows_matched}  archived=${ar.rows_archived}  cutoff=${ar.cutoff}`
      );
    }
    try {
      await supabase.from("cron_run_logs").insert({
        job_type: "job_archival",
        status: "success",
        started_at: new Date(archiveStart).toISOString(),
        completed_at: new Date().toISOString(),
        metadata: { dry_run: dry, results: archiveData },
      });
    } catch (logErr) {
      console.warn(`- cron_run_logs insert failed (non-fatal): ${logErr}`);
    }
  }

  // Index maintenance (migration 20261106m, Database row #11): rebuilds
  // public-schema indexes above the size threshold (plain REINDEX in the
  // off-peak weekly slot; REINDEX CONCURRENTLY cannot run inside a
  // function). Fail-open: until the migration is applied the function is
  // missing - warn and skip without failing the cron run.
  const reindexStart = Date.now();
  const { data: reindexData, error: reindexError } = await supabase.rpc(
    "reindex_bloated_indexes",
    { dry_run: dry }
  );

  if (reindexError) {
    if (/could not find|does not exist|function|PGRST202/i.test(reindexError.message)) {
      console.log(
        "- Skipping index maintenance: reindex_bloated_indexes is not applied yet (migration 20261106m_reindex_maintenance.sql)."
      );
    } else {
      console.warn(
        `- Index maintenance RPC error (non-fatal): ${reindexError.message}`
      );
      try {
        await supabase.from("cron_run_logs").insert({
          job_type: "reindex_maintenance",
          status: "failed",
          error_message: reindexError.message.slice(0, 500),
          started_at: new Date(reindexStart).toISOString(),
          completed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.warn(`- cron_run_logs insert failed (non-fatal): ${logErr}`);
      }
    }
  } else {
    const rrows = (reindexData || []) as ReindexRow[];
    const summary = summarizeReindexResults(rrows);
    console.log(
      `Index maintenance: candidates=${rrows.length}  reindexed=${summary.reindexed}  failed=${summary.failed}  mode=${dry ? "dry" : "real"}`
    );
    try {
      await supabase.from("cron_run_logs").insert({
        job_type: "reindex_maintenance",
        status: summary.status,
        error_message: summary.errorMessage,
        started_at: new Date(reindexStart).toISOString(),
        completed_at: new Date().toISOString(),
        metadata: { dry_run: dry, results: reindexData, reindexed: summary.reindexed, failed: summary.failed },
      });
    } catch (logErr) {
      console.warn(`- cron_run_logs insert failed (non-fatal): ${logErr}`);
    }
  }
}

const heartbeat = startCronHeartbeat("retention");

main()
  .then(() => heartbeat.ok())
  .catch(async (err) => {
  console.error("Fatal unhandled retention cron error:", err);
  await reportCronFailure("retention", err);
  await heartbeat.error();
  process.exit(1);
});
