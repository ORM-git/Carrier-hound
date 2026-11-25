# Real-PostgREST evidence for source visibility

`sourceVisibility.postgrest.test.ts` replays `recorded.json` in CI. The recordings come from a **local** run:
PostgREST 16.6 (official `postgrest-v16.6-windows-x86-64.zip`, sha256 `77c9e51d…f115ea`) in front of
PostgreSQL 17.12 (`@embedded-postgres/windows-x64@17.12.0-beta.19`), both on 127.0.0.1. No production database.

Re-record after changing any filter the test drives:

1. Start Postgres on 127.0.0.1:54329 (trust auth) and load `schema.sql` as `postgres`.
2. `postgrest postgrest.conf` (listens on 127.0.0.1:54330; the JWT secret is local-only).
3. `POSTGREST_URL=http://127.0.0.1:54330 RECORD=1 npx vitest run src/lib/jobs/__tests__/sourceVisibility.postgrest.test.ts`
4. Run it again without `RECORD` (live) and without `POSTGREST_URL` (replay): both must pass.
