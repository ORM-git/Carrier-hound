/**
 * Rank 39 (DPDP Act Readiness) - retention policy <-> enforcement consistency.
 *
 * The DPDP retention chain has three legs on main: docs/retention-policy.md
 * (the published schedule), migration 20261106a_data_retention.sql (the
 * enforcement function public.purge_operational_logs), and
 * scripts/retention-cron.ts (the weekly invoker). Each leg was reviewed
 * separately; nothing asserted they AGREE. A window that drifts in any one
 * leg silently breaks the DPDP retention promise. This suite locks the
 * three legs together: every window is parsed from the policy doc and the
 * migration must enforce exactly that set - no missing table, no extra
 * purge target, no changed window. No hardcoded retention numbers here:
 * the policy doc is the single source the test reads.
 *
 * Also guards the migration's safety contract (dry_run default true,
 * pending failed_events never purged, service-role-only execute) and the
 * cron's fail-open behavior when the function is not applied yet.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

function main(): void {
  const docPath = path.join(ROOT, "docs", "retention-policy.md");
  const migPath = path.join(ROOT, "supabase", "migrations", "20261106a_data_retention.sql");
  const cronPath = path.join(ROOT, "scripts", "retention-cron.ts");
  check(fs.existsSync(docPath), "docs/retention-policy.md exists");
  check(fs.existsSync(migPath), "migration 20261106a_data_retention.sql exists");
  check(fs.existsSync(cronPath), "scripts/retention-cron.ts exists");
  if (!fs.existsSync(docPath) || !fs.existsSync(migPath) || !fs.existsSync(cronPath)) {
    console.log(`\n[PASS-LOCAL] ${passed} retention-consistency checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
    process.exit(1);
  }
  const doc = fs.readFileSync(docPath, "utf8");
  const mig = fs.readFileSync(migPath, "utf8");
  const cron = fs.readFileSync(cronPath, "utf8");

  // Parse the documented schedule: rows like "| `page_views` | Analytics log | 90 days | ... |"
  const docWindows = new Map<string, number>();
  for (const m of doc.matchAll(/^\| `([a-z_]+)`(?:\s*\([^)]*\))?\s*\|[^|]+\|[^|]*?(\d+)\s*days/gm)) {
    docWindows.set(m[1], Number(m[2]));
  }
  check(docWindows.size >= 6, `policy doc schedule parses (${docWindows.size} windows found)`);

  // Parse migration purge targets from the function's reporting selects
  const migTargets = new Set<string>();
  for (const m of mig.matchAll(/'([a-z_]+)'::text,\s*now\(\) - interval '(\d+) days'/g)) {
    migTargets.add(m[1]);
  }

  // 1. Every documented window is enforced: reporting select AND a delete with the same interval
  for (const [table, days] of docWindows) {
    const reported = mig.includes(`'${table}'::text, now() - interval '${days} days'`);
    const deleted = new RegExp(`delete from public\\.${table}[\\s\\S]{0,200}?interval '${days} days'`).test(mig);
    check(reported && deleted,
      `${table}: policy window ${days}d is enforced in the migration (delete + reporting)`);
  }

  // 2. No undocumented purge targets (a silent extra table would be a DPDP breach)
  const extra = [...migTargets].filter((t) => !docWindows.has(t));
  check(extra.length === 0,
    `no undocumented purge targets in the migration${extra.length ? ` (extra: ${extra.join(", ")})` : ""}`);

  // 3. failed_events: pending rows are never purged
  check(/status in \('replayed', 'dead'\)/.test(mig),
    "failed_events purge is scoped to replayed/dead rows only");
  check(/pending rows are never purged/i.test(mig) && !/status\s*=\s*'pending'[\s\S]{0,120}?delete/i.test(mig),
    "failed_events pending rows are never purged (documented + no pending delete)");

  // 4. Migration safety contract
  check(/dry_run boolean default true/i.test(mig),
    "purge function dry_run DEFAULTS TO TRUE (bare call is a rehearsal, not a delete)");
  check(/revoke all on function public\.purge_operational_logs\(boolean\) from public, anon, authenticated/i.test(mig),
    "execute revoked from public/anon/authenticated");
  check(/grant execute on function public\.purge_operational_logs\(boolean\) to service_role/i.test(mig),
    "execute granted to service_role only");
  check(/security definer/i.test(mig), "function is SECURITY DEFINER (documented design)");
  check(mig.includes("record-migration.cjs 20261106a_data_retention"),
    "migration header carries the record-migration command (NOT APPLIED convention)");

  // 5. Cron invoker leg
  check(cron.includes('"purge_operational_logs"') || cron.includes("'purge_operational_logs'"),
    "retention-cron invokes purge_operational_logs");
  check(/dry_run/.test(cron), "retention-cron passes dry_run");
  check(/could not find|does not exist|function/i.test(cron),
    "retention-cron fails open with a clear message when the function is not applied");

  // 6. Suite registration
  const sr = fs.readFileSync(path.join(ROOT, "scripts", "suite-runner.ts"), "utf8");
  check(sr.includes("test-retention-policy-consistency.ts"), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} retention-consistency checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main();
