# Job dedupe (Backend sheet rank 98)

Layers, in order:

1. Exact repeats: unique `(source, source_job_id)` and unique `apply_url` on `jobs`.
2. In-run: `scripts/ingest.ts` (Tier 1 ATS vs Tier 2 feed, key company::title::country) and
   `scripts/board-ingest.ts` (`dedupJobs`, key company::title::location).
3. Against the database, board ingest: existing rows are loaded per company and a role that
   already exists under another id is skipped.
4. Against the database, feed ingest (new): `scripts/utils/crossSourceDedupe.ts` drops feed
   jobs whose role is already active in the DB from a verified ATS row. Live runs only, feed
   sources only, fails open (keeps everything) on any query error.
5. Audit and cleanup (migration file, NOT APPLIED): `20261107a_jobs_role_dedupe.sql` adds
   `jobs_role_key`, a partial index, the read-only `jobs_duplicate_roles` view and
   `dedupe_jobs_by_role(p_apply)`; the default is a dry run and it never deletes.

Unproven until the owner applies the migration: the SQL has not been run against Postgres.
The test only checks its text and a JS model of the slug regexes. Run the dry run first and
read the plan before calling it with `true`.

Not covered: the same role under a different spelling of company or title, and roles whose
location differs between boards. Those need fuzzy matching and are out of scope.
