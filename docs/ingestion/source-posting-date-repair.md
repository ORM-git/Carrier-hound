# TS source posting dates, bounded repair

Missing, blank or unparseable source posting dates stay null. Numeric epoch 0 remains a real date. The TS payload sends explicit null so a database default cannot invent a posting date. Five adapters that bypassed the shared parser now use it: BambooHR, Join, Lever, RemoteOK and Arbeitnow. Existing callers of normalizeDate receive null instead of ingestion time for missing/invalid input. NormalizedJob.posted_at now documents null.

No first_seen_at, created_at, last_seen_at or discovered_at semantics are changed. No existing rows are repaired, no SQL is applied, and no ingest is dispatched. Existing row updates omit posted_at when the refreshed source date is missing/invalid, preserving a previous known date. New rows explicitly send null. Legacy batches containing an undated row bypass conflict upsert and use the existing identity-lookup insert/update path, because a single conflict upsert cannot express those two date semantics. Fully dated legacy batches retain their bulk upsert path. Offset-qualified dates and date-only dates retain existing parsing. Timezone-naive timestamps remain runner-zone dependent; this repair does not invent a source timezone. Adapters using source updated_at still report that supplied timestamp; this does not establish original employer publication time.

The registered offline script executes real adapter entry points with all HTTP intercepted and real updateExistingJobs over a payload fake. Database defaults/triggers and production first_seen_at preservation are NOT proven by the fake; the existing catalog/trigger gate from PR793 remains open. CM arrival-age UI must use separately verified arrival semantics, not this posting date.

Run: npx tsx scripts/test-first-seen-provenance.ts

The audit script from PR793 is included so it runs on current main and is registered in test:all. The original three red regressions are now green, with parser edge cases, five adapter missing/invalid/valid fixtures and undated repeat-update payload checks added.

The legacy CLI fixture runs the real ingest.ts main in a child process with all HTTP intercepted before module loading, using only dummy credentials and a temporary source config. It checks mixed new/existing undated jobs, an invalid-date repeat, fully dated bulk upserts, single-row insert fallback and failed-lookup refusal. It models REST payloads, not PostgreSQL triggers or constraints. A unique legacy (source, source_job_id) constraint is still required to prevent concurrent duplicate inserts; no live schema claim is made. The fixture does not dispatch ingestion or access a real database.

Run: npx tsx scripts/test-source-date-legacy-cli.ts
