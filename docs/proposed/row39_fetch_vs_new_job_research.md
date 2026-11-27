# Row 39: fetch vs new-job semantics (research note)

Research only. No code, no database reads. Read from `main` @ `71339758`, 27 Nov 2026.
Labels: **from source** = read in this repo at that commit; **unverified** = not checked against data.

## Timestamps on `public.jobs` (`supabase/schema.sql:60-64`)

| Column | Default | Who writes it (from source) | Meaning today |
|---|---|---|---|
| `posted_at` | `now()` | Both pipelines send the source date. A missing date stays null on insert and is omitted on update (`scripts/ingest.ts` `updateExistingJobs`; Python #761). | Employer's posting date |
| `first_seen_at` | `now()` | **Nobody.** Neither pipeline sends it (no writer in `scripts/ingest.ts` or `scripts/scraper/*.py`). `src/lib/jobs/service.ts:59` documents it as "DB default now() on insert, never written by ingestion". | When CareerMonke first stored *this row* |
| `discovered_at` | `now()` | TS sends `j.discovered_at \|\| now()` in every payload (`scripts/ingest.ts:760`). `updateExistingJobs` spreads that payload into the UPDATE, so it is **overwritten on every update**. Python does not send it (not in `engine.py` `db_columns`). | TS rows: last write time, not first discovery. Python rows: insert time. |
| `last_seen_at` | `now()` | Both pipelines on every fetch that sees the job | Last fetch that saw it |

## What "new job" means, from source

- A "new job" is a **new row**. `first_seen_at` is fixed at insert, so a job is new when its identity (source /
  `source_id`, `source_job_id`; see `scripts/utils/canonicalJobWrite.ts`, `engine.py` `partition_set_diff`) was not
  already stored.
- A **fetch** that sees an existing job only refreshes `last_seen_at` (and changed content). It never makes the job new again.
- **from source**: a repost under a new `source_job_id` is a new row, and therefore a "new job", with a fresh
  `first_seen_at`. Nothing links it to the old row. That links to row 35 (repost history).
- **from source**: `discovered_at` on TS rows cannot be used as "first discovered", because updates overwrite it.
- **unverified**: which readers, if any, rely on `discovered_at`. `src/lib/jobs/service.ts` reads `first_seen_at`.

## Questions for the owner

1. Should TS stop sending `discovered_at` on updates (make it insert-only like `first_seen_at`)? That is a small writer
   change in `scripts/ingest.ts`, but it changes stored values, so it's the owner's call.
2. Should reposts be linked (same employer + normalized title + location within N days)? That is row 35's design.
