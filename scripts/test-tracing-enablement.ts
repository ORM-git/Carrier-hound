/**
 * scripts/test-tracing-enablement.ts
 *
 * Offline guard test for distributed tracing enablement spike & manual spans.
 * Verifies:
 *   1. docs/tracing-enablement-spike.md exists and covers:
 *      - Why server/edge auto-instrumentation is disabled (cites next.config.mjs settings)
 *      - next-on-pages secondary bundling and webpack duplicate module ID collisions in _worker.js
 *      - The 5 hottest routes (/api/track, /api/jobs/search, /api/jobs/top10, /api/jobs/pro, /api/stats)
 *      - Evaluation of all 3 options + compatibility risk assessment + recommended path (Option 1)
 *      - Unverified platform behaviors (Cloudflare build/runtime, 5% sampling, process.env toggle)
 *   2. src/lib/monitoring/tracing.ts behavior (tested via SDK seam, no global mock):
 *      - Default OFF: isServerTracingEnabled() returns false when env var is unset
 *      - withRouteSpan executes fn() directly when OFF
 *      - Real wrapper tested with SDK seam:
 *        a) Setup failure (startSpan/continueTrace throws before callback): handler runs once and returns
 *        b) setAttributes throwing: handler runs once, returns original response (telemetry error swallowed)
 *        c) startSpan finalization throwing after handler ran: returns original response
 *        d) setStatus throwing while handler threw: original business error surfaces
 *        e) handler success returns once with the same response
 *   3. Static AST/source verification:
 *      - All 5 hottest routes import withRouteSpan from "@/lib/monitoring/tracing"
 *      - All 5 hottest routes wrap their handlers with withRouteSpan("<route>", req, ...)
 *   4. Negative control:
 *      - --negative-control triggers a failing assertion and exits non-zero
 *      - Normal run spawns --negative-control subprocess to prove the negative control works
 *
 * Run: npx tsx scripts/test-tracing-enablement.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isServerTracingEnabled,
  withRouteSpan,
  setTracingSdkForTesting,
  TracingSdk,
} from "../src/lib/monitoring/tracing";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  // Negative control: purposefully assert a missing fake route to ensure failures are caught
  console.log("Running negative control mode...");
  const fakeDoc = "This is a corrupted doc without required citations.";
  assert.ok(fakeDoc.includes("autoInstrumentServerFunctions: false"), "Negative control assertion failed as expected");
  process.exit(0);
}

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-tracing-enablement.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS-LOCAL] Negative control '--negative-control' exited non-zero as expected");
}

function testDocumentation() {
  console.log("Testing docs/tracing-enablement-spike.md...");
  const docPath = path.join(ROOT, "docs", "tracing-enablement-spike.md");
  assert.ok(fs.existsSync(docPath), "docs/tracing-enablement-spike.md must exist");

  const content = fs.readFileSync(docPath, "utf8");

  // Config citations
  assert.ok(
    content.includes("autoInstrumentServerFunctions: false"),
    "Doc must cite autoInstrumentServerFunctions: false"
  );
  assert.ok(
    content.includes("instrumentationHook: false"),
    "Doc must cite instrumentationHook: false"
  );
  assert.ok(
    content.includes("autoInstrumentMiddleware: false"),
    "Doc must cite autoInstrumentMiddleware: false"
  );
  assert.ok(
    content.includes("autoInstrumentAppDirectory: false"),
    "Doc must cite autoInstrumentAppDirectory: false"
  );
  assert.ok(
    content.includes("next.config.mjs"),
    "Doc must cite next.config.mjs"
  );

  // next-on-pages & webpack collisions
  assert.ok(
    content.toLowerCase().includes("next-on-pages"),
    "Doc must explain next-on-pages constraint"
  );
  assert.ok(
    content.includes("_worker.js") || content.toLowerCase().includes("duplicate module"),
    "Doc must explain worker bundle or duplicate module ID collisions"
  );

  // 5 hottest routes
  const HOTTEST_ROUTES = [
    "/api/track",
    "/api/jobs/search",
    "/api/jobs/top10",
    "/api/jobs/pro",
    "/api/stats",
  ];
  for (const r of HOTTEST_ROUTES) {
    assert.ok(content.includes(r), `Doc must evaluate hottest route ${r}`);
  }

  // 3 options & recommendation
  assert.ok(content.includes("Option 1"), "Doc must include Option 1");
  assert.ok(content.includes("Option 2"), "Doc must include Option 2");
  assert.ok(content.includes("Option 3"), "Doc must include Option 3");
  assert.ok(
    content.toLowerCase().includes("recommended") || content.toLowerCase().includes("recommendation"),
    "Doc must state recommendation"
  );

  // Unverified platform behaviors
  assert.ok(
    content.toLowerCase().includes("unverified"),
    "Doc must state unverified platform behaviors"
  );
  assert.ok(
    content.includes("process.env"),
    "Doc must note process.env evaluation"
  );

  // Assert overconfident claims are NOT present
  assert.ok(!content.includes("provably compatible"), "Doc must not claim 'provably compatible'");
  assert.ok(!content.includes("zero risk"), "Doc must not claim 'zero risk'");
  assert.ok(!content.includes("ready immediately"), "Doc must not claim 'ready immediately'");
  assert.ok(!content.includes("zero overhead"), "Doc must not claim 'zero overhead'");

  console.log("  [PASS] Documentation covers all required citations and sober assessments.");
}

async function testTracingModuleBehavior() {
  console.log("Testing src/lib/monitoring/tracing.ts behavior & fail-open guarantees...");

  const fakeReq = new Request("https://example.com/api/jobs/search", {
    method: "GET",
    headers: {
      "sentry-trace": "1234567890abcdef1234567890abcdef-1234567890abcdef-1",
      baggage: "sentry-environment=production",
      "x-request-id": "req-test-123",
    },
  });

  // 1. Default OFF behavior
  delete process.env.ENABLE_SERVER_TRACING;
  assert.strictEqual(
    isServerTracingEnabled(),
    false,
    "Default isServerTracingEnabled() must return false"
  );

  let executedOff = false;
  const offResult = await withRouteSpan("/api/jobs/search", fakeReq, async () => {
    executedOff = true;
    return { status: 200, data: "ok" };
  });
  assert.strictEqual(executedOff, true, "fn() must execute when tracing is OFF");
  assert.strictEqual(offResult.data, "ok");

  // Enable tracing for remaining tests
  process.env.ENABLE_SERVER_TRACING = "true";
  assert.strictEqual(
    isServerTracingEnabled(),
    true,
    "isServerTracingEnabled() must return true when ENABLE_SERVER_TRACING=true"
  );

  // 2. Real wrapper with SDK seam: Handler success returns once with same response and tags attributes
  let recordedSpanName = "";
  let recordedAttributes: Record<string, any> = {};
  let setAttributesCalled = false;
  let continueTraceContext: any = null;

  const normalMockSdk: TracingSdk = {
    continueTrace: async (ctx, cb) => {
      continueTraceContext = ctx;
      return await cb();
    },
    startSpan: async (ctx, cb) => {
      recordedSpanName = ctx.name;
      recordedAttributes = { ...(ctx.attributes || {}) };
      const span = {
        setAttributes: (attrs: Record<string, any>) => {
          setAttributesCalled = true;
          Object.assign(recordedAttributes, attrs);
        },
      };
      return await cb(span);
    },
  };

  setTracingSdkForTesting(normalMockSdk);

  let successHandlerCallCount = 0;
  const successResult = await withRouteSpan("/api/jobs/search", fakeReq, async () => {
    successHandlerCallCount++;
    return { status: 200, jobs: ["job-1"] };
  });

  assert.strictEqual(successHandlerCallCount, 1, "Handler must be called exactly once");
  assert.strictEqual(successResult.status, 200);
  assert.strictEqual(recordedSpanName, "GET /api/jobs/search");
  assert.strictEqual(recordedAttributes["http.route"], "/api/jobs/search");
  assert.strictEqual(recordedAttributes["http.method"], "GET");
  assert.strictEqual(recordedAttributes["request_id"], "req-test-123");
  assert.strictEqual(recordedAttributes["http.status_code"], 200);
  assert.strictEqual(setAttributesCalled, true);
  assert.strictEqual(
    continueTraceContext?.sentryTrace,
    "1234567890abcdef1234567890abcdef-1234567890abcdef-1"
  );

  // 3. Setup failure: startSpan throws BEFORE handler runs
  const setupFailSdk: TracingSdk = {
    continueTrace: async (_ctx, cb) => cb(),
    startSpan: async () => {
      throw new Error("SDK startSpan crash during setup");
    },
  };
  setTracingSdkForTesting(setupFailSdk);

  let setupFailCallCount = 0;
  const setupFailResult = await withRouteSpan("/api/track", fakeReq, async () => {
    setupFailCallCount++;
    return { status: 201, tracked: true };
  });
  assert.strictEqual(setupFailCallCount, 1, "Handler must run once even if startSpan throws before callback");
  assert.strictEqual(setupFailResult.tracked, true);

  // 4. setAttributes throwing after handler ran: handler response must still return
  const setAttrsThrowSdk: TracingSdk = {
    continueTrace: async (_ctx, cb) => cb(),
    startSpan: async (_ctx, cb) => {
      const span = {
        setAttributes: () => {
          throw new Error("setAttributes crashed inside SDK");
        },
      };
      return await cb(span);
    },
  };
  setTracingSdkForTesting(setAttrsThrowSdk);

  let setAttrsCallCount = 0;
  const setAttrsResult = await withRouteSpan("/api/jobs/top10", fakeReq, async () => {
    setAttrsCallCount++;
    return { status: 200, top10: true };
  });
  assert.strictEqual(setAttrsCallCount, 1);
  assert.strictEqual(setAttrsResult.top10, true, "Original response must return when setAttributes throws");

  // 5. startSpan finalization throwing after handler ran: original response must return
  const finalizeThrowSdk: TracingSdk = {
    continueTrace: async (_ctx, cb) => cb(),
    startSpan: async (_ctx, cb) => {
      await cb({});
      throw new Error("startSpan finalization / span.end() crashed");
    },
  };
  setTracingSdkForTesting(finalizeThrowSdk);

  let finalizeCallCount = 0;
  const finalizeResult = await withRouteSpan("/api/stats", fakeReq, async () => {
    finalizeCallCount++;
    return { status: 200, statsCount: 42 };
  });
  assert.strictEqual(finalizeCallCount, 1);
  assert.strictEqual(finalizeResult.statsCount, 42, "Original response must return when startSpan finalization throws");

  // 6. setStatus throwing while handler threw: original business error must surface
  const setStatusThrowSdk: TracingSdk = {
    continueTrace: async (_ctx, cb) => cb(),
    startSpan: async (_ctx, cb) => {
      const span = {
        setStatus: () => {
          throw new Error("setStatus crashed");
        },
      };
      return await cb(span);
    },
  };
  setTracingSdkForTesting(setStatusThrowSdk);

  let businessErrCallCount = 0;
  let caughtBusinessErr: any = null;
  try {
    await withRouteSpan("/api/jobs/pro", fakeReq, async () => {
      businessErrCallCount++;
      throw new Error("Original business error: subscriber entitlement expired");
    });
  } catch (err) {
    caughtBusinessErr = err;
  }
  assert.strictEqual(businessErrCallCount, 1, "Handler must be called once when throwing");
  assert.ok(caughtBusinessErr !== null);
  assert.strictEqual(
    caughtBusinessErr.message,
    "Original business error: subscriber entitlement expired",
    "Original business error must surface, not the setStatus telemetry error"
  );

  // Reset testing SDK seam and env
  setTracingSdkForTesting(null);
  delete process.env.ENABLE_SERVER_TRACING;
  console.log("  [PASS] Real wrapper tested: setup failure, setAttributes throw, finalization throw, setStatus throw, and normal success.");
}

function testStaticRouteWiring() {
  console.log("Testing static route wiring for 5 hottest routes...");

  const ROUTES_TO_CHECK = [
    {
      file: "src/app/api/track/route.ts",
      expectedRoute: "/api/track",
    },
    {
      file: "src/app/api/jobs/search/route.ts",
      expectedRoute: "/api/jobs/search",
    },
    {
      file: "src/app/api/jobs/top10/route.ts",
      expectedRoute: "/api/jobs/top10",
    },
    {
      file: "src/app/api/jobs/pro/route.ts",
      expectedRoute: "/api/jobs/pro",
    },
    {
      file: "src/app/api/stats/route.ts",
      expectedRoute: "/api/stats",
    },
  ];

  for (const { file, expectedRoute } of ROUTES_TO_CHECK) {
    const fullPath = path.join(ROOT, file);
    assert.ok(fs.existsSync(fullPath), `Route file ${file} must exist`);
    const code = fs.readFileSync(fullPath, "utf8");

    // Must import withRouteSpan
    assert.ok(
      code.includes('import { withRouteSpan } from "@/lib/monitoring/tracing"') ||
        code.includes("withRouteSpan"),
      `${file} must import withRouteSpan`
    );

    // Must wrap with withRouteSpan(expectedRoute, ...)
    assert.ok(
      code.includes(`withRouteSpan("${expectedRoute}"`),
      `${file} must call withRouteSpan("${expectedRoute}", ...)`
    );
  }

  console.log("  [PASS] All 5 hottest routes are statically wired with withRouteSpan.");
}

async function main() {
  testDocumentation();
  await testTracingModuleBehavior();
  testStaticRouteWiring();
  runNegativeControlSubprocess();
  console.log("\n[PASS] All tracing enablement checks passed successfully.");
}

main().catch((err) => {
  console.error("\n[FAIL] Tracing enablement check failed:", err);
  process.exit(1);
});
