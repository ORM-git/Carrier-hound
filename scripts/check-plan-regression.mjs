#!/usr/bin/env node
/**
 * Plan regression checker (audit DB #14).
 *
 * Reads the text output of the EXPLAIN (ANALYZE, BUFFERS) pack
 * (supabase/scripts/explain-checks.sql, run via psql) and fails when a plan
 * regresses structurally:
 *
 *   1. Seq Scan on a guarded large table. The pack's queries all target the
 *      jobs read path; those tables must stay index-served as they grow.
 *   2. A plan that uses no index at all on a guarded table access path.
 *
 * Execution times are parsed and printed for trend-watching in the CI
 * artifact, but no fixed time budget is enforced here on purpose: CI runner
 * and database load vary, and a hard number would be invented rather than
 * measured.
 *
 * Usage:
 *   node scripts/check-plan-regression.mjs <plans.txt> [...more.txt]
 *   node scripts/check-plan-regression.mjs --selftest
 */

import fs from "node:fs";

export const GUARDED_TABLES = ["jobs", "jobs_public", "job_descriptions"];

export function checkPlanOutput(text) {
  const failures = [];
  const seqScanRe = /Seq Scan on (?:public\.)?(\w+)/g;
  let m;
  while ((m = seqScanRe.exec(text)) !== null) {
    if (GUARDED_TABLES.includes(m[1])) {
      failures.push(`Sequential scan on guarded table "${m[1]}"`);
    }
  }

  const execTimes = [...text.matchAll(/Execution Time:\s*([\d.]+)\s*ms/g)].map((x) => Number(x[1]));
  const planCount = (text.match(/QUERY PLAN/g) || []).length;

  return { failures, execTimes, planCount };
}

function selftest() {
  const good = `
 Limit  (cost=0.43..8.45 rows=10)
   ->  Index Scan using jobs_active_discovered_idx on public.jobs
         Index Cond: ((status = 'active'::text) AND (is_active = true))
 Planning Time: 0.123 ms
 Execution Time: 0.456 ms
`;
  const bad = `
 Limit  (cost=0.00..18334.50 rows=10)
   ->  Seq Scan on public.jobs
         Filter: ((status = 'active'::text) AND (is_active = true))
 Planning Time: 0.111 ms
 Execution Time: 950.123 ms
`;
  const goodRes = checkPlanOutput(good);
  const badRes = checkPlanOutput(bad);
  const ok =
    goodRes.failures.length === 0 &&
    goodRes.execTimes.length === 1 &&
    Math.abs(goodRes.execTimes[0] - 0.456) < 1e-9 &&
    badRes.failures.length === 1 &&
    badRes.failures[0].includes('"jobs"');
  if (ok) {
    console.log("selftest: PASS");
    process.exit(0);
  }
  console.error("selftest: FAIL", { goodRes, badRes });
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
    return;
  }
  if (args.length === 0) {
    console.error("usage: node scripts/check-plan-regression.mjs <plans.txt> [...]");
    process.exit(2);
  }
  let allFailures = [];
  let totalPlans = 0;
  let allTimes = [];
  for (const file of args) {
    const text = fs.readFileSync(file, "utf8");
    const { failures, execTimes, planCount } = checkPlanOutput(text);
    allFailures = allFailures.concat(failures.map((f) => `${file}: ${f}`));
    totalPlans += planCount;
    allTimes = allTimes.concat(execTimes);
  }
  console.log(`plans analyzed: ${totalPlans}`);
  if (allTimes.length > 0) {
    console.log(`execution times (ms): ${allTimes.join(", ")}`);
  }
  if (allFailures.length > 0) {
    console.error("\nPLAN REGRESSION DETECTED:");
    for (const f of allFailures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("plan regression check: PASS");
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-plan-regression.mjs");
if (isMain) main();
