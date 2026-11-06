# Runbooks: Recurring Operational Failures

## 1. A scheduled cron fails with `missing_env`

Symptom: Actions run log ends with `Reason: missing_env`.

1. Open the failing script's env list in its workflow file
   (`.github/workflows/*cron*.yml`) - every `secrets.X` referenced must
   exist under repo Settings > Secrets and variables > Actions.
2. Note that **dry-run skips mail-config validation** in
   `early-access-digest-cron.ts`, so a green dry-run does not prove env
   is complete (being fixed - see postmortem 2026-11-06).
3. Add the missing secret, re-run with `workflow_dispatch`
   (dry_run=false), and confirm `Status: SUCCESS` with a real send.

## 2. Groq quota / key failures in AI routes or matching cron

Symptom: AI routes fall back to rules-based content; Sentry shows Groq
401/429.

1. Check key validity and spend at console.groq.com.
2. If rotating, follow `docs/security/secrets-rotation-runbook.md` and
   update GitHub Actions + Cloudflare + Netlify env together.
3. The circuit breaker (PR #239) opens after repeated timeouts - it
   recovers on its own; no deploy needed.

## 3. GitHub Actions minutes / billing exhausted

Symptom: workflows stop queueing; billing banner on the repo.

1. Public repos get free Actions minutes - the repo is public since
   2026-11-05, which is the current workaround.
2. Owner to clear the failed payment / spending limit in org billing if
   the repo ever goes private again.

## 4. Netlify backup deploys paused

Symptom: Netlify deploys fail with credits exhausted.

1. Cloudflare Pages (carrier-hound.pages.dev) is primary; Netlify is a
   backup host. No action needed for users.
2. Credits reset monthly; pause Netlify builds until then.

## 5. Main CI red after a workflow change

Symptom: security-scan or ci workflow fails on `main`.

1. Read the failing job log; the usual cause is a missing
   `permissions:` block (needs `contents: read`, `checks: write` for
   review jobs) - see PR #242.
2. Fix forward on a branch; never merge to main while red.

## 6. Ingestion produces zero new jobs

Symptom: ingest workflow green but `ingest_runs` shows 0 inserts.

1. Run `npx tsx scripts/board-verify-all.ts` to find dead sources.
2. Check Groq/Supabase secrets are still valid (rotation drift).
3. Dead sources stay listed in SOURCES.md - mark them dead there when
   confirmed.
