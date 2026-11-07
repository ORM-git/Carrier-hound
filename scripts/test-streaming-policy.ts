/**
 * Offline static test for the Streaming Responses row (Backend sheet):
 * src/app/api/ai/stream/route.ts is an SSE transport scaffold over the
 * existing guarded AI path - gated, no behavior change to /api/ai.
 * Run: npx tsx scripts/test-streaming-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const routePath = "src/app/api/ai/stream/route.ts";
check("stream route file exists", fs.existsSync(routePath));
const route = fs.existsSync(routePath) ? fs.readFileSync(routePath, "utf8") : "";

check("route runs on the edge runtime like /api/ai", /export const runtime = "edge"/.test(route));
check("route is feature-gated on AI_STREAMING_ENABLED", route.includes("AI_STREAMING_ENABLED"));
check("route answers 404 when the gate is off", /status:\s*404/.test(route));
check("route reuses executeAiCore (same auth/quota/breaker path as /api/ai)", route.includes("executeAiCore"));
check("route derives client IP via getClientIpFromRequest", route.includes("getClientIpFromRequest"));
check("route does not call the upstream provider directly", !route.includes("api.groq.com"));
check("route emits text/event-stream", route.includes("text/event-stream"));
check("route frames meta/chunk/done events",
  route.includes('"meta"') && route.includes('"chunk"') && route.includes('"done"'));
check("non-200 outcomes return the same JSON error as /api/ai (no SSE on error)",
  /res\.statusCode !== 200/.test(route));
check("route is wrapped in measureRouteBudget", route.includes('measureRouteBudget("/api/ai/stream"'));
check("chunk size is a labeled chosen default", /Chosen default/.test(route));

check("existing /api/ai route still delegates to handleAiRequest (unchanged)", (() => {
  const p = "src/app/api/ai/route.ts";
  if (!fs.existsSync(p)) return false;
  const cur = fs.readFileSync(p, "utf8");
  return cur.includes("handleAiRequest") && !cur.includes("text/event-stream");
})());

check("client helper still posts to /api/ai (no client-side change)", (() => {
  const p = "src/lib/ai/groq.ts";
  if (!fs.existsSync(p)) return false;
  const cur = fs.readFileSync(p, "utf8");
  return cur.includes('fetch("/api/ai"') && !cur.includes("/api/ai/stream");
})());

const docPath = "docs/streaming.md";
check("docs/streaming.md exists", fs.existsSync(docPath));
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
check("doc names the gate variable", doc.includes("AI_STREAMING_ENABLED"));
check("doc states no visible change / rollback", /rollback/i.test(doc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
