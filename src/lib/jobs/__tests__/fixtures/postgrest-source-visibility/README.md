# Real-PostgREST evidence for source visibility

`sourceVisibility.postgrest.test.ts` replays `recorded.json` in CI. The recordings come from a **local** run:
PostgREST 16.6 (official `postgrest-v16.6-windows-x86-64.zip`, sha256 `77c9e51d…f115ea`) in front of
PostgreSQL 17.12 (`@embedded-postgres/windows-x64@17.12.0-beta.19`), both on 127.0.0.1. No production database.

Re-record after changing any filter the test drives:

1. Start Postgres on 127.0.0.1:54329 (trust auth) and load `schema.sql` as `postgres`.
2. `postgrest postgrest.conf` (listens on 127.0.0.1:54330; the JWT secret is local-only).
3. `POSTGREST_URL=http://127.0.0.1:54330 RECORD=1 npx vitest run src/lib/jobs/__tests__/sourceVisibility.postgrest.test.ts`
4. Run it again without `RECORD` (live) and without `POSTGREST_URL` (replay): both must pass.

## Provenance of the current recording (work-model label consistency)

`recorded.json` was re-recorded against a real local stack, not edited by hand:

- PostgREST 16.6 (static linux x86_64 build) in front of PostgreSQL 17.12 (embedded-postgres), both on 127.0.0.1.
  Production was not contacted. Schema is `schema.sql` in this directory, loaded into a fresh cluster.
- Sequence: RECORD=1 run, then a LIVE run (requests go to the local PostgREST and are compared), then a REPLAY run
  (no server). 8/8 tests passed in each mode. A second RECORD produced no diff.
- REPLAY proves only that the routes still send the recorded requests and handle the recorded responses. It is not a
  new live run. This recording is local PostgREST semantics, not a production claim.
