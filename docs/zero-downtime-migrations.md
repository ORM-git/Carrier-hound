# Zero-Downtime Migrations (Expand/Contract Discipline)

Every schema change must be safe to apply while the previous deploy is
still serving traffic, and safe for the next deploy to rely on. The rule
is **expand first, contract later, never both in one step**.

## Expand

- New tables, columns, indexes, policies, and functions are added
  additively. New columns are nullable or carry a default so existing
  rows and in-flight code keep working.
- Precedent: `20261106b_early_access_attribution.sql` adds seven
  nullable attribution columns; the API tolerates the columns being
  absent until the owner applies the migration.

## Constraints without a table scan

- Add a constraint as `NOT VALID` (no `ACCESS EXCLUSIVE` scan of existing
  rows), then `VALIDATE CONSTRAINT` in a follow-up step once the table is
  quiet. Precedent: `20261106o_not_valid_validate_pattern.sql`, which
  documents the two phases in its header.

## Indexes without blocking writes

- The NOT APPLIED `20261106n_covering_index_jobs_list.sql` now uses a
  standalone `CREATE INDEX CONCURRENTLY`. Its rollback also uses CONCURRENTLY.
  Follow `docs/concurrent-covering-index.md`: autocommit only, no transaction
  wrapper, inspect validity and actual definition before recording success.
- CONCURRENTLY avoids write-blocking during the build, not all locking or
  waiting. A failed build can leave an invalid index that IF NOT EXISTS skips.
- Other migrations are not claimed concurrent: `20261106m_reindex_maintenance.sql`
  runs plain REINDEX inside a function (CONCURRENTLY is not allowed there), and
  `20261106g_drop_redundant_subscriptions_index.sql` uses plain DROP INDEX.
  They remain lock-risk exceptions requiring separate review. This change does
  not prove a live zero-downtime rollout or retrofit every index migration.

## Contract

- Removing or renaming anything a deploy might still read (column,
  table, enum value, function signature) is a **separate, later
  migration**, applied only after the code that reads the old shape has
  been fully deployed and observed. The destructive step ships on its
  own so it can be reasoned about and rolled back in isolation.
- `scripts/test-migration-discipline.ts` enforces this: no migration may
  contain executable `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`,
  `RENAME COLUMN`, or `SET DATA TYPE` outside comments. If a contract
  step is ever genuinely needed, it is a deliberate, reviewable change
  to that suite - not something that slips through.
- `DROP INDEX` (rebuildable, holds no data) and replace-in-place
  `DROP POLICY` / `DROP FUNCTION` / `DROP TRIGGER` followed by their
  `CREATE` remain allowed; they are idempotent replacement patterns, not
  data-destroying contracts.
- `DELETE FROM` appears only inside bounded maintenance functions
  (retention purge, job archival), never as a migration statement that
  rewrites user data at apply time.

## Apply and record

1. Owner reviews the migration-specific execution mode before applying. The
   concurrent index migration must run alone in an autocommit-capable session,
   never in a transactional batch. Other migrations retain their own guidance.
2. Owner records it: `node scripts/record-migration.cjs <name>`.
3. Every migration keeps a commented ROLLBACK section (enforced by
   `scripts/test-migration-rollback-policy.ts`); general recovery notes
   live in `supabase/scripts/rollback-notes.md`.
