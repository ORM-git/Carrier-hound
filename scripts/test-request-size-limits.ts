/**
 * scripts/test-request-size-limits.ts
 *
 * Deterministic offline behavioral test suite for the global Content-Length
 * precheck (`exceedsGlobalBodyCap` in `src/lib/security/bodySize.ts` and
 * `middleware` in `src/middleware.ts`) and downstream route-level payload caps
 * (`/api/track`, `/api/auth/security-event`).
 *
 * Run directly: npx tsx scripts/test-request-size-limits.ts
 * Negative control: npx tsx scripts/test-request-size-limits.ts --negative-control
 */

process.env.NODE_ENV = "test";

import assert from "assert";
import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import { exceedsGlobalBodyCap, GLOBAL_API_BODY_CAP_BYTES } from "../src/lib/security/bodySize";
import { middleware, REQUEST_ID_HEADER } from "../src/middleware";
import { POST as postTrack } from "../src/app/api/track/route";
import { POST as postSecurityEvent } from "../src/app/api/auth/security-event/route";

if (process.argv.includes("--negative-control")) {
  console.log("Running negative control: expecting deliberate assertion failure...");
  assert.strictEqual(
    413,
    200,
    "NEGATIVE CONTROL: Deliberate assertion failure proving suite exits non-zero"
  );
  process.exit(1);
}

