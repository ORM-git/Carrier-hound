# AI prompts, tool use, logging and provider swap points (Backend sheet rows: Few-shot Prompting, Function / Tool Calling, Prompt / Response Logging, Provider Abstraction Layer)

Status: a code-reading note. It changes no code and calls no model. All four rows stay PARTIAL. Statements below are
what the code shows today, with file names so they can be re-checked.

## Where prompts are built

`buildOperationPayload` in `src/lib/ai/security.ts` builds the messages on the server for four operations:
`cover_letter`, `resume_extraction`, `resume_tailor` and `job_fit` (`OPERATION_CONFIGS`). Each is one system message
and one user message. Client-supplied raw models and message arrays are rejected. Candidate and job text is wrapped
in `<untrusted_candidate_data>` style tags plus `UNTRUSTED_DATA_SYSTEM_GUARD`.

## Few-shot prompting (row stays PARTIAL)

- A search of `src/lib` and `src/app/api` for "few-shot", "fewshot" and "examples" found no match. The `job_fit`
  system prompt read for this note describes the required JSON shape in words and rules, with no worked example
  pairs. The other three prompts were not each read line by line.
- The sheet note says few-shot is used in prompt construction. That does not match this search, so the owner should
  confirm what was meant (a schema description counts as zero-shot here).
- Quality is checked offline only for the guard rules (`docs/ai-evals.md`). Judging real model output needs live calls
  and a human reference set, which is an owner decision.

## Tool calling (row stays PARTIAL)

- The upstream request sets `response_format: { type: "json_object" }` when an operation has `jsonMode: true`
  (`resume_extraction`, `resume_tailor`, `job_fit`); `cover_letter` is plain text.
- The upstream request body in `src/lib/ai/serviceHandler.ts` has no `tools` or `tool_choice` field, so there is no
  model-driven tool use and no multi-step loop. Output is parsed and checked by `validateAndSanitizeAiOutput`.
- A design with real tool calling would be a new feature and an owner decision, not a doc change.

## What is logged and stored (row stays PARTIAL)

- Token accounting: the upstream `usage.prompt_tokens` and `completion_tokens` settle the daily token budget, with an
  estimate as the fallback (`serviceHandler.ts`, budget settle code). Budget alerts go through `emitBudgetAlert`.
- Usage rows: `plan_usage_events` rows carry the user, operation kind, idempotency key and, after success, the
  `response_payload` (the validated output) so a retry can replay it. See `docs/data-classification.md` for how that
  table is classed.
- Prompt text: the code reviewed passes the messages to the upstream request only. The log calls in
  `src/lib/ai/serviceHandler.ts` log errors and statuses, not message content. The prompts are therefore not captured, which
  matches the sheet's "deliberately limited" note. Whether a vendor keeps prompts is a vendor setting (owner to
  confirm with the vendor terms, see `docs/subprocessors.md`).
- Full prompt capture would store resume text and needs a privacy decision first (owner).

## Provider abstraction: swap points (row stays PARTIAL)

Groq is called directly, through one OpenAI-style chat-completions request. The places a provider swap would touch:

| Place | What is Groq-specific |
| --- | --- |
| `src/lib/ai/serviceHandler.ts` (upstream `fetch`) | The URL, the `GROQ_API_KEY` bearer header, the request body fields, the `usage` response field |
| `src/lib/ai/security.ts` `OPERATION_CONFIGS` | Model names (`SMART_MODEL`, `FAST_MODEL` env, with defaults) |
| `src/lib/ai/upstreamStream.ts` | Reads the stream, including the `x_groq.usage` frame |
| `src/lib/ai/circuitBreaker.ts` | The breaker is named for Groq but its logic is generic |
| `AiServiceDeps.callGroq` | A test seam that already replaces the upstream call |
| `docs/security/secrets-rotation-runbook.md` | The key name and where it is stored |

The `callGroq` seam shows the call can be replaced in tests. There is no provider interface with a second
implementation, so a swap needs a code change and is not tested here (owner decision if wanted).

## What stays unproven

- Any model behavior. Nothing was run.
- Whether vendor-side prompt retention is on or off.
- That every other prompt string is free of examples (not each read in full).

## Owner steps

1. Say what "few-shot used" in the sheet note referred to, or accept that it is zero-shot today.
2. Decide whether a human-reviewed quality set is wanted (needs live model calls).
3. Check the vendor's prompt retention setting and record it privately.
4. Decide whether a provider interface is worth building before a second provider is needed.
