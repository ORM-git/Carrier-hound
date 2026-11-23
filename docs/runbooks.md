# Runbooks: Recurring Operational Failures

## 1. A scheduled cron fails with `missing_env`

Symptom: Actions run log ends with `Reason: missing_env`.

1. Open the failing script's env list in its workflow file
   (`.github/workflows/*cron*.yml`) - every `secrets.X` referenced must
   exist under repo Settings > Secrets and variables > Actions.
2. Add the missing secret, re-run with `workflow_dispatch`
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

See also: [dns-cutover-runbook.md](dns-cutover-runbook.md) for the untested plan to move the domain between hosts.

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

## 7. Python ingestion cohorts: owner verification (not run by agents)

Symptom: Python ingestion workflow failure or degraded cohort status reported in Actions.

`python-ingest.yml` runs two independent cohorts, `non-workday` then `workday`, each with its own report
(`python-ingest-<cohort>-<run_id>` artifact) and its own failed-source write guard. The overall job is green
only when every cohort is green: one red cohort means DEGRADED, not success. Workday is partial coverage and
never expires jobs. Scheduled runs keep the old authority (write, production, expire); manual runs default to
`dry-run`, and a manual write needs `mode=write-production-expire` plus the confirm text
`WRITE PRODUCTION AND EXPIRE`.

Owner sequence, each step separately approved:

1. Review the exact PR head SHA and its CI (pytest `scripts/scraper/`, including `test_cohorts.py` and the #703
   Workday deadline/backoff tests).
2. Merge (separate approval). GitHub cron only runs from the default branch and is best-effort: confirm the
   workflow is active in Actions, and do not treat a missing scheduled run as proof the code failed.
3. Optional: manual `dry-run` with `cohort=both`. Check each cohort report: selected / completed / failed
   sources, fetched vs unique, projected counts. Dry runs never write; projections are not confirmed writes.
4. Before any write run, record a timestamped "before" reading from the CM site with the established CM test
   account (or the public `/api/stats`). Anonymous `/api/stats` only returns `jobsToday` and `updatedAt`:
   a field that is absent is unknown, never zero. Never use a service-role key or a user's session token in a
   public checker, and never read the production DB directly for this.
5. Write run (scheduled, or manual with the confirm text). For each cohort record: SHA, start/finish, failed
   sources, `guard` reason, confirmed inserted / updated / unchanged / expired, persistence failures.
6. Record a timestamped "after" reading the same way as step 4. Fetched jobs are not new jobs, and a zero net
   active delta can be real: never force writes to move a number.
7. If one cohort keeps failing (for example Workday 429 on the runner IP), the other cohort still writes;
   escalate the failing one through the owner checklist instead of loosening the guard or retrying faster.
