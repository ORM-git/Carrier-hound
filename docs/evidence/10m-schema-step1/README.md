# Evidence: PR #643 repair (`20261116b`) rehearsals

Machine-generated results committed as review evidence. They are produced by the runners in `scripts/`. Nothing
here was run against production; every database was a local, disposable instance.

| File | Runner | Result |
|---|---|---|
| `postgres17-repaired-200k.json` | `npm run test:10m-postgres` (repaired 16b, 200,000 jobs) | **248 passed, 0 failed**, exit 0 (the previous 225, plus 10 ACL grant-option / fail-closed checks and 13 remove-if-empty late-writer checks) |
| `postgres17-repaired-negative-control.json` | `npm run test:10m-postgres -- --negative-control` | exit 1 (expected); 8 checks caught row, freshness, delete and ACL tampering |
| `postgres17-original-643-control-20k.json` | `... --jobs=20000 --migration=<original 16b @ f8280087>` | exit 1 (expected): 90 passed, 26 failed. Unique-index apply failure, `deadlock detected` in both lock-order probes, no provenance so no safe rollback |
| `pglite-repaired.json` | `npm run test:10m-rehearsal` | **223 passed, 0 failed**, exit 0 (the previous 213, plus 10 ACL checks) |

**Machine.** 13th Gen Intel Core i5-13420H, 12 logical cores, 16 GB RAM, Windows 11. PostgreSQL 17.12
(x86_64-windows) with default settings: `shared_buffers` 128 MB, `maintenance_work_mem` 64 MB, `work_mem` 4 MB,
`fsync` on, `synchronous_commit` on. The cluster ran on a local SSD temp directory and listened on 127.0.0.1 only.
PGlite 0.5.16 is PostgreSQL 18.6 compiled to WASM.

**Scaled fixture** (reconstructed owner post-#645 baseline, F incomplete). 200,000 jobs (160,000 active, 505 MB
including indexes), 2,000 companies, 100,000 job_descriptions and 5,000 saved_jobs, populated in 400 s.

## Concurrency timeline (`postgres17-repaired-200k.json`, `notes.scale_*`)

Sessions: migration, held reader, live writer (INSERT every 25 ms), feed reader (`jobs_public`, every 25 ms), and a
lock observer sampling `pg_locks` and `pg_stat_activity` every 50 ms.

**a. Contention** (a reader holds `ACCESS SHARE` on jobs; `lock_timeout = 3s`)

| ms | Event |
|---|---|
| 0 | The reader holds `ACCESS SHARE` on `public.jobs` in an open transaction |
| 47 | 16b is waiting for its locks |
| 413 | Writer and feed reader start; they queue behind 16b's pending `ACCESS EXCLUSIVE` request |
| 3,007 | 16b gives up: `canceling statement due to lock timeout` (3,083 ms total) |
| after | Queued traffic proceeds (worst write 2,772 ms, worst read 2,731 ms). Data, schema, grants and #645 state are unchanged, with no partial objects |

**b. `statement_timeout = 250ms`** fires inside the migration transaction. It aborts in 799 ms and leaves
everything unchanged.

**c. Retry under live writes and reads** (`lock_timeout = 3s`)

| ms | Event |
|---|---|
| 0 | Steady state: write p50 6 ms / p95 11 ms, read p50 2 ms / p95 2 ms |
| 507 | 16b starts; its lock prelude waits up to 945 ms for in-flight statements |
| 1,573 | 16b holds `ACCESS EXCLUSIVE` on jobs, companies, job_descriptions and saved_jobs; all traffic queues |
| 8,435 | Last sample with the locks held (**held about 6.9 s**) |
| 8,485 | 16b commits (7,978 ms total). Traffic resumes: worst write 7,981 ms, worst read 7,983 ms, no errors |

**d. Second apply.** A no-op in 175 ms, but it still takes `ACCESS EXCLUSIVE` on all four tables.

**Lock-order probes.** A writer holds `jobs` (INSERT) and then FK-checks `companies`, or holds `saved_jobs`
(UPDATE) and then reads `jobs`. In both cases the writer committed first and 16b followed 1.3–1.7 s later. The
original 16b got `deadlock detected` in both. These are the only writer orders proven; others are not claimed.

**Rollback** (documented scripts, real PostgreSQL). Disable took 93 ms (reconstructed baseline) and 81 ms (full-D
baseline). Provenance recorded 11 created relations, 33 added columns on pre-existing tables and 2 prior grant/RLS
states. Every rollback check passed (see `checks` with scenario `R:*`).

**Remove-if-empty vs late writers** (`checks` with scenario `W`, `notes.late_writer_regression`). Two real sessions
on a disabled 16b with empty created tables:

| Order | Result |
|---|---|
| Writer first: open transaction INSERTs into `internal_ingestion.ingestion_sources` | Removal waits 3,014 ms, then refuses (`could not take write-blocking locks … lock timeout`), nothing dropped. After the writer commits, removal refuses (`data would be lost: … has 1 rows`) and the row is present |
| Writer first: open transaction sets `public.jobs.source_registry_id` (a reference-holder column) | Removal waits 3,020 ms, then refuses; after the commit it refuses (`source_registry_id is set on 1 rows`) and the value is present |
| Removal first: checks passed and drops done, transaction still open | It holds `ACCESS EXCLUSIVE` on jobs, companies and auth.users (FK parents) and `EXCLUSIVE` on saved_jobs and job_descriptions. A late INSERT into the created table and a late `jobs.source_registry_id` write both block (observed `wait_event_type = Lock`); a read of saved_jobs runs (8 ms). After COMMIT the INSERT fails (`relation … does not exist`, never committed) and the `jobs` write commits and is present |


## Reproduce

```sh
npm ci
npm install --no-save pg@8                       # client only; package.json is not changed
PG_BIN=<dir with initdb, pg_ctl, postgres> npm run test:10m-postgres -- --json=<out.json>
npm run test:10m-rehearsal -- --json=<out.json>
```

Timings depend on hardware and say nothing about a 10M-row production table.
