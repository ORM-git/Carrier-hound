# Evidence: PR #643 repair (`20261116b`) rehearsals

Machine-generated results committed as review evidence. They are produced by the runners in `scripts/`. Nothing
here was run against production; every database was a local, disposable instance.

| File | Runner | Result |
|---|---|---|
| `postgres17-repaired-200k.json` | `npm run test:10m-postgres` (repaired 16b, 200,000 jobs) | **225 passed, 0 failed**, exit 0 |
| `postgres17-repaired-negative-control.json` | `npm run test:10m-postgres -- --negative-control` | exit 1 (expected); 8 checks caught row, freshness, delete and ACL tampering |
| `postgres17-original-643-control-20k.json` | `... --jobs=20000 --migration=<original 16b @ f8280087>` | exit 1 (expected): 90 passed, 26 failed. Unique-index apply failure, `deadlock detected` in both lock-order probes, no provenance so no safe rollback |
| `pglite-repaired.json` | `npm run test:10m-rehearsal` | **213 passed, 0 failed**, exit 0 |

**Machine.** 13th Gen Intel Core i5-13420H, 12 logical cores, 16 GB RAM, Windows 11. PostgreSQL 17.12
(x86_64-windows) with default settings: `shared_buffers` 128 MB, `maintenance_work_mem` 64 MB, `work_mem` 4 MB,
`fsync` on, `synchronous_commit` on. The cluster ran on a local SSD temp directory and listened on 127.0.0.1 only.
PGlite 0.5.16 is PostgreSQL 18.6 compiled to WASM.

**Scaled fixture** (reconstructed owner post-#645 baseline, F incomplete). 200,000 jobs (160,000 active, 505 MB
including indexes), 2,000 companies, 100,000 job_descriptions and 5,000 saved_jobs, populated in 285 s.

## Concurrency timeline (`postgres17-repaired-200k.json`, `notes.scale_*`)

Sessions: migration, held reader, live writer (INSERT every 25 ms), feed reader (`jobs_public`, every 25 ms), and a
lock observer sampling `pg_locks` and `pg_stat_activity` every 50 ms.

**a. Contention** (a reader holds `ACCESS SHARE` on jobs; `lock_timeout = 3s`)

| ms | Event |
|---|---|
| 0 | The reader holds `ACCESS SHARE` on `public.jobs` in an open transaction |
| 48 | 16b is waiting for its locks |
| 422 | Writer and feed reader start; they queue behind 16b's pending `ACCESS EXCLUSIVE` request |
| 2,988 | 16b gives up: `canceling statement due to lock timeout` (3,058 ms total) |
| after | Queued traffic proceeds (worst write 2,723 ms, worst read 2,683 ms). Data, schema, grants and #645 state are unchanged, with no partial objects |

**b. `statement_timeout = 250ms`** fires inside the migration transaction. It aborts in 852 ms and leaves
everything unchanged.

**c. Retry under live writes and reads** (`lock_timeout = 3s`)

| ms | Event |
|---|---|
| 0 | Steady state: write p50 5 ms / p95 11 ms, read p50 1 ms / p95 2 ms |
| 507 | 16b starts; its lock prelude waits up to 942 ms for in-flight statements |
| 1,577 | 16b holds `ACCESS EXCLUSIVE` on jobs, companies, job_descriptions and saved_jobs; all traffic queues |
| 7,280 | Last sample with the locks held (**held about 5.7 s**) |
| 7,298 | 16b commits (6,790 ms total). Traffic resumes: worst write 6,812 ms, worst read 6,783 ms, no errors |

**d. Second apply.** A no-op in 136 ms, but it still takes `ACCESS EXCLUSIVE` on all four tables.

**Lock-order probes.** A writer holds `jobs` (INSERT) and then FK-checks `companies`, or holds `saved_jobs`
(UPDATE) and then reads `jobs`. In both cases the writer committed first and 16b followed 1.2–1.4 s later. The
original 16b got `deadlock detected` in both. These are the only writer orders proven; others are not claimed.

**Rollback** (documented scripts, real PostgreSQL). Disable took 82 ms (reconstructed baseline) and 72 ms (full-D
baseline). Provenance recorded 11 created relations, 33 added columns on pre-existing tables and 2 prior grant/RLS
states. Every rollback check passed (see `checks` with scenario `R:*`).

## Reproduce

```sh
npm ci
npm install --no-save pg@8                       # client only; package.json is not changed
PG_BIN=<dir with initdb, pg_ctl, postgres> npm run test:10m-postgres -- --json=<out.json>
npm run test:10m-rehearsal -- --json=<out.json>
```

Timings depend on hardware and say nothing about a 10M-row production table.
