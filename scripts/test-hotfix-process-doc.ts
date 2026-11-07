/**
 * Offline static test for the Hotfix Process row (DevOps/CI): the
 * documented revert-first hotfix process must stay present and keep
 * pointing at the real files it references, so the process cannot rot
 * away from the repo it describes.
 * Run: npx tsx scripts/test-hotfix-process-doc.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const docPath = "docs/hotfix-process.md";
check("hotfix process doc exists", fs.existsSync(docPath));
const doc = fs.readFileSync(docPath, "utf8");

check("doc is revert-first", /git revert/.test(doc) && /Revert first/.test(doc));
check("doc covers migration hotfixes (no editing applied migrations)", /Never edit an already-applied migration/.test(doc));
check("doc requires incident-log recording", /docs\/incident-log\.md/.test(doc));
check("doc requires postmortems for user-facing impact", /docs\/postmortems\//.test(doc));
check("doc forbids agent-authored user copy", /never agent-authored copy/.test(doc));

// Every repo path the doc relies on must exist.
for (const p of [
  "docs/incident-log.md",
  "docs/postmortems",
  "docs/zero-downtime-migrations.md",
  "supabase/scripts/rollback-notes.md",
  "scripts/record-migration.cjs",
  "scripts/suite-runner.ts",
]) {
  check(`referenced path exists: ${p}`, fs.existsSync(p));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
