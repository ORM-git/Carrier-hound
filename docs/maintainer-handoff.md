# Maintainer continuity and handoff (internal)

Purpose: reduce dependence on one maintainer without pretending a backup
operator or account access has already been arranged. Code inventory checked
2026-11-06. No secondary maintainer has been verified in this document.

## Repository handoff

A new maintainer should be able to do these steps using their own account:

1. Clone the repo, use the Node version in CI and run `npm ci`.
2. Run `npx tsc --noEmit`, `npm run lint`, and the test command in
   `.github/workflows/ci.yml`. Inspect results; do not suppress failures to
   complete a handoff. CI owns the production build when local resources
   are insufficient.
3. Trace one public request (`src/app/api/stats/route.ts`) and one protected
   request through their handler/auth helpers. Identify where service-role
   credentials are required and where authorization is enforced.
4. Read `docs/runbooks.md`, `docs/slo.md`, `docs/incident-log.md`,
   `docs/retention-policy.md` and the secrets rotation runbook.
5. Open a small test-only PR and have another reviewer verify it. Do not
   make a production incident the first deployment exercise.

## Production access handoff (owner task)

Nominate a backup operator, then grant least-privilege access from the owner
accounts. Do not transfer shared passwords through chat, repo files or PRs.
Use the approved secret store and individual accounts with MFA.

| Capability | What the backup must demonstrate | State |
| --- | --- | --- |
| Repository / CI | Read a failed job, rerun an authorized workflow, open a reviewed fix | Not verified |
| Primary and backup hosts | Find the active deployment, inspect logs, explain rollback | Not verified |
| Database/auth | Inspect auth/database health, locate backup/restore procedure without exposing user data | Not verified |
| Mail/cron | Diagnose `missing_env`, inspect a cron result, avoid duplicate sends | Not verified |
| AI provider | Diagnose quota/key failure and explain fallback behavior | Not verified |
| Incident response | Follow the incident log/runbooks and know who may approve rotation or downtime | Not verified |

Keep named people, contact routes and access evidence in the owner's private
operational record. This public repository should not list personal numbers,
secret values or private account recovery details.

## Completion evidence

Record the named backup's acceptance, date, scoped access grants and a safe
staging/rehearsal result for each capability. Until those exist, documentation
is preparation only: bus-factor reduction is incomplete. Rehearse again
after major host, auth, database or cron changes.
