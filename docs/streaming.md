# Streaming responses (INTERNAL)

Backend sheet rank 16 ("Streaming Responses"): AI answers were one-shot
JSON only. This adds an SSE transport scaffold at
`POST /api/ai/stream` without changing any existing behavior.

## What exists now

- `src/app/api/ai/stream/route.ts` - edge runtime, same guarded path as
  `/api/ai`: the request runs through `executeAiCore` (Supabase auth,
  per-IP and per-user rate limits, quota and budget reservation, circuit
  breaker, idempotency, output sanitization) and the completed, sanitized
  result is delivered as Server-Sent Events. Non-200 outcomes return the
  same JSON error body and status as `/api/ai`, never an SSE stream.

## Gate

The route answers 404 unless `AI_STREAMING_ENABLED` is `"1"` or `"true"`
in the Pages/Functions environment. It is off by default; nothing
client-side calls it yet, so there is no visible change.

## Second flag: upstream streaming (OFF by default)

`AI_UPSTREAM_STREAMING_ENABLED` (`"1"` or `"true"`, read only after the
`AI_STREAMING_ENABLED` 404 gate) makes `executeAiCore` ask the provider for
`stream: true` with `stream_options.include_usage` and assemble the text
server-side (`src/lib/ai/upstreamStream.ts`). Everything after that is the same
code: the assembled text is validated and sanitized as a whole, budget settles from
the usage frame (or the estimate), quota and lease release run on failure, and
idempotency stores the same payload. A malformed, empty, errored or oversized
stream (200000 characters) is treated like an unparseable JSON body: 502 with the
same error text, budget settled 0, quota refunded.

With the flag off (default) the upstream request body and the `response.json()`
path are unchanged, and `/api/ai` never enables it.

What this is NOT: no partial text reaches the client before sanitization, so the
SSE frames the route sends are still slices of the finished, sanitized result.
Forwarding sanitized text while the model is still generating needs an incremental
sanitizer (prefixes of the sanitized output are not always sanitized prefixes) and a
client that renders partial text; that stays a follow-up. Live Groq streaming
behavior (frame shapes, usage placement) is unproven here: tests use a faked
upstream. Owner to confirm against a real call before turning the flag on.

## Frame contract

```
event: meta
data: {"operation": "...", "model": "..."}

event: chunk
data: {"t": "..."}        # repeated; concatenating t yields the result

event: done
data: {"success": true}
```

Slices are a fixed 400 characters (chosen default): this is transport
framing only. True token streaming requires threading Groq's
`stream: true` through `executeAiCore` so guards and quota settlement
still wrap the upstream call; that is a deliberate follow-up, not part of
this scaffold.

## Owner steps

1. Set `AI_STREAMING_ENABLED=1` in the Cloudflare Pages environment when
   a frontend surface is ready to consume SSE.
2. Frontend adoption is a separate change and must keep the existing
   one-shot fallback.

## Rollback

Unset `AI_UPSTREAM_STREAMING_ENABLED` to return to buffered upstream calls. Delete
`src/app/api/ai/stream/route.ts` (and this doc) or unset `AI_STREAMING_ENABLED`. No database or client changes to revert.
