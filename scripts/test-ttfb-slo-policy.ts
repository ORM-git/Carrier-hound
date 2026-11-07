#!/usr/bin/env tsx
// TTFB SLO & alerting policy (Backend sheet rank 27).
//
// Guards the invariants of the implementation shipped in #329
// (scripts/check-ttfb-slo.ts + src/lib/observability/slo.ts, behavioral
// coverage in src/lib/__tests__/slo.test.ts):
//   1. The SLO target stays traceable to docs/slo.md (p75 <= 800 ms, the
//      web.dev "good" threshold, provisional standard-based target per the
//      doc) - the check's constants must match the doc, never drift.
//   2. Breach exits 1 and emits [SLO-ALERT]; no-data and errors exit 2 -
//      the check can never silently pass on missing or broken telemetry.
//   3. Sample-integrity guards survive edits: explicit pagination, window
//      drift detection, truncation detection (never evaluate a partial
//      window as complete).
//   4. The RUM source stays wired: /api/track collects web_vitals TTFB.
//   5. Behavioral unit coverage stays in place.

import { existsSync, readFileSync } from "node:fs";

const check = readFileSync("scripts/check-ttfb-slo.ts", "utf8");
const sloDoc = readFileSync("docs/slo.md", "utf8");
const sloLib = readFileSync("src/lib/observability/slo.ts", "utf8");
const track = readFileSync("src/app/api/track/route.ts", "utf8");

let passed = 0;
let failed = 0;
function t(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

// 1. Traceable target.
t("docs/slo.md keeps the TTFB row (p75 <= 800 ms)", /TTFB \(p75\).*<=\s*800\s*ms/.test(sloDoc));
t("docs/slo.md names scripts/check-ttfb-slo.ts as the evaluator", sloDoc.includes("scripts/check-ttfb-slo.ts"));
t("docs/slo.md marks the target provisional/standard-based (not invented)", sloDoc.includes("provisional standard-based target"));
t("check target matches the doc exactly (p75, 800ms)", check.includes("{ percentile: 75, maxMs: 800 }"));

// 2. Alert semantics.
t("breach emits [SLO-ALERT] and exits 1", check.includes("[SLO-ALERT]") && /status === "breach"[\s\S]*?exit\(1\)/.test(check));
t("no_data exits 2 (never silently green)", check.includes('"no_data"') && check.includes("No valid TTFB samples"));
t("unhandled errors exit 2", check.includes("[SLO-CHECK-ERROR]") && check.includes("process.exit(2)"));

// 3. Sample integrity.
t("paginates explicitly (Supabase 1000-row cap)", check.includes("offset += 1000"));
t("detects mid-window count drift", check.includes("count !== expectedCount"));
t("detects truncation instead of evaluating a partial window", check.includes("truncated before the full window"));
t("caps runaway windows instead of truncating", check.includes("exceeds 10000 samples"));

// 4. RUM source wired.
t("check reads web_vitals name=TTFB", check.includes('"web_vitals"') && check.includes('"TTFB"'));
t("/api/track collects web_vitals", track.includes("web_vitals"));

// 5. Behavioral coverage stays.
t("slo.ts exposes evaluateSlo + percentile", sloLib.includes("evaluateSlo") && sloLib.includes("percentile"));
t("unit test file exists", existsSync("src/lib/__tests__/slo.test.ts"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
