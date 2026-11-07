import {
  executeAiCore,
  getClientIpFromRequest,
  getRuntimeEnv,
} from "@/lib/ai/serviceHandler";
import { measureRouteBudget } from "@/lib/api/routeBudget";
import { getRequestContext } from "@cloudflare/next-on-pages";

export const runtime = "edge";

/**
 * SSE variant of /api/ai (Backend row "Streaming Responses").
 *
 * Scope: transport scaffold only. The request goes through the exact same
 * guarded path as /api/ai (executeAiCore: auth, per-IP and per-user rate
 * limits, quotas, budget reservation, circuit breaker, idempotency, output
 * sanitization) and the completed, sanitized result is then delivered as
 * Server-Sent Events. Nothing about the existing JSON endpoint, the client
 * helper, or any user-visible behavior changes.
 *
 * Feature-gated: the route answers 404 unless AI_STREAMING_ENABLED is set
 * ("1" or "true") in the Pages/Functions environment. See docs/streaming.md.
 *
 * Frame contract (UTF-8 text/event-stream):
 *   event: meta  - { operation, model } once, first frame
 *   event: chunk - { t: string } slices of the result text, in order
 *   event: done  - { success: true } final frame before the stream closes
 * Non-200 outcomes (401/403/429/5xx) return the same JSON error body and
 * status code as /api/ai, not an SSE stream.
 */

// Chosen default: fixed-size slices for transport framing; the upstream
// call stays buffered until token streaming is threaded through
// executeAiCore (follow-up, see docs/streaming.md).
const CHUNK_SIZE = 400;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function postHandler(req: Request): Promise<Response> {
  let cfEnv: Record<string, any> | undefined;
  try {
    const ctx = getRequestContext();
    if (ctx?.env) {
      cfEnv = ctx.env as Record<string, any>;
    }
  } catch {}

  const enabled = getRuntimeEnv("AI_STREAMING_ENABLED", cfEnv);
  if (enabled !== "1" && enabled !== "true") {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const clientIp = getClientIpFromRequest(req);
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");
  const body = await req.json().catch(() => ({}));

  // Second flag, OFF by default: ask the upstream provider for a streamed completion and
  // assemble it server-side. The assembled text is still validated and sanitized as a whole
  // before any SSE frame is written, so no unsanitized text ever reaches the client.
  const upstreamFlag = getRuntimeEnv("AI_UPSTREAM_STREAMING_ENABLED", cfEnv);
  const upstreamStream = upstreamFlag === "1" || upstreamFlag === "true";

  const res = await executeAiCore(clientIp, authHeader, body, { env: cfEnv, upstreamStream }, "ai:ip:");

  if (res.statusCode !== 200) {
    return new Response(JSON.stringify(res.body), {
      status: res.statusCode,
      headers: { "Content-Type": "application/json", ...(res.headers || {}) },
    });
  }

  const text: string = res.body?.result ?? res.body?.content ?? "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseFrame("meta", {
            operation: res.body?.operation,
            model: res.body?.model,
          })
        )
      );
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        controller.enqueue(
          encoder.encode(sseFrame("chunk", { t: text.slice(i, i + CHUNK_SIZE) }))
        );
      }
      controller.enqueue(encoder.encode(sseFrame("done", { success: true })));
      controller.close();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function POST(req: Request) {
  return measureRouteBudget("/api/ai/stream", () => postHandler(req));
}
