# Prompt template versioning (Backend sheet row: Prompt Template Versioning)

Status: change-control guard only. No runtime registry. No prompt text was changed.

The four AI operations (`cover_letter`, `resume_extraction`, `resume_tailor`, `job_fit`) build their
prompts in `buildOperationPayload` (`src/lib/ai/security.ts`). `scripts/test-prompt-template-versions.ts`
(offline, registered in the suite) builds each operation from a fixed fixture, hashes the full request
(system and user messages, model, temperature, max output tokens, JSON mode) with SHA-256 and compares it
with a `version` + `sha256` table inside the test.

## Changing a prompt on purpose

1. Edit the prompt or setting.
2. Run `PRINT_PROMPT_HASHES=1 npx tsx scripts/test-prompt-template-versions.ts` to print the new hashes.
3. In the same PR, bump `version` for that operation and update its `sha256`.

The test fails until both are done, so a prompt change cannot slip in unnoticed and every prompt state has a
version number that can be quoted in a PR or incident note.

## What this does NOT give you

- No runtime selection of a prompt version and no per-prompt rollback. Rollback is a git revert.
- No judgement of prompt quality. It does not evaluate output quality.
- The fixture covers the normal path. Edge branches (for example a shortened job description) are not hashed.
