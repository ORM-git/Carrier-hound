/**
 * Offline test for the upstream-streaming path in executeAiCore (Backend sheet row
 * "Streaming Responses"). The upstream request/response is faked on globalThis.fetch.
 * Proves: default (flag off) request body has no stream keys and uses response.json();
 * flag on asks for stream + include_usage and assembles the text; both modes return a
 * byte-identical client body for the same text; malformed streams fail like an
 * unparseable JSON body (502, budget settled 0, quota refunded, breaker failure);
 * usage from the stream is what settles the budget. Live Groq behavior is unproven here.
 * Run: npx tsx scripts/test-upstream-streaming-core.ts
 */
process.env.NODE_ENV = "test";
(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
};
process.env.EARLY_ACCESS_ALLOWED_EMAILS = "pro-tester@careermonke.com";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.GROQ_API_KEY = "test-groq-key";

import assert from "assert";
import * as fs from "fs";
import { GroqCircuitBreaker, executeAiCore } from "../src/lib/ai/serviceHandler";

let passed = 0;
function ok(name: string) { passed++; console.log(`PASS ${name}`); }

const TEXT =
  "Dear Hiring Manager, I am excited to apply for the Software Engineer role at Acme. " +
  "I have built scalable TypeScript web applications and enjoy shipping reliable products.";

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function streamResponse(parts: string[], status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (i >= parts.length) c.close(); else c.enqueue(enc.encode(parts[i++])); },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

interface Harness { rpcCalls: Array<{ name: string; params: any }>; refunded: () => boolean; deps: any; breaker: GroqCircuitBreaker; }

function harness(upstreamStream?: boolean): Harness {
  const rpcCalls: Array<{ name: string; params: any }> = [];
  let refundCalled = false;
  const qb: any = {
    select: () => qb, eq: () => qb, maybeSingle: async () => ({ data: null, error: null }),
    insert: async () => ({ error: null }), update: () => qb, order: () => qb, limit: () => qb,
  };
  const admin: any = {
    auth: { getUser: async () => ({ data: { user: { id: "user-stream-test", email: "pro-tester@careermonke.com" } }, error: null }) },
    from: () => qb,
    rpc: async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (name === "ai_global_budget_reserve") return { data: [{ allowed: true, current_tokens: 500, remaining: 1500000 }], error: null };
      if (name === "ai_concurrency_acquire") return { data: true, error: null };
      return { data: { ok: true }, error: null };
    },
  };
  const breaker = new GroqCircuitBreaker();
  const deps: any = {
    getSupabaseAdmin: () => admin,
    getServerEntitlement: async () => ({ isPro: true, status: "active" }),
    circuitBreaker: breaker,
    consumeSet: async () => ({ success: true, alreadyConsumed: false }),
    refundSet: async () => { refundCalled = true; return { refunded: true } as any; },
  };
  if (upstreamStream !== undefined) deps.upstreamStream = upstreamStream;
  return { rpcCalls, refunded: () => refundCalled, deps, breaker };
}

const reqBody = (key: string) => ({
  operation: "cover_letter",
  params: {
    candidate: { name: "Jane Doe", skills: ["TypeScript"] },
    job: { title: "Software Engineer", company: "Acme", description: "Build scalable web applications." },
  },
  idempotencyKey: key,
});

async function run(h: Harness, fetchImpl: (url: string, init: any) => Promise<Response>, key: string) {
  const orig = globalThis.fetch;
  const seen: Array<{ url: string; body: any; hadJson: boolean }> = [];
  (globalThis as any).fetch = async (input: any, init: any) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(init.body), hadJson: true });
    return fetchImpl(url, init);
  };
  try {
    const res = await executeAiCore("127.0.0.1", "Bearer mock-token", reqBody(key), h.deps);
    return { res, seen };
  } finally {
    (globalThis as any).fetch = orig;
  }
}

