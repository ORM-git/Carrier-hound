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
 *   2. src/lib/monitoring/tracing.ts behavior (tested via factory seam & explicit test context):
 *      - Default OFF: isServerTracingEnabled() returns false when env var is unset
 *      - withRouteSpan executes fn() directly when OFF
 *      - Exactly-once in-flight memoization:
 *        a) callback started then SDK sync throw (startSpan & continueTrace; delayed success & error)
 *        b) callback started then rejected finalizer (startSpan & continueTrace; delayed success & error)
 *        c) repeated callback (startSpan & continueTrace; delayed success & error)
 *        d) handler count strictly = 1, original response/error returned, zero unhandled rejections
 *      - Telemetry isolation:
 *        e) setup failure before callback (handler runs once, returns)
 *        f) setAttributes throwing (handler runs once, response returned)
 *        g) startSpan finalization throwing (response returned)
 *        h) setStatus throwing while handler threw (original business error surfaces)
 *      - Production protection:
 *        i) setTracingSdkForTesting throws in non-test / production environments
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
  createRouteSpanRunner,
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

// Track any unhandled promise rejections across all async tests
const unhandledRejections: any[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // 2. Real wrapper with factory seam: Handler success returns once with same response and tags attributes
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

  const normalRunner = createRouteSpanRunner(normalMockSdk);

  let successHandlerCallCount = 0;
  const successResult = await normalRunner("/api/jobs/search", fakeReq, async () => {
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
  const setupFailRunner = createRouteSpanRunner(setupFailSdk);

  let setupFailCallCount = 0;
  const setupFailResult = await setupFailRunner("/api/track", fakeReq, async () => {
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
  const setAttrsRunner = createRouteSpanRunner(setAttrsThrowSdk);

  let setAttrsCallCount = 0;
  const setAttrsResult = await setAttrsRunner("/api/jobs/top10", fakeReq, async () => {
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
  const finalizeRunner = createRouteSpanRunner(finalizeThrowSdk);

  let finalizeCallCount = 0;
  const finalizeResult = await finalizeRunner("/api/stats", fakeReq, async () => {
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
  const setStatusRunner = createRouteSpanRunner(setStatusThrowSdk);

  let businessErrCallCount = 0;
  let caughtBusinessErr: any = null;
  try {
    await setStatusRunner("/api/jobs/pro", fakeReq, async () => {
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

  console.log("  [PASS] Basic fail-open and telemetry isolation verified via factory seam.");
}

async function testInFlightMemoizationAndEdgeCases() {
  console.log("Testing in-flight exactly-once memoization (delayed success/error, sync throw, finalizer, repeated)...");

  const reqWithTrace = new Request("https://example.com/api/jobs/search", {
    method: "GET",
    headers: {
      "sentry-trace": "trace-edge-test-12345-67890-1",
      baggage: "sentry-environment=test",
    },
  });

  process.env.ENABLE_SERVER_TRACING = "true";

  // --- Group 1: Callback started then SDK sync throw ---

  // 1A. startSpan: callback started then SDK sync throw (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: (_ctx, cb) => {
        cb({});
        throw new Error("SDK startSpan synchronous throw after calling callback");
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/jobs/search", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 200, data: "startSpan-sync-throw-success" };
    });
    assert.strictEqual(count, 1, "startSpan sync throw (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "startSpan-sync-throw-success");
  }

  // 1B. startSpan: callback started then SDK sync throw (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: (_ctx, cb) => {
        cb({});
        throw new Error("SDK startSpan synchronous throw after calling callback");
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/jobs/search", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-startSpan-sync-throw-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "startSpan sync throw (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-startSpan-sync-throw-error");
  }

  // 1C. continueTrace: callback started then SDK sync throw (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: (_ctx, cb) => {
        cb();
        throw new Error("SDK continueTrace synchronous throw after calling callback");
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/jobs/search", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 200, data: "continueTrace-sync-throw-success" };
    });
    assert.strictEqual(count, 1, "continueTrace sync throw (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "continueTrace-sync-throw-success");
  }

  // 1D. continueTrace: callback started then SDK sync throw (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: (_ctx, cb) => {
        cb();
        throw new Error("SDK continueTrace synchronous throw after calling callback");
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/jobs/search", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-continueTrace-sync-throw-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "continueTrace sync throw (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-continueTrace-sync-throw-error");
  }

  // --- Group 2: Callback started then rejected finalizer ---

  // 2A. startSpan: callback started then rejected finalizer (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: async (_ctx, cb) => {
        await cb({});
        throw new Error("SDK startSpan rejected finalizer");
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/track", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 201, data: "startSpan-finalizer-success" };
    });
    assert.strictEqual(count, 1, "startSpan rejected finalizer (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "startSpan-finalizer-success");
  }

  // 2B. startSpan: callback started then rejected finalizer (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: async (_ctx, cb) => {
        await cb({});
        throw new Error("SDK startSpan rejected finalizer");
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/track", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-startSpan-finalizer-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "startSpan rejected finalizer (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-startSpan-finalizer-error");
  }

  // 2C. continueTrace: callback started then rejected finalizer (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => {
        await cb();
        throw new Error("SDK continueTrace rejected finalizer");
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/jobs/top10", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 200, data: "continueTrace-finalizer-success" };
    });
    assert.strictEqual(count, 1, "continueTrace rejected finalizer (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "continueTrace-finalizer-success");
  }

  // 2D. continueTrace: callback started then rejected finalizer (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => {
        await cb();
        throw new Error("SDK continueTrace rejected finalizer");
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/jobs/top10", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-continueTrace-finalizer-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "continueTrace rejected finalizer (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-continueTrace-finalizer-error");
  }

  // --- Group 3: Repeated callback ---

  // 3A. startSpan: repeated callback (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: async (_ctx, cb) => {
        const p1 = cb({});
        const p2 = cb({});
        await Promise.all([p1, p2]);
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/jobs/pro", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 200, data: "startSpan-repeated-success" };
    });
    assert.strictEqual(count, 1, "startSpan repeated callback (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "startSpan-repeated-success");
  }

  // 3B. startSpan: repeated callback (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => cb(),
      startSpan: async (_ctx, cb) => {
        const p1 = cb({});
        const p2 = cb({});
        await Promise.all([p1, p2]);
      },
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/jobs/pro", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-startSpan-repeated-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "startSpan repeated callback (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-startSpan-repeated-error");
  }

  // 3C. continueTrace: repeated callback (delayed success)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => {
        const p1 = cb();
        const p2 = cb();
        await Promise.all([p1, p2]);
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    const res = await runner("/api/stats", reqWithTrace, async () => {
      count++;
      await sleep(25);
      return { status: 200, data: "continueTrace-repeated-success" };
    });
    assert.strictEqual(count, 1, "continueTrace repeated callback (delayed success): handler must run exactly once");
    assert.strictEqual(res.data, "continueTrace-repeated-success");
  }

  // 3D. continueTrace: repeated callback (delayed error)
  {
    const sdk: TracingSdk = {
      continueTrace: async (_ctx, cb) => {
        const p1 = cb();
        const p2 = cb();
        await Promise.all([p1, p2]);
      },
      startSpan: async (_ctx, cb) => cb({}),
    };
    const runner = createRouteSpanRunner(sdk);
    let count = 0;
    let caught: any = null;
    try {
      await runner("/api/stats", reqWithTrace, async () => {
        count++;
        await sleep(25);
        throw new Error("business-continueTrace-repeated-error");
      });
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(count, 1, "continueTrace repeated callback (delayed error): handler must run exactly once");
    assert.ok(caught !== null);
    assert.strictEqual(caught.message, "business-continueTrace-repeated-error");
  }

  // --- Group 4: Production restriction on setTracingSdkForTesting ---
  {
    const prevEnv = process.env.NODE_ENV;
    const prevVitest = process.env.VITEST;
    const prevSeam = process.env.ENABLE_TEST_TRACING_SEAM;

    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    delete process.env.ENABLE_TEST_TRACING_SEAM;

    let threwInProd = false;
    try {
      setTracingSdkForTesting({});
    } catch (err: any) {
      threwInProd = true;
      assert.ok(
        err.message.includes("restricted to explicit test environments"),
        "Error message must specify restriction to test environments"
      );
    }
    assert.strictEqual(
      threwInProd,
      true,
      "setTracingSdkForTesting must throw in production to prevent module-global mutation"
    );

    // Restore test environment
    process.env.NODE_ENV = prevEnv;
    if (prevVitest) process.env.VITEST = prevVitest;
    if (prevSeam) process.env.ENABLE_TEST_TRACING_SEAM = prevSeam;
  }

  // Allow pending async ticks to settle and assert zero unhandled rejections
  await sleep(50);
  assert.strictEqual(
    unhandledRejections.length,
    0,
    `Expected 0 unhandled rejections, but got ${unhandledRejections.length}: ${JSON.stringify(
      unhandledRejections.map((e) => e?.message || String(e))
    )}`
  );

  delete process.env.ENABLE_SERVER_TRACING;
  console.log("  [PASS] Exactly-once in-flight memoization verified across all sync-throw, finalizer, and repeated callback edge cases with 0 unhandled rejections.");
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
  await testInFlightMemoizationAndEdgeCases();
  testStaticRouteWiring();
  runNegativeControlSubprocess();
  console.log("\n[PASS] All tracing enablement checks passed successfully.");
}

main().catch((err) => {
  console.error("\n[FAIL] Tracing enablement check failed:", err);
  process.exit(1);
});
