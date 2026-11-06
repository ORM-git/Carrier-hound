/**
 * Row test: Edge KV / config store adapter (Backend sheet - Edge KV / Config Store).
 * Pure offline: fake binding + fake fetch. Run: npx tsx scripts/test-edge-kv.ts
 */
import * as fs from "fs";
import { getEdgeKv, type KvBindingLike } from "../src/lib/cache/edgeKv";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

async function main() {
  // 1. nothing configured -> noop
  {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    delete process.env.CLOUDFLARE_KV_API_TOKEN;
    const kv = getEdgeKv();
    check("unconfigured -> disabled noop", !kv.isEnabled());
    check("noop get misses", (await kv.get("k")) === null);
    check("noop getJson null", (await kv.getJson("k")) === null);
    check("noop put false", (await kv.put("k", "v")) === false);
    check("noop delete false", (await kv.delete("k")) === false);
  }

  // 2. binding backend passthrough incl. TTL mapping
  {
    const ops: string[] = [];
    const binding: KvBindingLike = {
      get: async (k, o) => { ops.push(`get:${k}:${o?.type}`); return k === "json" ? { a: 1 } : "text-value"; },
      put: async (k, v, o) => { ops.push(`put:${k}:${v}:${o?.expirationTtl ?? "none"}`); },
      delete: async (k) => { ops.push(`del:${k}`); },
    };
    const kv = getEdgeKv({ binding });
    check("binding -> enabled", kv.isEnabled());
    check("binding get text", (await kv.get("k")) === "text-value" && ops[0] === "get:k:text");
    check("binding getJson parses", JSON.stringify(await kv.getJson("json")) === JSON.stringify({ a: 1 }));
    await kv.put("k", "v", { ttlSeconds: 300 });
    check("binding put maps ttlSeconds->expirationTtl", ops.includes("put:k:v:300"));
    await kv.delete("k");
    check("binding delete passes through", ops.includes("del:k"));
  }

  // 3. binding failure -> fail-open via onError
  {
    let seen = 0;
    const binding: KvBindingLike = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
      delete: async () => { throw new Error("kv down"); },
    };
    const kv = getEdgeKv({ binding, onError: () => { seen++; } });
    check("binding get throw -> miss", (await kv.get("k")) === null);
    check("binding put throw -> false", (await kv.put("k", "v")) === false);
    check("binding delete throw -> false", (await kv.delete("k")) === false);
    check("onError observed all three", seen === 3);
  }

  // 4. REST backend: URL + auth + ttl query construction
  {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    const kv = getEdgeKv({
      accountId: "acc1", namespaceId: "ns9", apiToken: "tok",
      fetchImpl: async (url, init) => {
        calls.push({ url, method: String(init?.method), auth: String((init?.headers as Record<string, string>).Authorization) });
        return new Response("stored-value", { status: 200 });
      },
    });
    check("REST configured -> enabled", kv.isEnabled());
    const v = await kv.get("flags:new matcher");
    check("REST get returns body text", v === "stored-value");
    check("REST URL is account/namespace/values path with encoded key",
      calls[0].url === "https://api.cloudflare.com/client/v4/accounts/acc1/storage/kv/namespaces/ns9/values/flags%3Anew%20matcher");
    check("REST sends bearer token", calls[0].auth === "Bearer tok");
    await kv.put("k", "v", { ttlSeconds: 60 });
    check("REST put uses PUT + expiration_ttl query", calls[1].method === "PUT" && calls[1].url.endsWith("/values/k?expiration_ttl=60"));
    await kv.delete("k");
    check("REST delete uses DELETE", calls[2].method === "DELETE");
  }

  // 5. REST failure -> fail-open; bad JSON -> null
  {
    const downKv = getEdgeKv({
      accountId: "a", namespaceId: "n", apiToken: "t",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    check("REST 503 -> miss/false", (await downKv.get("k")) === null && (await downKv.put("k", "v")) === false);
    const badJson = getEdgeKv({
      accountId: "a", namespaceId: "n", apiToken: "t",
      fetchImpl: async () => new Response("not-json{", { status: 200 }),
    });
    check("REST invalid JSON -> getJson null, no throw", (await badJson.getJson("k")) === null);
  }

  // 6. env-var path (no explicit opts)
  {
    process.env.CLOUDFLARE_ACCOUNT_ID = "envacc";
    process.env.CLOUDFLARE_KV_NAMESPACE_ID = "envns";
    process.env.CLOUDFLARE_KV_API_TOKEN = "envtok";
    const kv = getEdgeKv();
    check("env trio -> enabled REST adapter", kv.isEnabled());
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    delete process.env.CLOUDFLARE_KV_API_TOKEN;
  }

  // 7. docs contract
  {
    const doc = fs.readFileSync("docs/edge-kv.md", "utf8");
    check("doc marked INTERNAL", doc.includes("INTERNAL"));
    check("doc covers binding-first design", doc.includes("binding"));
    check("doc names the three REST env vars",
      doc.includes("CLOUDFLARE_ACCOUNT_ID") && doc.includes("CLOUDFLARE_KV_NAMESPACE_ID") && doc.includes("CLOUDFLARE_KV_API_TOKEN"));
    check("doc documents fail-open contract", doc.includes("fail-open"));
    check("doc has owner activation checklist with vault step", doc.includes("Owner activation") && doc.includes("vault"));
    check("doc forbids PII", /no PII|never store PII|PII/i.test(doc));
    check("doc cites repo evidence, owner to confirm", doc.includes("Cloudflare Pages") && doc.includes("owner to confirm") && !doc.includes("Owner-confirmed"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
