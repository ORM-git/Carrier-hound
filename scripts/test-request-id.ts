import assert from "assert";
import { NextRequest } from "next/server";

console.log("=".repeat(80));
console.log("           REQUEST ID / CORRELATION MIDDLEWARE AUDIT        ");
console.log("=".repeat(80) + "\n");

process.env.NODE_ENV = "test";

const { middleware, resolveRequestId, REQUEST_ID_HEADER } = require("../src/middleware");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  // 1. No inbound id -> a fresh UUID is minted and echoed on the response
  {
    const req = new NextRequest("http://localhost:3000/favicon.ico");
    const res = await middleware(req);
    const id = res.headers.get(REQUEST_ID_HEADER);
    assert.ok(id && UUID_RE.test(id), `response must carry a UUID ${REQUEST_ID_HEADER}, got ${id}`);
    console.log("ok - missing inbound id mints a UUID on the response");
  }

  // 2. Well-formed inbound id is honored end to end
  {
    const inbound = "client-req-abc123";
    const req = new NextRequest("http://localhost:3000/favicon.ico", {
      headers: { [REQUEST_ID_HEADER]: inbound },
    });
    const res = await middleware(req);
    assert.strictEqual(res.headers.get(REQUEST_ID_HEADER), inbound, "valid inbound id must be preserved");
    console.log("ok - well-formed inbound id is preserved");
  }

  // 3. Malformed inbound id (CRLF attempt / junk) is replaced, never reflected
  {
    const req = new NextRequest("http://localhost:3000/favicon.ico", {
      headers: { [REQUEST_ID_HEADER]: "bad id with spaces" },
    });
    const res = await middleware(req);
    const id = res.headers.get(REQUEST_ID_HEADER);
    assert.ok(id && UUID_RE.test(id), "malformed inbound id must be replaced with a UUID");
    console.log("ok - malformed inbound id is replaced, not reflected");
  }

  // 4. resolveRequestId unit behavior: boundaries of the accepted pattern
  {
    const ok = new NextRequest("http://localhost/", { headers: { [REQUEST_ID_HEADER]: "a".repeat(128) } });
    assert.strictEqual(resolveRequestId(ok).length, 128, "128-char id accepted");
    const short = new NextRequest("http://localhost/", { headers: { [REQUEST_ID_HEADER]: "short" } });
    assert.ok(UUID_RE.test(resolveRequestId(short)), "under-8-char id replaced");
    console.log("ok - id validation boundaries enforced");
  }

  // 5. POST request does NOT disturb bodyUsed or break `new Request(req.url, req)` (Cloudflare next-on-pages 1101 guard)
  {
    const postReq = new NextRequest("http://localhost:3000/api/early-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "cf-post-check@example.com" }),
    });
    const res = await middleware(postReq);
    assert.strictEqual(postReq.bodyUsed, false, "middleware must never consume POST request body");
    const clonedReq = new Request(postReq.url, postReq);
    assert.strictEqual(
      await clonedReq.text(),
      JSON.stringify({ email: "cf-post-check@example.com" }),
      "downstream new Request(url, req) must read full POST body cleanly"
    );
    const id = res.headers.get(REQUEST_ID_HEADER);
    assert.ok(id && UUID_RE.test(id), "POST middleware response must include x-request-id");
    assert.strictEqual(res.headers.get("x-middleware-next"), "1", "public API POST must pass through middleware");
    assert.strictEqual(
      res.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`),
      id,
      "middleware must forward x-request-id to downstream route via override header"
    );
    console.log("ok - POST request body preserved for Cloudflare next-on-pages downstream Request()");
  }

  console.log("\nAll request-id checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
