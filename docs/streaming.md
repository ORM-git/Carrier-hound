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

Delete `src/app/api/ai/stream/route.ts` (and this doc) or unset
`AI_STREAMING_ENABLED`. No database or client changes to revert.
