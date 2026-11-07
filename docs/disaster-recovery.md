# Disaster Recovery Runbook

Backend sheet rank 61 (Backup & DR). Today there is no recovery plan beyond
"Supabase platform backups + git". This runbook is the minimum viable DR
procedure for the assets the app actually depends on. Recovery-time and
recovery-point targets are marked **owner to confirm** - they are commercial
decisions, not something this document can invent.

## What we are recovering

| Asset | Source of truth | Recovery path |
| --- | --- | --- |
| Application code | GitHub repo (`main`) | Redeploy from git (Netlify auto-deploy or manual `netlify deploy --prod`) |
| Postgres data (resumes, jobs, profiles, events) | Supabase project | Supabase platform backups / point-in-time recovery (owner action in the Supabase dashboard) |
| Database schema (tables, RLS, functions) | `supabase/migrations/*.sql` in git + migration ledger (`record-migration.cjs`) | Replay migrations into a fresh project, then verify with `npx tsx scripts/suite-runner.ts` |
| Upstash Redis (rate limits, locks) | None - intentionally ephemeral | Nothing to restore; limits rebuild on traffic |
| Config / secrets | Netlify + GitHub env vars | Re-enter from the owner's password manager (owner action) |

## Recovery procedures

### 1. Site down, database healthy

1. Redeploy the last green commit: Netlify dashboard "Retry deploy", or
   `netlify deploy --prod` locally.
2. Verify: load `/api/health` and the homepage (or run
   `npx tsx scripts/smoke-post-deploy.ts` for the scripted smoke suite).
3. If the last deploy is broken, redeploy the previous commit.

### 2. Database corrupted or dropped

1. Owner: restore the Supabase project from a platform backup or PITR to a
   point before the incident (Supabase dashboard - owner-only).
2. If restoring into a fresh project instead, replay the schema:
   - set the new `SUPABASE_URL` / service key in Netlify and GitHub secrets,
   - apply every file in `supabase/migrations/` in lexical order (they are
     timestamped; each carries a rollback section),
   - run `node scripts/record-migration.cjs <migration-file>` per applied
     migration so the
     ledger reflects reality.
3. Verify: `npx tsx scripts/suite-runner.ts` (policy + maintenance checks;
   the live-Supabase entries need the env vars from step 2).

### 3. Redis (Upstash) lost

No action. Rate limits and locks are ephemeral; they rebuild on traffic.
Expect a brief window with no rate limiting after a full loss.

## Targets (owner to confirm)

- **RPO** (max acceptable data loss): owner to confirm - bounded by the
  Supabase backup cadence for the project's plan tier.
- **RTO** (max acceptable downtime): owner to confirm - the site-only
  procedure above is minutes; a full database restore depends on Supabase.

## Rehearsal

Owner to confirm cadence (quarterly suggested): restore a backup into a
throwaway Supabase project, point a preview deploy at it, run `npx tsx scripts/suite-runner.ts`
and its policy checks, record the result in `docs/incident-log.md`.