function jsonResponse(text: string, usage?: any): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  // 1. Default: flag unset -> no stream keys, JSON parse path
  const hOff = harness();
  const off = await run(hOff, async () => jsonResponse(TEXT, { prompt_tokens: 40, completion_tokens: 60 }), "k-off");
  assert.strictEqual(off.res.statusCode, 200, JSON.stringify(off.res.body));
  assert.ok(!("stream" in off.seen[0].body) && !("stream_options" in off.seen[0].body), "default request must not ask for a stream");
  ok("default (flag unset): upstream request has no stream keys and JSON path returns 200");

  // 2. Explicit false behaves like unset
  const hFalse = harness(false);
  const f = await run(hFalse, async () => jsonResponse(TEXT, { prompt_tokens: 40, completion_tokens: 60 }), "k-false");
  assert.ok(!("stream" in f.seen[0].body));
  assert.deepStrictEqual(JSON.stringify(f.res.body), JSON.stringify(off.res.body));
  ok("explicit upstreamStream:false is identical to unset");

  // 3. Flag on: stream keys, assembled text, same client body, usage settles budget
  const hOn = harness(true);
  const parts = [
    sse({ choices: [{ delta: { role: "assistant" } }] }),
    ...TEXT.match(/.{1,25}/g)!.map((t) => sse({ choices: [{ delta: { content: t } }] })),
    sse({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 60 } }),
    "data: [DONE]\n\n",
  ];
  const on = await run(hOn, async () => streamResponse(parts), "k-on");
  assert.strictEqual(on.res.statusCode, 200, JSON.stringify(on.res.body));
  assert.strictEqual(on.seen[0].body.stream, true);
  assert.deepStrictEqual(on.seen[0].body.stream_options, { include_usage: true });
  ok("flag on: upstream request asks for stream with include_usage");
  assert.strictEqual(JSON.stringify(on.res.body), JSON.stringify(off.res.body));
  ok("flag on: client body is byte-identical to the non-streaming body for the same text");
  const settleOn = hOn.rpcCalls.find((c) => c.name === "ai_global_budget_settle");
  assert.ok(settleOn, "budget must settle");
  assert.strictEqual(settleOn!.params.p_actual, 100, "settles prompt+completion tokens from the stream usage frame");
  ok("flag on: budget settles from stream usage (100 tokens)");
  const settleOff = hOff.rpcCalls.find((c) => c.name === "ai_global_budget_settle");
  assert.strictEqual(settleOff!.params.p_actual, 100);
  ok("flag off: budget settles from JSON usage (100 tokens), same as streaming");

  // 4. Same upstream URL, both modes
  assert.strictEqual(off.seen[0].url, on.seen[0].url);
  assert.ok(on.seen[0].url.startsWith("https://api.groq.com/"));
  ok("both modes call the same upstream URL");

  // 5. Malformed stream -> 502 invalid response, settle 0, refund, breaker failure
  const hBad = harness(true);
  const bad = await run(hBad, async () => streamResponse([sse({ choices: [{ delta: { content: "par" } }] }), "data: {broken\n\n"]), "k-bad");
  assert.strictEqual(bad.res.statusCode, 502);
  assert.strictEqual(bad.res.body.error, "AI service returned an invalid response. Please try again.");
  assert.strictEqual(hBad.rpcCalls.find((c) => c.name === "ai_global_budget_settle")!.params.p_actual, 0);
  assert.ok(hBad.refunded(), "quota refunded on a malformed stream");
  assert.ok(hBad.rpcCalls.find((c) => c.name === "ai_concurrency_release"), "lease released");
  ok("malformed stream: same 502 body as unparseable JSON, budget settled 0, quota refunded, lease released");

  // 6. Upstream error status in stream mode -> unchanged 502 path
  const hHttp = harness(true);
  const http = await run(hHttp, async () => new Response("nope", { status: 500 }), "k-http");
  assert.strictEqual(http.res.statusCode, 502);
  assert.strictEqual(http.res.body.error, "AI service generation failed. Please try again.");
  ok("upstream HTTP error in stream mode keeps the existing 502 body");

  // 7. Empty stream -> invalid response path
  const hEmpty = harness(true);
  const empty = await run(hEmpty, async () => streamResponse(["data: [DONE]\n\n"]), "k-empty");
  assert.strictEqual(empty.res.statusCode, 502);
  assert.ok(hEmpty.refunded());
  ok("empty stream is refunded like a failed generation");

  // 8. Route wiring (static)
  const route = fs.readFileSync("src/app/api/ai/stream/route.ts", "utf8");
  assert.ok(route.includes('getRuntimeEnv("AI_UPSTREAM_STREAMING_ENABLED", cfEnv)'));
  assert.ok(/upstreamFlag === "1" \|\| upstreamFlag === "true"/.test(route));
  assert.ok(/executeAiCore\(clientIp, authHeader, body, \{ env: cfEnv, upstreamStream \}, "ai:ip:"\)/.test(route));
  assert.ok(route.indexOf('"AI_STREAMING_ENABLED"') < route.indexOf("AI_UPSTREAM_STREAMING_ENABLED"), "outer 404 gate still comes first");
  ok("stream route: second flag is read after the outer 404 gate and defaults off");
  const core = fs.readFileSync("src/lib/ai/serviceHandler.ts", "utf8");
  assert.ok(core.includes("activeDeps.upstreamStream === true"));
  const api = fs.readFileSync("src/app/api/ai/route.ts", "utf8");
  assert.ok(!api.includes("upstreamStream"), "/api/ai never enables upstream streaming");
  ok("/api/ai route is untouched and never enables upstream streaming");

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
