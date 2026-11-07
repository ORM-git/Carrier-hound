# Optimistic locking with row_version (Database row: Optimistic Locking)

Status: migration file and helper only. Migration NOT APPLIED. Nothing calls the helper.

## Pieces

- `supabase/migrations/20261107d_row_version_optimistic_lock.sql` (NOT APPLIED): adds
  `row_version INTEGER NOT NULL DEFAULT 1` and a BEFORE UPDATE trigger (`bump_row_version()`)
  to `user_preferences`, `resumes`, `applications`, `candidate_profiles`. Record with
  `node scripts/record-migration.cjs 20261107d_row_version_optimistic_lock`. Rollback block
  at the bottom.
- `src/lib/db/optimisticLock.ts`: `updateWithVersion(supabase, table, key, expectedVersion, patch)`.
- `scripts/test-row-version-lock.ts`: offline test (suite-runner).

The table list is owner to confirm. It is user-edited, non-billing only; payments,
subscriptions and entitlements are deliberately excluded.

## Write-semantics change, exactly

| Situation | Today | After the migration is applied |
| --- | --- | --- |
| Existing writer updates a row (no version in the query) | Update succeeds, last write wins | Same. The trigger only increments `row_version`. |
| Caller uses `updateWithVersion` with the version it read | n/a | Query is `UPDATE ... WHERE key = ? AND row_version = ?`. Match: `{status:"ok", row, rowVersion}`. |
| Same caller, but someone wrote first | n/a | Zero rows match: `{status:"stale", currentVersion}`. The row is not changed; the caller re-reads and merges. |
| Key does not exist | n/a | `{status:"not_found"}` |
| Migration not applied yet | n/a | `{status:"error"}` (column missing); nothing is written |

SQL never rejects a write. Only callers that opt in get conflict detection, so no existing
route changes behavior and no API response body changes.

## Not done (owner steps and unknowns)

- Applying the migration; live trigger behavior is unproven. Adding a NOT NULL column with a
  constant default is metadata-only on current Postgres (owner to confirm the project version).
- No route or client adopts the helper, and clients do not send versions yet. Adoption per
  route is separate work and needs a decision on what the UI does on a stale result.
- Rows written by the change-history trigger on `user_preferences` will include `row_version`.
