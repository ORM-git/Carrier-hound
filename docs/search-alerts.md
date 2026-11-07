# Search alerts dispatcher (Backend sheet rank 83)

Status: code and tests only. Gated OFF. Nothing calls it yet. Nothing applied to the
live database. No email or provider call exists in this code.

## Pieces

- `src/lib/alerts/searchAlertDispatcher.ts`: `dispatchSearchAlerts` with injected
  repository and sender, plus `claimJobsInDb` / `releaseJobsInDb` for the sent-log.
- `supabase/migrations/20261107b_search_alert_dispatches.sql` (NOT APPLIED): table
  `search_alert_dispatches` with primary key `(alert_id, job_id)`, RLS on, service_role
  only, rollback block. Record with
  `node scripts/record-migration.cjs 20261107b_search_alert_dispatches` after applying.
- `scripts/test-search-alert-dispatcher.ts`: offline test (suite-runner).

## Gates

1. `SEARCH_ALERTS_DISPATCH_ENABLED` must be `1` or `true`. Off (default): returns
   `status: "disabled"` before the repository or sender is touched.
2. `minIntervalMs` is required and has no default. The throttle number is a product
   decision (owner to confirm). Without it: `status: "no-throttle-configured"`.

## Behavior when enabled

Throttle by `lastSentAt`, skip suppressed recipients, claim `(alert, job)` pairs with
insert-ignore so a job is sent once per alert even across parallel runs, release the
claims if the sender fails, and isolate failures per alert.

## What is NOT done (owner steps and unknowns)

- The DDL of `public.search_alerts` is not in this repo (only the soft-delete column in
  `20261106h`). The repository that reads alerts and maps them to `SearchAlertRecord`
  (`findNewMatches`, `listActiveAlerts`) is the caller's, so no column names are assumed.
  Owner to confirm the columns.
- No cron route and no real mail sender is wired. Choosing the provider, the template and
  the unsubscribe link (`src/lib/email/unsubscribe.ts` exists) is an owner step.
- Live SQL behavior of the migration and real delivery are unproven.
- The sheet row likely stays PARTIAL until the owner wires and activates it.
