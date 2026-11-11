/**
 * Offline test for Uniform Error Response Builder (Backend sheet rank 72: Uniform Error Shape).
 *
 * Verifies that createErrorResponse and its convenience helpers enforce the canonical
 * error response contract documented in docs/error-shape.md:
 * - 4xx/5xx status range enforcement
 * - Non-empty string error field as the primary property
 * - Sanctioned optional properties (code, retryAfter, ok: false)
 * - Automatic Retry-After header injection for rate-limited responses
 * - Runtime rejection of unsanctioned options (e.g. ok: true)
 *
 * Run: npx tsx scripts/test-error-response-builder.ts
 * Negative control: npx tsx scripts/test-error-response-builder.ts --negative-control
 */

import {
  createErrorResponse,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  rateLimited,
  internalError,
  serviceUnavailable,
} from "../src/lib/api/errorResponse";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("Running negative control check...");
    check("negative control: forced assertion failure", false);
    process.exit(1);
  }

  // 1. Status code validation
  try {
    createErrorResponse(200, "Should fail on 200 status");
    check("throws on 200 OK status", false);
  } catch (err: any) {
    check("throws on 200 OK status", err instanceof TypeError);
  }

  try {
    createErrorResponse(600, "Should fail on 600 status");
    check("throws on 600 status", false);
  } catch (err: any) {
    check("throws on 600 status", err instanceof TypeError);
  }

  try {
    createErrorResponse(404.5, "Should fail on non-integer status");
    check("throws on non-integer status", false);
  } catch (err: any) {
    check("throws on non-integer status", err instanceof TypeError);
  }

  // 2. Error message validation
  try {
    createErrorResponse(400, "");
    check("throws on empty string error", false);
  } catch (err: any) {
    check("throws on empty string error", err instanceof TypeError);
  }

  try {
    createErrorResponse(400, "   ");
    check("throws on whitespace string error", false);
  } catch (err: any) {
    check("throws on whitespace string error", err instanceof TypeError);
  }

  try {
    createErrorResponse(400, null as any);
    check("throws on non-string error", false);
  } catch (err: any) {
    check("throws on non-string error", err instanceof TypeError);
  }

  // 3. Option validations
  try {
    createErrorResponse(400, "Bad Request", { ok: true as any });
    check("throws on ok: true (must be literal false or omitted)", false);
  } catch (err: any) {
    check("throws on ok: true (must be literal false or omitted)", err instanceof TypeError);
  }

  try {
    createErrorResponse(429, "Rate limited", { retryAfter: -5 });
    check("throws on negative retryAfter", false);
  } catch (err: any) {
    check("throws on negative retryAfter", err instanceof TypeError);
  }

  try {
    createErrorResponse(400, "Bad Request", { code: "" });
    check("throws on empty string code", false);
  } catch (err: any) {
    check("throws on empty string code", err instanceof TypeError);
  }

  // 4. Canonical payload verification
  const res1 = createErrorResponse(400, "Malformed request body");
  check("status is 400", res1.status === 400);
  const json1 = await res1.json();
  const keys1 = Object.keys(json1);
  check("error is primary and only key", keys1.length === 1 && keys1[0] === "error");
  check("error message text matches", json1.error === "Malformed request body");

  // 5. Canonical payload with optional fields (code, retryAfter, ok: false)
  const res2 = createErrorResponse(429, "Too many requests", {
    code: "RATE_LIMITED",
    retryAfter: 60,
    ok: false,
    headers: { "X-Test-Header": "unit-test" },
  });
  check("status is 429", res2.status === 429);
  check("custom header is preserved", res2.headers.get("X-Test-Header") === "unit-test");
  check("Retry-After header is set to retryAfter value", res2.headers.get("Retry-After") === "60");
  const json2 = await res2.json();
  check("json body contains error", json2.error === "Too many requests");
  check("json body contains code", json2.code === "RATE_LIMITED");
  check("json body contains retryAfter number", json2.retryAfter === 60);
  check("json body contains ok: false", json2.ok === false);
  check("error is first key in serialization", Object.keys(json2)[0] === "error");

  // 6. Convenience helpers
  const resBadRequest = badRequest("Invalid query parameter");
  check("badRequest returns 400", resBadRequest.status === 400);
  check("badRequest error message is set", (await resBadRequest.json()).error === "Invalid query parameter");

  const resUnauthorized = unauthorized();
  check("unauthorized returns 401", resUnauthorized.status === 401);
  check("unauthorized default message is set", (await resUnauthorized.json()).error === "Missing or invalid authorization token");

  const resForbidden = forbidden();
  check("forbidden returns 403", resForbidden.status === 403);
  check("forbidden default message is set", (await resForbidden.json()).error === "Forbidden");

  const resNotFound = notFound();
  check("notFound returns 404", resNotFound.status === 404);
  check("notFound default message is set", (await resNotFound.json()).error === "Resource not found");

  const resRateLimited = rateLimited("Slow down", 30);
  check("rateLimited returns 429", resRateLimited.status === 429);
  check("rateLimited sets Retry-After header", resRateLimited.headers.get("Retry-After") === "30");
  const rateLimitJson = await resRateLimited.json();
  check("rateLimited body has retryAfter", rateLimitJson.retryAfter === 30);

  const resInternalError = internalError();
  check("internalError returns 500", resInternalError.status === 500);
  check("internalError default message is set", (await resInternalError.json()).error === "Internal server error");

  const resServiceUnavailable = serviceUnavailable();
  check("serviceUnavailable returns 503", resServiceUnavailable.status === 503);
  check("serviceUnavailable default message is set", (await resServiceUnavailable.json()).error === "Service temporarily unavailable");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
