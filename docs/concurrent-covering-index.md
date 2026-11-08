# Standalone concurrent covering-index build

`supabase/migrations/20261106n_covering_index_jobs_list.sql` is NOT APPLIED.
It contains one executable `CREATE INDEX CONCURRENTLY` statement. No live
schema check or execution is claimed here.

## Before applying

An owner must confirm the target and existing jobs schema, backup/recovery
plan, disk headroom, workload window and absence of another concurrent index
build on jobs. This is an ordinary nonpartitioned-table build; partitioned
tables require a different plan. Check the table type, do not assume it.

Inspect the existing named index in a separate read-only statement:

```sql
select c.relname, c.relkind, i.indisvalid, i.indisready,
       pg_get_indexdef(c.oid) as definition
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_index i on i.indexrelid = c.oid
where n.nspname = 'public' and c.relname = 'jobs_active_list_covering_idx';
```

No row means no object under that name. A row with the expected name is not
proof the definition matches. Compare the key columns/order, INCLUDE columns
and predicate against the migration. If a conflicting object or valid but
different index exists, stop for review rather than blindly dropping it.

## Execution boundary

Use an autocommit-capable connection. For psql, configure its connection
privately (never put passwords in chat or commit them), then run:

```sh
psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261106n_covering_index_jobs_list.sql
```

This file has one statement. Do not use `--single-transaction` / `-1`,
`BEGIN`, a function, a DO block, or a transactional migration runner. Do not
paste it together with other migrations into one SQL-editor batch. If the
editor wraps the statement in a transaction, use the supported standalone
connection route; do not fall back to a blocking plain CREATE INDEX.

CONCURRENTLY permits ordinary writes during the build but performs extra
scans, takes some locks and can wait for old transactions. It is not a promise
of zero waiting, zero load or a measured zero-downtime rollout.

## Failure and verification

A cancelled or failed concurrent build may leave an INVALID index. `IF NOT
EXISTS` can then skip the broken object without repairing it. After failure,
inspect validity and definition using the query above. Only after confirming
the object is the failed build and approving cleanup, execute this alone in
autocommit mode:

```sql
DROP INDEX CONCURRENTLY IF EXISTS public.jobs_active_list_covering_idx;
```

Then retry the original standalone build. Do not automatically retry a failed
build in a loop. Preserve the error privately for diagnosis.

After success, verify `indisvalid = true`, `indisready = true` and the complete
expected definition. A successful command or IF NOT EXISTS notice alone is
not enough. Query-plan usefulness still needs EXPLAIN under the actual jobs
view/query and statistics; it is not proved by the index merely existing.
Only after that verification record the migration ID as its header says.

Rollback uses the same standalone `DROP INDEX CONCURRENTLY` shown above.
This removes only the index, not job data, but still needs an owner decision.

Sources checked:
- https://www.postgresql.org/docs/current/sql-createindex.html
- https://www.postgresql.org/docs/current/app-psql.html

Offline guards check that the migration stays one standalone concurrent
statement and retains the key order, INCLUDE coverage, predicate, invalid-index
warning and concurrent rollback. They do not execute SQL or validate the live
table/index schema.
