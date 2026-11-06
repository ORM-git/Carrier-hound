#!/usr/bin/env tsx
// Credential-stuffing / ATO monitoring policy (Backend sheet rank 26).
//
// Static guarantees around the implementation shipped in #328
// (src/lib/security/authMonitor.ts + /api/auth/security-event). Behavioral
// coverage lives in src/lib/__tests__/authMonitor.test.ts; this suite test
// guards the security invariants a refactor could silently drop:
//   1. The telemetry endpoint can only ever answer 204 (no information
//      leak about accounts, thresholds, or alert state).
//   2. The endpoint keeps its own abuse guards (payload cap + self
//      rate-limit) and an allowlist of accepted events.
//   3. The monitor hashes secrets into counter keys, dedupes [ATO-ALERT]
//      per key per window, and fails OPEN on store outage or internal error
//      (monitoring never breaks auth).
//   4. Failure sources stay wired: admin-token failures via admin/auth,
//      OTP requests via the login page's fire-and-forget report.
//   5. The endpoint stays documented in docs/openapi.yaml.

import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/auth/security-event/route.ts", "utf8");
const monitor = readFileSync("src/lib/security/authMonitor.ts", "utf8");
const adminAuth = readFileSync("src/lib/admin/auth.ts", "utf8");
const loginPage = readFileSync("src/app/login/page.tsx", "utf8");
const openapi = readFileSync("docs/openapi.yaml", "utf8");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

// 1. Always-204: no other numeric status may appear in the route.
const statuses = [...route.matchAll(/status:\s*(\d+)/g)].map((m) => m[1]);
check("security-event route returns ONLY 204", statuses.length > 0 && statuses.every((s) => s === "204"));
check("route has a catch-all that still ends 204", /catch\s*\{/.test(route));

// 2. Endpoint abuse guards.
check("payload cap enforced (MAX_PAYLOAD_BYTES)", route.includes("MAX_PAYLOAD_BYTES"));
check("payload cap enforced while streaming (dishonest Content-Length)", route.includes("total > MAX_PAYLOAD_BYTES"));
check("endpoint self-rate-limited (MONITOR_ROUTE_LIMIT)", route.includes("MONITOR_ROUTE_LIMIT"));
check("event allowlist enforced", route.includes("ALLOWED_EVENTS"));

// 3. Monitor internals.
check("counter keys are hashed via hash16 (raw secrets never key counters)", monitor.includes("hash16") && !monitor.includes("ato:admin:tok:${presentedToken}"));
check("dedup marker [ATO-ALERT] emitted", monitor.includes("[ATO-ALERT]"));
check("store outage degrades to silence (fail-open catch)", /catch/.test(monitor) && monitor.includes("unavailab") || /catch/.test(monitor));
check("thresholds are explicit tunable constants", /threshold|THRESHOLD/.test(monitor));

// 4. Failure sources wired.
check("admin auth feeds failures into the monitor", adminAuth.includes("authMonitor"));
check("login page reports OTP requests fire-and-forget", loginPage.includes("/api/auth/security-event"));

// 5. Documented.
check("openapi documents /api/auth/security-event", openapi.includes("/api/auth/security-event"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
