# Autocomplete / prefix search (INTERNAL)

Backend sheet rank 18: "no suggestion endpoint; pg_trgm extension not
enabled in the live DB."

## What exists now

- `GET /api/jobs/suggest?q=<prefix>` - public, read-only. Returns
  `{ "suggestions": string[] }`: up to 10 (chosen default) distinct job
  titles starting with the prefix, newest first. Reads the masked
  `jobs_public` view only - paid fields (company, salary, description,
  apply URL) cannot appear. Query must be 2-40 characters (chosen
  defaults). Rate-limited per IP via the shared store (60 req/min, chosen
  default) with the standard in-memory fallback. 60s public cache.
- `supabase/migrations/20261106k_autocomplete_pg_trgm.sql` - enables
  `pg_trgm` and adds `jobs_title_trgm_idx` (GIN on `public.jobs(title)`).
  NOT APPLIED: owner applies in the Supabase SQL editor, then records it
  with `node scripts/record-migration.cjs 20261106k_autocomplete_pg_trgm`.
  Rollback in the file footer.

## Notes

- The endpoint works without the migration; the index only accelerates
  the prefix match as the jobs table grows, so shipping order is safe.
- No frontend surface calls this endpoint yet - no visible change.
  Wiring it into the search box is a separate UI change (owner decision).
- Titles-only scope is deliberate: company names are a paid field in
  `jobs_public`'s masking model, so they are excluded.

## Owner steps

1. Apply + record migration 20261106k when convenient (no hurry - the
   endpoint is correct, just slower, until then).
2. Decide whether the search box gets autocomplete UI.
