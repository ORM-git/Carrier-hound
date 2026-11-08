# AI output golden eval set (Backend sheet row: Evals / Quality Checks)

Status: offline guard evals only. No model call, no network, no database.

Run: `npx tsx scripts/eval-ai-output-golden.ts` (exit 1 on any mismatch). Registered in the
offline suite as `scripts/eval-ai-output-golden.ts`.

## What it covers

29 fixed cases in two groups, each with an expected verdict:

- `cover_letter` (13): `validateCoverLetter` in `src/lib/resume/tailor.ts`. Clean letter, own email
  and phone, verified employer, script markup, inline handler, foreign email, fabricated phone,
  fabricated link, invented years and prior roles for a fresher, unverified employer, unevidenced
  microservices claim.
- `ai_output` (16): `validateAndSanitizeAiOutput` in `src/lib/ai/security.ts`. Empty output,
  system prompt leak, markup stripping, invalid JSON, wrong JSON shape, schema type errors,
  job_fit score clamping.

See also: [ai-prompt-and-provider-notes.md](ai-prompt-and-provider-notes.md) for how prompts are built, what is logged, and the provider swap points.

## How to extend

When a bad output slips through, add a case to `scripts/eval-ai-output-golden.ts` with the input, the
expected verdict, and the reason text it must produce. The case fails until the rule catches it.

## What it does NOT do (owner work)

- It scores the guard rules, not the quality of real model output. Judging quality needs live model
  calls and a human-reviewed reference set. That is an owner decision and is not built.
- It does not cover the `resume_tailor` deep validation (`validateTailoredResumeOutput`) beyond the
  no-context schema rejection.
- Rules that are not in the code today (for example tone or length targets) are not evaluated.
