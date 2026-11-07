# Outbox / SKIP LOCKED work queue (Database rows: SKIP LOCKED work queue, Queue / outbox table)

Status: migration file and typed helper only. Migration NOT APPLIED. Nothing enqueues,
claims or consumes anything; no caller is wired.

## Pieces

- `supabase/migrations/20261107c_outbox_queue.sql` (NOT APPLIED): table `public.outbox`
  (pending, processing, done, dead) and four service_role-only functions: `outbox_enqueue`,
  `outbox_claim_batch` (FOR UPDATE SKIP LOCKED, lease-based), `outbox_ack`, `outbox_fail`.
  Record with `node scripts/record-migration.cjs 20261107c_outbox_queue` after applying.
  Rollback block is at the bottom of the file.
- `src/lib/queue/outbox.ts`: typed wrappers (`enqueueOutbox`, `claimOutboxBatch`,
  `ackOutbox`, `failOutbox`).
- `scripts/test-outbox-queue.ts`: offline test (suite-runner), including checks of the helper
  against the real DDL.

## Semantics

- At-least-once. Consumers must be idempotent; `dedupe_key` makes producers idempotent.
- A claim is a lease. If a worker dies, the row is claimable again after `locked_until`.
  Each claim increments `attempts`. A row whose lease expires with no attempts left is
  parked as `dead` on the next claim.
- `outbox_fail` returns `retry` (back to pending after the delay), `dead` (attempts used), or
  NULL (row not leased to that worker).
- No numbers are baked in. `max_attempts`, lease seconds, retry delay and batch size are
  required arguments (owner to confirm values per topic).

## Not done (owner steps and unknowns)

- Applying the migration and recording it. Live SQL behavior (locking under parallel
  workers, lease expiry, `RETURN QUERY` over `UPDATE ... RETURNING`) is unproven until applied
  and exercised.
- No producer or consumer exists. `failed_events` (20261105a) stays the dead-letter table for
  email, digest and webhook retries; moving any of them onto this queue is separate work.
- No retention or purge for `done` and `dead` rows is defined (a retention period is an owner
  decision).
