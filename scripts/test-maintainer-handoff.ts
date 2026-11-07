#!/usr/bin/env tsx
// Maintainer handoff integrity (Backend sheet rank 25: Bus Factor).
//
// Guarantees:
//   1. docs/maintainer-handoff.md keeps its three sections and every repo
//      path it tells a new maintainer to use actually exists (the handoff
//      doc cannot silently go stale when files move).
//   2. Honesty markers survive edits: no backup maintainer is claimed as
//      verified, capability states stay "Not verified" until the owner
//      records evidence, and the doc keeps the rule against listing
//      personal/secret details in the repo.

import { existsSync, readFileSync } from "node:fs";

const doc = readFileSync("docs/maintainer-handoff.md", "utf8");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

// Sections.
for (const section of ["## Repository handoff", "## Production access handoff", "## Completion evidence"]) {
  check(`handoff keeps section "${section}"`, doc.includes(section));
}

// Cited paths must exist (the handoff's accuracy gate).
const cited: Array<[string, string]> = [
  ["src/app/api/stats/route.ts", "public request trace target"],
  [".github/workflows/ci.yml", "CI test command source"],
  ["docs/runbooks.md", "runbooks"],
  ["docs/slo.md", "SLO doc"],
  ["docs/incident-log.md", "incident log"],
  ["docs/retention-policy.md", "retention policy"],
  ["docs/security/secrets-rotation-runbook.md", "secrets rotation runbook"],
];
for (const [path, label] of cited) {
  check(`handoff cites ${path} (${label})`, doc.includes(path));
  check(`cited path exists: ${path}`, existsSync(path));
}

// The CI test command the doc points at must still exist.
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
check("ci.yml still defines the test suite run (npm run test:all)", ci.includes("npm run test:all"));
check("package.json still defines test:all", readFileSync("package.json", "utf8").includes('"test:all"'));

// Honesty markers.
check("no backup maintainer claimed as verified", doc.includes("No secondary maintainer has been verified"));
check("capability states stay Not verified", (doc.match(/Not verified/g) || []).length >= 6);
check("keeps the no-secrets-in-repo rule", doc.includes("should not list personal numbers"));
check("bus-factor reduction honestly marked incomplete until evidence exists", doc.includes("bus-factor reduction is incomplete"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