async function runSuite() {
  console.log("================================================================================");
  console.log("       REQUEST SIZE LIMITS (CONTENT-LENGTH PRECHECK & ROUTE GUARDS) SUITE       ");
  console.log("================================================================================\n");

  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({
      data: { allowed: true, retry_after: 0, current_count: 1 },
      error: null,
    }),
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Valid decimal over cap rejected with 413 before downstream handler
    // -------------------------------------------------------------------------
    console.log("[TEST 1] Valid decimal over 1 MB cap rejected with 413 before downstream...");
    const overCap = String(GLOBAL_API_BODY_CAP_BYTES + 1); // 1,048,577
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.strictEqual(exceedsGlobalBodyCap(method, "/api/ai", overCap), true);

      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": overCap,
          [REQUEST_ID_HEADER]: "req-size-overcap-01",
        },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 413, `Expected 413 for ${method} with Content-Length ${overCap}`);
      assert.strictEqual(await res.text(), "");
      assert.strictEqual(res.headers.get("x-middleware-next"), null);
      assert.strictEqual(res.headers.get(REQUEST_ID_HEADER), "req-size-overcap-01");
    }
    console.log("  -> [PASS-LOCAL] Mutating /api/* over-cap requests rejected with 413 prior to downstream.\n");

    // -------------------------------------------------------------------------
    // TEST 2: Cap and under-cap values proceed (200 x-middleware-next: 1)
    // -------------------------------------------------------------------------
    console.log("[TEST 2] Cap and under-cap Content-Length values proceed through middleware...");
    for (const allowedVal of ["0", "1", "16384", String(GLOBAL_API_BODY_CAP_BYTES), "0001048576"]) {
      assert.strictEqual(exceedsGlobalBodyCap("POST", "/api/early-access", allowedVal), false);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": allowedVal,
        },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-middleware-next"), "1");
    }
    console.log("  -> [PASS-LOCAL] Cap and under-cap values proceed.\n");

    // -------------------------------------------------------------------------
    // TEST 3: Huge valid decimals rejected with 413
    // -------------------------------------------------------------------------
    console.log("[TEST 3] Huge valid decimal Content-Length values rejected with 413...");
    for (const hugeVal of ["0001048577", String(Number.MAX_SAFE_INTEGER), "9".repeat(400)]) {
      assert.strictEqual(exceedsGlobalBodyCap("POST", "/api/early-access", hugeVal), true);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": hugeVal,
        },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 413);
    }
    console.log("  -> [PASS-LOCAL] Huge valid decimals (including Infinity overflow) rejected with 413.\n");

    // -------------------------------------------------------------------------
    // TEST 4: Whitespace policy (outer trimmed; blank/internal passed through)
    // -------------------------------------------------------------------------
    console.log("[TEST 4] Whitespace policy verified...");
    for (const outerOver of [" 1048577 ", "\t1048577\t"]) {
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-length": outerOver },
      });
      assert.strictEqual((await middleware(req)).status, 413);
    }
    for (const outerAtCap of [" 1048576 ", "\t1048576\t", "", "   ", "1048 577"]) {
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-length": outerAtCap },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-middleware-next"), "1");
    }
    console.log("  -> [PASS-LOCAL] Outer whitespace trimmed; blank/internal whitespace passed to downstream.\n");

    // -------------------------------------------------------------------------
    // TEST 5: Malformed/signed/fraction/exponent/comma/hex, missing headers,
    //         and chunked bodies pass to downstream route-level guards
    // -------------------------------------------------------------------------
    console.log("[TEST 5] Malformed headers & chunked bodies pass to downstream route guards...");
    const nonDecimalHeaders = [
      "not-a-number",
      "1048577junk",
      "1048577.5",
      "1048577e2",
      "+1048577",
      "-1048577",
      "-5",
      "1048577,1048577",
      "1,048,577",
      "0x200000",
    ];
    for (const hdr of nonDecimalHeaders) {
      assert.strictEqual(exceedsGlobalBodyCap("POST", "/api/early-access", hdr), false);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-length": hdr },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-middleware-next"), "1");
    }

    // Downstream /api/track rejects >16 KB body when Content-Length is absent
    let insertedRows = 0;
    (globalThis as any).__mockSupabaseClient = {
      from: () => ({
        insert: async () => {
          insertedRows++;
          return { error: null };
        },
      }),
    };
    const trackReq = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: JSON.stringify({
        eventType: "web-vitals",
        route: "/jobs",
        name: "LCP",
        value: 1000,
        pad: "x".repeat(20_000),
      }),
    });
    trackReq.headers.delete("content-length");
    const trackRes = await postTrack(trackReq);
    assert.strictEqual(trackRes.status, 204);
    assert.strictEqual(insertedRows, 0, "Oversized chunked /api/track body must not insert");

    // Downstream /api/auth/security-event cancels chunked stream >4096 bytes
    let streamCancelled = false;
    const enc = new TextEncoder();
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"event":"otp_request","pad":"' + "a".repeat(2500)));
        controller.enqueue(enc.encode("b".repeat(2500)));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const secReq = new Request("http://localhost:3000/api/auth/security-event", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "not-a-number" },
      body: chunkedStream,
      // @ts-expect-error Node/undici duplex option
      duplex: "half",
    });
    const secRes = await postSecurityEvent(secReq);
    assert.strictEqual(secRes.status, 204);
    assert.strictEqual(streamCancelled, true, "Oversized chunked security-event stream must be cancelled");
    console.log("  -> [PASS-LOCAL] Malformed/missing/chunked requests pass middleware and hit route-level guards.\n");

    // -------------------------------------------------------------------------
    // TEST 6: Safe methods (GET/HEAD/OPTIONS) and non-/api/ paths excluded
    // -------------------------------------------------------------------------
    console.log("[TEST 6] Safe methods (GET/HEAD/OPTIONS) and non-/api/ paths excluded...");
    for (const safeMethod of ["GET", "HEAD", "OPTIONS"]) {
      const req = new NextRequest("http://localhost:3000/api/health", {
        method: safeMethod,
        headers: { host: "localhost:3000", "content-length": overCap },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-middleware-next"), "1");
    }
    for (const nonApiPath of ["/login", "/pricing", "/signup"]) {
      const req = new NextRequest(`http://localhost:3000${nonApiPath}`, {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-length": overCap },
      });
      const res = await middleware(req);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-middleware-next"), "1");
    }
    assert.strictEqual(exceedsGlobalBodyCap("POST", "/apiary", overCap), false);
    assert.strictEqual(exceedsGlobalBodyCap("POST", "/api", overCap), false);
    console.log("  -> [PASS-LOCAL] Safe methods and non-/api/ paths excluded.\n");

    // -------------------------------------------------------------------------
    // TEST 7: Subprocess Negative Control
    // -------------------------------------------------------------------------
    console.log("[TEST 7] Verifying subprocess negative control exits non-zero...");
    const neg = spawnSync(
      process.execPath,
      ["--import", "tsx", __filename, "--negative-control"],
      { encoding: "utf8" }
    );
    assert.notStrictEqual(neg.status, 0, "Negative control must exit non-zero");
    console.log("  -> [PASS-LOCAL] Negative control exited non-zero as expected.\n");

    console.log("================================================================================");
    console.log("ALL 7 REQUEST SIZE LIMIT CHECKS PASSED [PASS-LOCAL]");
    console.log("================================================================================");
  } finally {
    delete (globalThis as any).__mockRateLimitClient;
    delete (globalThis as any).__mockSupabaseClient;
  }
}

runSuite().catch((err) => {
  console.error("Suite failed:", err);
  process.exit(1);
});
