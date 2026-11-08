# Read-only DB health probe

Repository automation for DB audit ranks 29-33, 58 and 62. This does not mean
those checks are live. Migration `20261108b_db_health_snapshot.sql` is NOT
APPLIED and the workflow is inert until explicitly enabled by the owner.

## What it does

The service-role-only RPC reads PostgreSQL public-schema table/index counters,
relation sizes, the statistics reset time, and the count of failed cron runs in
the last 24 hours. It does not read user rows, query text or error payloads.
There are no data writes, vacuum operations or index changes.

The probe returns aggregate counts and fixed alert codes only. The CLI exits
nonzero for RPC/configuration errors, stale results, unavailable cron metrics,
empty public-table inventory, truncated inventory, failed cron runs, or dead
tuple pressure. GitHub Actions then marks the workflow failed. Paging and email
notification delivery depend on the owner's GitHub notification settings and
are not configured by this change.

Chosen alert defaults:

- A snapshot must be at most five minutes old and no more than one minute in
  the future. Network timeout is ten seconds; database statement timeout is
  five seconds.
- At least 1,000 estimated dead tuples and dead / (live + dead) >= 20% raises
  an alert. Estimates indicate pressure, not measured physical bloat.
- A nonunique index with zero scans and size >= 50 MiB is advisory only, and
  only after at least seven days since a known stats reset. Never drop an
  index based on this count alone. Rare queries may need it.
- The snapshot includes the largest 100 tables and indexes. Larger inventories
  produce a coverage alert, rather than a false green.

Size is a current sample, not a historical growth trend or a size threshold.
This does not measure physical index bloat. Those audit gaps remain open.

## Owner activation (not performed)

1. Review and manually apply the unapplied migration, then record its ID with
   `node scripts/record-migration.cjs 20261108b_db_health_snapshot`.
2. Check the repository secrets `NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` without printing their values.
3. Explicitly set the repository variable `DB_HEALTH_PROBE_ENABLED` to `true`.
4. Run the workflow manually once, inspect its aggregate output and verify
   the expected GitHub failure notifications with an intended recipient.

The weekly schedule is Monday 02:13 UTC. The same enablement gate covers
manual runs. Local execution is `npx tsx scripts/probe-db-health.ts`, using
those two environment variables. Do not run it against production without
permission for the check. Tests inject fake metrics and a fake transport and
need no live database.

Disable by setting the enablement variable to `false`. Rollback, after
stopping the workflow: manually drop `public.db_health_snapshot()` as shown
in the migration. No live configuration or schema change was made here.
