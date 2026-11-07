/**
 * Row test: Managed Redis env-gated adapter (Backend sheet - Managed Redis).
 * Pure offline: injects a fake fetch. Run: npx tsx scripts/test-managed-redis.ts
 */
import * as fs from "fs";
import { getRedis, resetRedisForTests, type RedisAdapter } from "../src/lib/cache/redis";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

async function main() {
  // 1. no env -> noop adapter, all operations inert
  {
    resetRedisForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const r = getRedis();
    check("missing env -> disabled noop", !r.isEnabled());
    check("noop get is a miss", (await r.get("k")) === null);
    check("noop set is a no-op", (await r.set("k", "v")) === false);
    check("noop del is a no-op", (await r.del("k")) === false);
    check("noop incr is null", (await r.incr("k")) === null);
  }

  // 2. env present -> enabled adapter hitting the REST endpoint correctly
  const calls: Array<{ url: string; auth: string }> = [];
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };
  {
    const r = getRedis({ url: "https://x.upstash.io/", token: "tok123", fetchImpl: fakeFetch });
    check("env/opts present -> enabled", r.isEnabled());
    await r.set("rate:ip:1", "5", { exSeconds: 60 });
    check("SET path is slash-encoded command", calls[0].url === "https://x.upstash.io/SET/rate%3Aip%3A1/5/EX/60");
    check("bearer token header sent", calls[0].auth === "Bearer tok123");
  }

  // 3. get/incr result shapes (Upstash returns strings)
  {
    const r: RedisAdapter = getRedis({
      url: "https://x.upstash.io", token: "t",
      fetchImpl: async () => new Response(JSON.stringify({ result: "41" }), { status: 200 }),
    });
    check("get returns string result", (await r.get("k")) === "41");
    check("incr parses numeric string", (await r.incr("k")) === 41);
  }

  // 4. fail-open: network throw, HTTP 500, error body all become miss/no-op
  {
    const boom = getRedis({
      url: "https://x.upstash.io", token: "t",
      fetchImpl: async () => { throw new Error("socket hangup"); },
    });
    check("network throw -> miss, no throw", (await boom.get("k")) === null && (await boom.set("k", "v")) === false);
    const http500 = getRedis({
      url: "https://x.upstash.io", token: "t",
      fetchImpl: async () => new Response("err", { status: 500 }),
    });
    check("HTTP 500 -> miss", (await http500.get("k")) === null);
    const errBody = getRedis({
      url: "https://x.upstash.io", token: "t",
      fetchImpl: async () => new Response(JSON.stringify({ error: "OOM" }), { status: 200 }),
    });
    check("redis error body -> miss", (await errBody.incr("k")) === null);
  }

  // 5. onError hook observes failures (observability without crashing)
  {
    let seen = 0;
    const r = getRedis({
      url: "https://x.upstash.io", token: "t",
      fetchImpl: async () => { throw new Error("x"); },
      onError: () => { seen++; },
    });
    await r.get("k");
    check("onError hook fires on failure", seen === 1);
  }

  // 6. memoization: same env returns same instance; env change returns new
  {
    resetRedisForTests();
    process.env.UPSTASH_REDIS_REST_URL = "https://a.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "ta";
    const a1 = getRedis();
    const a2 = getRedis();
    check("same env memoized", a1 === a2);
    process.env.UPSTASH_REDIS_REST_TOKEN = "tb";
    const b = getRedis();
    check("env change returns new adapter", b !== a1 && b.isEnabled());
    resetRedisForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  // 7. docs contract
  {
    const doc = fs.readFileSync("docs/managed-redis.md", "utf8");
    check("doc marked INTERNAL", doc.includes("INTERNAL"));
    check("doc names both env vars", doc.includes("UPSTASH_REDIS_REST_URL") && doc.includes("UPSTASH_REDIS_REST_TOKEN"));
    check("doc documents fail-open contract", doc.includes("fail-open"));
    check("doc has owner activation checklist with vault step", doc.includes("Owner activation") && doc.includes("vault"));
    check("doc forbids PII in cache values", /no PII|never store PII|PII/i.test(doc));
    check("doc cites repo evidence, owner to confirm", doc.includes("src/lib/cache") && doc.includes("owner to confirm") && !doc.includes("Owner-confirmed"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
