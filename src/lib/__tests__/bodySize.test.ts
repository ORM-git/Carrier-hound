import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { exceedsGlobalBodyCap, GLOBAL_API_BODY_CAP_BYTES } from "@/lib/security/bodySize";
import { middleware, REQUEST_ID_HEADER } from "@/middleware";
import { POST as postTrack } from "@/app/api/track/route";
import { POST as postSecurityEvent } from "@/app/api/auth/security-event/route";

// Backend sheet rank 71 (Request Size Limits): a global Content-Length
// precheck bounds every mutating /api/* route; chunked/missing/malformed
// headers pass through to route-level body caps.

describe("exceedsGlobalBodyCap and middleware Content-Length precheck", () => {
  beforeEach(() => {
    (globalThis as any).__mockRateLimitClient = {
      rpc: async () => ({
        data: { allowed: true, retry_after: 0, current_count: 1 },
        error: null,
      }),
    };
  });

  afterEach(() => {
    delete (globalThis as any).__mockRateLimitClient;
    delete (globalThis as any).__mockSupabaseClient;
    vi.restoreAllMocks();
  });

  it("rejects valid decimal Content-Length over the cap on mutating /api/* requests with 413 before calling downstream handlers", async () => {
    const overCap = String(GLOBAL_API_BODY_CAP_BYTES + 1); // 1,048,577

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(exceedsGlobalBodyCap(method, "/api/ai", overCap)).toBe(true);

      let downstreamCalled = false;
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": overCap,
          [REQUEST_ID_HEADER]: "req-overcap-check",
        },
      });

      const res = await middleware(req);
      if (res.headers.get("x-middleware-next") === "1") {
        downstreamCalled = true;
      }

      expect(res.status).toBe(413);
      expect(await res.text()).toBe("");
      expect(res.headers.get("x-middleware-next")).toBeNull();
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req-overcap-check");
      expect(downstreamCalled).toBe(false);
    }

    // Also verify protected/admin /api routes short-circuit with 413 BEFORE auth/session lookup
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adminReq = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-length": overCap,
      },
    });
    const adminRes = await middleware(adminReq);
    expect(adminRes.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows requests with Content-Length at or under the 1 MB cap to proceed through middleware", async () => {
    for (const validUnderOrAtCap of [
      "0",
      "1",
      "16384",
      String(GLOBAL_API_BODY_CAP_BYTES - 1),
      String(GLOBAL_API_BODY_CAP_BYTES),
      "0001048576",
    ]) {
      expect(exceedsGlobalBodyCap("POST", "/api/track", validUnderOrAtCap)).toBe(false);

      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": validUnderOrAtCap,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("rejects huge valid decimal Content-Length values (including IEEE-754 Infinity overflow and leading zeros)", async () => {
    for (const hugeDecimal of [
      "0001048577",
      String(Number.MAX_SAFE_INTEGER),
      "999999999999999999999999999999",
      "9".repeat(400),
    ]) {
      expect(exceedsGlobalBodyCap("POST", "/api/track", hugeDecimal)).toBe(true);

      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": hugeDecimal,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(413);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  it("enforces current whitespace policy: trims outer whitespace on valid decimals and passes internal/blank whitespace to downstream guards", async () => {
    // Outer whitespace around over-cap decimal -> trimmed and rejected (413)
    for (const paddedOver of [" 1048577 ", "\t1048577\t", "   1048577"]) {
      expect(exceedsGlobalBodyCap("POST", "/api/early-access", paddedOver)).toBe(true);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": paddedOver,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(413);
    }

    // Outer whitespace around exact-cap decimal -> trimmed and allowed (200 next)
    for (const paddedAtCap of [" 1048576 ", "\t1048576\t"]) {
      expect(exceedsGlobalBodyCap("POST", "/api/early-access", paddedAtCap)).toBe(false);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": paddedAtCap,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }

    // Blank or internal whitespace fails /^\d+$/ and passes through middleware precheck
    for (const blankOrInternal of ["", "   ", "\t", "1048 577", "1048577 0"]) {
      expect(exceedsGlobalBodyCap("POST", "/api/early-access", blankOrInternal)).toBe(false);
      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": blankOrInternal,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it.each([
    "not-a-number",
    "1048577junk",
    "1048577bytes",
    "1048577.5",
    "1048576.0",
    "1048577e2",
    "1e7",
    "2E6",
    "+1048577",
    "-1048577",
    "-5",
    "+0",
    "1048577,1048577",
    "1,048,577",
    "1_048_577",
    "0x200000",
    "0X100001",
    "0o4000001",
    "0b100000000000000000001",
  ])(
    "passes malformed/signed/fraction/exponent/comma/hex Content-Length %j through middleware to downstream route guards",
    async (header) => {
      expect(exceedsGlobalBodyCap("POST", "/api/early-access", header)).toBe(false);

      const req = new NextRequest("http://localhost:3000/api/early-access", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": header,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  );

  it("passes missing Content-Length and chunked bodies through middleware so downstream route-level guards enforce their own payload caps", async () => {
    // 1. Missing Content-Length with Transfer-Encoding: chunked passes middleware precheck
    const chunkedMiddlewareReq = new NextRequest("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "transfer-encoding": "chunked",
      },
    });
    expect(exceedsGlobalBodyCap("POST", "/api/early-access", null)).toBe(false);
    const mwRes = await middleware(chunkedMiddlewareReq);
    expect(mwRes.status).toBe(200);
    expect(mwRes.headers.get("x-middleware-next")).toBe("1");

    // 2. Downstream /api/track route guard drops an oversized (> 16 KB) body when Content-Length is omitted or malformed
    let insertedRows = 0;
    (globalThis as any).__mockSupabaseClient = {
      from: () => ({
        insert: async () => {
          insertedRows++;
          return { error: null };
        },
      }),
    };

    const oversizedTrackJson = JSON.stringify({
      eventType: "web-vitals",
      route: "/jobs",
      name: "LCP",
      value: 1200,
      padding: "x".repeat(20_000), // > 16,384 byte route cap
    });

    const trackReqNoHeader = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body: oversizedTrackJson,
    });
    // Ensure no content-length header is present
    trackReqNoHeader.headers.delete("content-length");

    const trackRes = await postTrack(trackReqNoHeader);
    expect(trackRes.status).toBe(204);
    expect(insertedRows).toBe(0);

    // 3. Downstream /api/auth/security-event streamed reader cancels a chunked stream > 4096 bytes even with malformed/missing Content-Length
    let streamCancelled = false;
    const enc = new TextEncoder();
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"event":"otp_request","pad":"' + "a".repeat(2500)));
        controller.enqueue(enc.encode("b".repeat(2500))); // cumulative > 4096 bytes
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const secReq = new Request("http://localhost:3000/api/auth/security-event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "not-a-number",
      },
      body: chunkedStream,
      // @ts-expect-error Node/undici duplex option required for ReadableStream request body
      duplex: "half",
    });

    const secRes = await postSecurityEvent(secReq);
    expect(secRes.status).toBe(204);
    expect(streamCancelled).toBe(true);
  });

  it("excludes GET/HEAD/OPTIONS and non-/api/ paths from the Content-Length precheck in both helper and middleware", async () => {
    const overCap = String(GLOBAL_API_BODY_CAP_BYTES + 1);
    const giant = "9".repeat(400);

    // Safe methods on /api/* are never rejected with 413
    for (const safeMethod of ["GET", "HEAD", "OPTIONS", "get", "head", "options"]) {
      expect(exceedsGlobalBodyCap(safeMethod, "/api/stats", overCap)).toBe(false);
      expect(exceedsGlobalBodyCap(safeMethod, "/api/stats", giant)).toBe(false);
    }

    for (const safeMethod of ["GET", "HEAD", "OPTIONS"] as const) {
      const req = new NextRequest("http://localhost:3000/api/health", {
        method: safeMethod,
        headers: {
          host: "localhost:3000",
          "content-length": overCap,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }

    // Non-/api/ paths (including prefix lookalikes like /apiary and bare /api) are never rejected with 413
    for (const nonApiPath of ["/", "/login", "/pricing", "/early-access", "/apiary", "/api"]) {
      expect(exceedsGlobalBodyCap("POST", nonApiPath, overCap)).toBe(false);
      expect(exceedsGlobalBodyCap("POST", nonApiPath, giant)).toBe(false);
    }

    for (const publicNonApiPath of ["/login", "/pricing", "/early-access"]) {
      const req = new NextRequest(`http://localhost:3000${publicNonApiPath}`, {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-length": overCap,
        },
      });
      const res = await middleware(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }

    // Custom cap boundary check
    expect(exceedsGlobalBodyCap("POST", "/api/track", "10", 10)).toBe(false);
    expect(exceedsGlobalBodyCap("POST", "/api/track", "11", 10)).toBe(true);
  });
});
