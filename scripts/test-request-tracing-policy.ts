#!/usr/bin/env tsx
// Request tracing / correlation ID policy (Backend sheet rank 29).
//
// Guards the invariants of #286 (middleware x-request-id on main) plus the
// Sentry join-up added with this test:
//   1. Middleware still assigns a request id to every request: well-formed
//      inbound ids honored, anything else replaced with a fresh UUID, id
//      handed to route handlers via request headers and echoed on responses.
//   2. The Sentry reporter accepts an optional request id, validates it
//      with the same pattern (junk never becomes a tag), tags events as
//      `request_id`, and stays fail-open.
//   3. reportRequestErrorToSentry reads the middleware-set header - the id
//      comes from the request, never from the error or the client payload.
//   4. The reference server wiring (/api/stats) reports unexpected errors
//      with the request id while returning the same generic 500.
//   5. Wider adoption: the hot public/user routes report their
//      unexpected-error path through the request-scoped reporter.

import { readFileSync } from "node:fs";

const middleware = readFileSync("src/middleware.ts", "utf8");
const reporter = readFileSync("src/lib/monitoring/sentryErrorReporter.ts", "utf8");
const stats = readFileSync("src/app/api/stats/route.ts", "utf8");

let passed = 0;
let failed = 0;
function t(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

// 1. Middleware assignment.
t("middleware defines the x-request-id header name", middleware.includes('"x-request-id"'));
t("well-formed inbound ids honored (pattern allowlist)", middleware.includes("REQUEST_ID_PATTERN") && /^.*\^\[A-Za-z0-9_-\].*$/m.test(middleware));
t("malformed/missing ids replaced with a fresh UUID", middleware.includes("crypto.randomUUID()"));
t("id handed to route handlers via request headers", middleware.includes("scopedHeaders.set(REQUEST_ID_HEADER, requestId)"));
t("id echoed on the response", middleware.includes('response.headers.set(REQUEST_ID_HEADER, requestId)'));

// 2. Reporter tagging.
t("reporter accepts an optional requestId", reporter.includes("ReportErrorOptions"));
t("reporter validates the id with the same pattern", reporter.includes("REQUEST_ID_PATTERN"));
t("reporter tags the Sentry scope as request_id", reporter.includes('setTag("request_id"'));
t("tagging goes through Sentry.withScope", reporter.includes("Sentry.withScope"));
t("reporter stays fail-open (catch swallows dispatch failures)", /catch\s*\{\s*\/\/ Safe no-op/.test(reporter));

// 3. Request-scoped helper.
t("reportRequestErrorToSentry reads the x-request-id header", reporter.includes('request.headers.get("x-request-id")'));

// 4. Reference wiring.
t("/api/stats imports the request-scoped reporter", stats.includes("reportRequestErrorToSentry"));
t("/api/stats reports the unexpected-error path with the request", stats.includes("reportRequestErrorToSentry(req, err)"));
t("/api/stats still returns the same generic 500 body", stats.includes('error: "temporarily unavailable"'));

// 5. Adoption: the hot public/user routes report their unexpected-error path
// with the request-scoped reporter (rank 28 wider adoption).
const adopters: Array<[string, string, string[]]> = [
  ["src/app/api/ticker/route.ts", "reportRequestErrorToSentry(req, _err)", []],
  ["src/app/api/track/route.ts", "reportRequestErrorToSentry(req, _err)", []],
  ["src/app/api/radar/route.ts", "reportRequestErrorToSentry(req, err)", ["export async function GET(req: Request)"]],
  ["src/app/api/early-access/route.ts", "reportRequestErrorToSentry(req, _err)", []],
  ["src/app/api/jobs/search/route.ts", "reportRequestErrorToSentry(req, err)", []],
  ["src/app/api/jobs/top10/route.ts", "reportRequestErrorToSentry(req, err)", []],
  ["src/app/api/jobs/pro/route.ts", "reportRequestErrorToSentry(req, err)", []],
  ["src/app/api/me/quota/route.ts", "reportRequestErrorToSentry(req, err)", []],
];
for (const [file, call, extras] of adopters) {
  const src = readFileSync(file, "utf8");
  t(`${file} imports the request-scoped reporter`, src.includes('reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter"') || src.includes("reportRequestErrorToSentry } from '@/lib/monitoring/sentryErrorReporter'"));
  t(`${file} reports its unexpected-error path with the request`, src.includes(call));
  for (const extra of extras) t(`${file} ${extra}`, src.includes(extra));
}
t("/api/jobs/pro wires both handlers", (readFileSync("src/app/api/jobs/pro/route.ts", "utf8").match(/reportRequestErrorToSentry\(req, err\)/g) || []).length === 2);

// 7. Billing routes: unexpected-error catches report with the request id.
const billingAdopters: Array<[string, number]> = [
  ["src/app/api/billing/razorpay/order/route.ts", 1],
  ["src/app/api/billing/razorpay/verify/route.ts", 1],
];
for (const [file, calls] of billingAdopters) {
  const src = readFileSync(file, "utf8");
  t(`${file} imports the request-scoped reporter`, src.includes('reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter"'));
  const found = (src.match(/reportRequestErrorToSentry\(req, err\)/g) || []).length;
  t(`${file} wires ${calls} handler(s)`, found === calls);
}

// 6. Admin routes: unexpected-error catches report with the request id.
const adminAdopters: Array<[string, number]> = [
  ["src/app/api/admin/users/route.ts", 1],
  ["src/app/api/admin/users/block/route.ts", 1],
  ["src/app/api/admin/users/activity/route.ts", 1],
  ["src/app/api/admin/stats/route.ts", 1],
  ["src/app/api/admin/replay/route.ts", 2],
  ["src/app/api/admin/early-access/route.ts", 2],
  ["src/app/api/admin/early-access/approve/route.ts", 1],
  ["src/app/api/admin/early-access/reject/route.ts", 1],
];
for (const [file, calls] of adminAdopters) {
  const src = readFileSync(file, "utf8");
  t(`${file} imports the request-scoped reporter`, src.includes('reportRequestErrorToSentry } from "@/lib/monitoring/sentryErrorReporter"'));
  const found = (src.match(/reportRequestErrorToSentry\(req, err\)/g) || []).length;
  t(`${file} wires ${calls} handler(s)`, found === calls);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
