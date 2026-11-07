/**
 * Rank 40 (Production Incidents) - incident log / runbook / postmortem durability.
 *
 * The ops docs are on main: docs/incident-log.md (reverse-chronological log
 * of the real incidents - job-detail 500 loop, search 500, CI red, the
 * digest 4-night failure), docs/runbooks.md (6 runbooks), and
 * docs/postmortems/ (2026-11-06 digest postmortem). What was missing is any
 * guard that they stay complete and linked: a log row pointing at a deleted
 * postmortem, or a postmortem losing its action items, is exactly how an
 * incident process rots. This suite locks the structure in. Offline,
 * fs-based, no invented thresholds - every expectation is derived from the
 * docs' own current, reviewed structure.
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
  const logPath = path.join(ROOT, "docs", "incident-log.md");
  const runbookPath = path.join(ROOT, "docs", "runbooks.md");
  const pmDir = path.join(ROOT, "docs", "postmortems");
  check(fs.existsSync(logPath), "docs/incident-log.md exists");
  check(fs.existsSync(runbookPath), "docs/runbooks.md exists");
  check(fs.existsSync(pmDir) && fs.statSync(pmDir).isDirectory(), "docs/postmortems/ exists");
  if (!fs.existsSync(logPath) || !fs.existsSync(runbookPath) || !fs.existsSync(pmDir)) {
    console.log(`\n[PASS-LOCAL] ${passed} incident-docs checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
    process.exit(1);
  }
  const log = fs.readFileSync(logPath, "utf8");
  const runbooks = fs.readFileSync(runbookPath, "utf8");

  // --- incident log structure ---
  for (const col of ["Date", "Incident", "Impact", "Root cause", "Follow-up"]) {
    check(log.includes(`| ${col} `) || log.includes(`| ${col} |`) || log.split("\n").some((l) => l.startsWith("| ") && l.split("|").map((c) => c.trim()).includes(col)),
      `incident log keeps the "${col}" column`);
  }
  check(/newest first/i.test(log), "incident log declares its ordering convention (newest first)");

  // --- the recorded real incidents stay logged ---
  const incidents: Array<[string, RegExp]> = [
    ["job-detail 500 loop", /job detail page 500 loop/i],
    ["jobs search 500", /jobs search 500/i],
    ["main CI red", /main ci red/i],
    ["digest cron multi-night failure", /digest cron failing nightly/i],
  ];
  for (const [name, re] of incidents) {
    check(re.test(log), `incident log still records: ${name}`);
  }

  // --- postmortem links resolve ---
  const pmLinks = [...log.matchAll(/\]\((postmortems\/[^)]+\.md)\)/g)].map((m) => m[1]);
  check(pmLinks.length > 0, `incident log links at least one postmortem (${pmLinks.length} found)`);
  for (const rel of pmLinks) {
    check(fs.existsSync(path.join(ROOT, "docs", rel)), `linked postmortem exists: ${rel}`);
  }

  // --- every postmortem keeps the standard sections ---
  const pmFiles = fs.readdirSync(pmDir).filter((f) => f.endsWith(".md"));
  check(pmFiles.length > 0, `docs/postmortems/ is non-empty (${pmFiles.length} postmortem/s)`);
  const sections = ["Summary", "Impact", "Timeline", "Root cause", "What went well", "What went poorly", "Action items"];
  for (const f of pmFiles) {
    const body = fs.readFileSync(path.join(pmDir, f), "utf8");
    const missing = sections.filter((s) => !body.includes(`## ${s}`));
    check(missing.length === 0,
      `${f} keeps all standard sections${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }

  // --- runbooks stay actionable ---
  const runbookCount = (runbooks.match(/^## \d+\. /gm) ?? []).length;
  check(runbookCount >= 4, `runbooks.md keeps its runbooks (${runbookCount} numbered entries)`);
  const symptomCount = (runbooks.match(/^Symptom:/gm) ?? []).length;
  check(symptomCount >= runbookCount, `every runbook names its symptom (${symptomCount}/${runbookCount})`);
  check(/workflow_dispatch/.test(runbooks), "runbooks reference the workflow_dispatch re-run path");

  // --- suite registration ---
  const sr = fs.readFileSync(path.join(ROOT, "scripts", "suite-runner.ts"), "utf8");
  check(sr.includes("test-incident-response-docs.ts"), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} incident-docs checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main();
