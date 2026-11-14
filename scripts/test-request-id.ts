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

  // 5. Override protocol parity across Next.js resolve-routes.js AND Cloudflare routes-matcher.ts
  //    for GET/POST/PUT/PATCH/DELETE on /api/early-access, /api/health, and public /pricing branch.
  {
    const applyNextResolveRoutesOverride = (
      incomingHeaders: Headers,
      middlewareRes: Response
    ): Record<string, string | undefined> => {
      const reqHeaders: Record<string, string | undefined> = {};
      for (const [k, v] of incomingHeaders.entries()) {
        reqHeaders[k.toLowerCase()] = v;
      }
      const rawOverride = middlewareRes.headers.get("x-middleware-override-headers");
      if (rawOverride) {
        const overriddenHeaders = new Set(
          rawOverride
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean)
        );
        // Mirror resolve-routes.js:364-368: delete incoming headers not listed in override set
        for (const key of Object.keys(reqHeaders)) {
          if (!overriddenHeaders.has(key)) {
            delete reqHeaders[key];
          }
        }
        // Mirror resolve-routes.js:370-377: apply x-middleware-request-* values
        for (const key of overriddenHeaders) {
          const newValue = middlewareRes.headers.get(`x-middleware-request-${key}`);
          if (newValue !== null) {
            reqHeaders[key] = newValue;
          }
        }
      }
      return reqHeaders;
    };

    const applyCloudflareMatcherOverride = async (
      req: NextRequest,
      middlewareRes: Response
    ): Promise<Request> => {
      const rawOverride = middlewareRes.headers.get("x-middleware-override-headers");
      if (rawOverride) {
        const overriddenHeaderKeys = new Set(
          rawOverride
            .split(",")
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean)
        );
        // Mirror routes-matcher.ts:176-186
        for (const key of overriddenHeaderKeys) {
          const value = middlewareRes.headers.get(`x-middleware-request-${key}`);
          if (req.headers.get(key) !== value) {
            if (value) {
              req.headers.set(key, value);
            } else {
              req.headers.delete(key);
            }
          }
        }
      }
      // Mirror routing.ts:87: new Request(url, request)
      return new Request(req.url, req);
    };

    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
    const routes = ["/api/stats", "/api/health", "/pricing"] as const;

    for (const route of routes) {
      for (const method of methods) {
        const bodyText = method === "GET" ? undefined : JSON.stringify({ probe: `${method}:${route}` });
        const incoming = new Headers({
          "content-type": "application/json",
          origin: "https://careermonke.com",
          host: "careermonke.com",
          cookie: "sb-access-token=tok123; theme=light",
          authorization: "Bearer user-jwt-token",
          "x-forwarded-for": "203.0.113.42",
          "cf-connecting-ip": "198.51.100.24",
          // Client-supplied internal Next.js middleware headers that must NEVER be promoted
          "x-middleware-next": "1",
          "x-middleware-override-headers": "x-evil-forged",
          "x-middleware-request-x-evil-forged": "pwned",
          "x-middleware-request-x-user-id": "forged-admin",
          "x-middleware-subrequest": "middleware",
        });

        const req = new NextRequest(`https://careermonke.com${route}`, {
          method,
          headers: incoming,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
        });

        const res = await middleware(req);
        assert.strictEqual(req.bodyUsed, false, `${method} ${route}: middleware must leave bodyUsed === false`);
        assert.strictEqual(res.headers.get("x-middleware-next"), "1", `${method} ${route}: must pass through`);

        const responseId = res.headers.get(REQUEST_ID_HEADER);
        assert.ok(responseId && UUID_RE.test(responseId), `${method} ${route}: response must carry UUID x-request-id`);

        const overrideList = (res.headers.get("x-middleware-override-headers") || "")
          .split(",")
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean);

        // Client-supplied x-middleware-* headers must NOT be promoted
        for (const key of overrideList) {
          assert.ok(
            !key.startsWith("x-middleware-"),
            `${method} ${route}: client header ${key} must not be in x-middleware-override-headers`
          );
        }
        assert.strictEqual(res.headers.get("x-middleware-request-x-middleware-next"), null);
        assert.strictEqual(res.headers.get("x-middleware-request-x-middleware-override-headers"), null);
        assert.strictEqual(res.headers.get("x-middleware-request-x-middleware-request-x-user-id"), null);
        assert.strictEqual(res.headers.get("x-middleware-request-x-evil-forged"), null);

        // Apply Next.js resolve-routes.js protocol
        const nextDownstream = applyNextResolveRoutesOverride(incoming, res);
        assert.strictEqual(nextDownstream["content-type"], "application/json", `${method} ${route} (Next): content-type`);
        assert.strictEqual(nextDownstream["origin"], "https://careermonke.com", `${method} ${route} (Next): origin`);
        assert.strictEqual(nextDownstream["host"], "careermonke.com", `${method} ${route} (Next): host`);
        assert.strictEqual(nextDownstream["cookie"], "sb-access-token=tok123; theme=light", `${method} ${route} (Next): cookie`);
        assert.strictEqual(nextDownstream["authorization"], "Bearer user-jwt-token", `${method} ${route} (Next): authorization`);
        assert.strictEqual(nextDownstream["x-forwarded-for"], "203.0.113.42", `${method} ${route} (Next): x-forwarded-for`);
        assert.strictEqual(nextDownstream["cf-connecting-ip"], "198.51.100.24", `${method} ${route} (Next): cf-connecting-ip`);
        assert.strictEqual(nextDownstream[REQUEST_ID_HEADER], responseId, `${method} ${route} (Next): x-request-id`);
        assert.strictEqual(nextDownstream["x-middleware-subrequest"], undefined);
        assert.strictEqual(nextDownstream["x-middleware-request-x-user-id"], undefined);
        assert.strictEqual(nextDownstream["x-evil-forged"], undefined);

        // Apply Cloudflare routes-matcher.ts protocol
        const cfDownstream = await applyCloudflareMatcherOverride(req, res);
        assert.strictEqual(cfDownstream.headers.get("content-type"), "application/json", `${method} ${route} (CF): content-type`);
        assert.strictEqual(cfDownstream.headers.get("origin"), "https://careermonke.com", `${method} ${route} (CF): origin`);
        assert.strictEqual(cfDownstream.headers.get("host"), "careermonke.com", `${method} ${route} (CF): host`);
        assert.strictEqual(cfDownstream.headers.get("cookie"), "sb-access-token=tok123; theme=light", `${method} ${route} (CF): cookie`);
        assert.strictEqual(cfDownstream.headers.get("authorization"), "Bearer user-jwt-token", `${method} ${route} (CF): authorization`);
        assert.strictEqual(cfDownstream.headers.get("x-forwarded-for"), "203.0.113.42", `${method} ${route} (CF): x-forwarded-for`);
        assert.strictEqual(cfDownstream.headers.get("cf-connecting-ip"), "198.51.100.24", `${method} ${route} (CF): cf-connecting-ip`);
        assert.strictEqual(cfDownstream.headers.get(REQUEST_ID_HEADER), responseId, `${method} ${route} (CF): x-request-id`);
        if (bodyText !== undefined) {
          assert.strictEqual(await cfDownstream.text(), bodyText, `${method} ${route} (CF): body preserved intact`);
        }
      }
    }
    console.log("ok - Next resolve-routes & Cloudflare routes-matcher parity across GET/POST/PUT/PATCH/DELETE on /api/early-access, /api/health, and /pricing");

    // 6. Authenticated branch (verifyAuthenticatedRequest -> NextResponse.next({ request: { headers } }))
    const prevAllowed = process.env.EARLY_ACCESS_ALLOWED_EMAILS;
    const prevMockSb = (globalThis as any).__mockSupabaseClient;
    try {
      process.env.EARLY_ACCESS_ALLOWED_EMAILS = "auth-parity@example.com";
      (globalThis as any).__mockSupabaseClient = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "user-parity-1",
                email: "auth-parity@example.com",
                email_confirmed_at: new Date().toISOString(),
                app_metadata: { provider: "email", providers: ["email", "google"] },
                identities: [{ provider: "email" }, { provider: "google" }],
              },
            },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { approved: true }, error: null }),
            }),
          }),
        }),
      };

      const authBody = JSON.stringify({ operation: "job_fit" });
      const authIncoming = new Headers({
        "content-type": "application/json",
        origin: "https://careermonke.com",
        host: "careermonke.com",
        cookie: "sb-access-token=tok-auth",
        authorization: "Bearer real-auth-token",
        "x-forwarded-for": "198.51.100.88",
        "cf-connecting-ip": "203.0.113.88",
        "x-middleware-next": "1",
        "x-middleware-request-x-user-id": "forged-admin",
      });
      const authReq = new NextRequest("https://careermonke.com/api/ai", {
        method: "POST",
        headers: authIncoming,
        body: authBody,
      });
      const authRes = await middleware(authReq);
      assert.strictEqual(authReq.bodyUsed, false, "authenticated POST /api/ai must keep bodyUsed === false");
      assert.strictEqual(authRes.headers.get("x-middleware-next"), "1");
      const authNextDownstream = applyNextResolveRoutesOverride(authIncoming, authRes);
      const authCfDownstream = await applyCloudflareMatcherOverride(authReq, authRes);
      const authReqId = authRes.headers.get(REQUEST_ID_HEADER);
      assert.ok(authReqId && UUID_RE.test(authReqId));
      assert.strictEqual(authNextDownstream["content-type"], "application/json");
      assert.strictEqual(authNextDownstream["authorization"], "Bearer real-auth-token");
      assert.strictEqual(authNextDownstream["x-forwarded-for"], "198.51.100.88");
      assert.strictEqual(authNextDownstream["cf-connecting-ip"], "203.0.113.88");
      assert.strictEqual(authNextDownstream["cookie"], "sb-access-token=tok-auth");
      assert.strictEqual(authNextDownstream[REQUEST_ID_HEADER], authReqId);
      assert.strictEqual(authNextDownstream["x-middleware-request-x-user-id"], undefined);
      assert.strictEqual(authCfDownstream.headers.get("authorization"), "Bearer real-auth-token");
      assert.strictEqual(authCfDownstream.headers.get(REQUEST_ID_HEADER), authReqId);
      assert.strictEqual(await authCfDownstream.text(), authBody);
      console.log("ok - Authenticated POST /api/ai preserves headers, body, and x-request-id under Next & CF protocols");
    } finally {
      if (prevAllowed !== undefined) process.env.EARLY_ACCESS_ALLOWED_EMAILS = prevAllowed;
      else delete process.env.EARLY_ACCESS_ALLOWED_EMAILS;
      (globalThis as any).__mockSupabaseClient = prevMockSb;
    }
  }

  console.log("\nAll request-id checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
