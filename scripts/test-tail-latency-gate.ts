/**
 * Static checks for BE#9 (Tail Latency) and BE#39 (P99 Latency): the k6 load
 * test must gate p99, not just report it, and the SLO doc must name the same
 * p99 target. Run: npx tsx scripts/test-tail-latency-gate.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const k6 = fs.readFileSync("scripts/loadtest/cm-load.js", "utf8");
const slo = fs.readFileSync("docs/slo.md", "utf8");

const k6Match = k6.match(/threshold:\s*'p\(99\)<(\d+)'/);
const sloMatch = slo.match(/p99\s*<\s*(\d+)s/);

check("k6 gates p99 with a pass/fail threshold", !!k6Match);
check("k6 p99 threshold still aborts like the p95 gate", /p\(99\)<\d+', abortOnFail: true/.test(k6));
check("k6 keeps the existing p95 < 3000 gate", k6.includes("p(95)<3000"));
check("SLO doc names a p99 target", !!sloMatch);
if (k6Match && sloMatch) {
  check(
    "k6 threshold and SLO doc agree (5s = 5000ms)",
    k6Match[1] === "5000" && sloMatch[1] === "5"
  );
} else {
  check("k6 threshold and SLO doc agree", false);
}
check("p99 gate is documented as provisional", /p99 target is provisional/.test(k6));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
