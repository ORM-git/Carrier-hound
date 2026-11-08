# Concurrency, Locking & Backpressure Posture

Backend sheet ranks 45 (Pessimistic Locking), 46 (Distributed Locks),
48 (Thread Safety) and 49 (Backpressure). This is an audit of what the
code does today plus the guard that keeps a later refactor from silently
dropping it (`scripts/test-concurrency-posture.ts`, registered in the CI
suite). The ATS request-start throttle additionally has behavioral concurrency
tests in `src/lib/__tests__/domainThrottle.test.ts`.

## 45 - Pessimistic Locking

Row-level `for update` locks guard every cross-request token/quota
mutation, so concurrent requests serialize on the row instead of
double-spending:

- `ai_global_budget_reserve` (migration `20261104a_global_ai_budget.sql`)
  upserts the daily budget row, then `select ... for update` locks it
  exclusively before evaluating the cap and incrementing
  `reserved_tokens`. Two concurrent reserves cannot both pass the cap.
- `consume_addon_set` (migration `20261103d_consume_atomic_fn.sql`)
  selects the earliest-expiring credit row `for update` before
  decrementing `sets_remaining`; the `sets_remaining > 0` predicate and
  the decrement happen inside the same locked transaction.

Scope: these are single-row pessimistic locks on the quota/budget paths.
There is no application-level locking of job or profile rows; those
tables are written by single-owner flows (ingestion, the owning user).

## 46 - Distributed Locks

`ai_concurrency_leases` (migration `20261104a_global_ai_budget.sql`) is a
DB-backed lease: `ai_concurrency_acquire(lease_id, cap, ttl)` takes an
`exclusive` table lock, purges expired rows, counts active leases and
inserts only under the cap; `ai_concurrency_release(lease_id)` deletes.
RLS is enabled with all access revoked from `public`, `anon` and
`authenticated`; execute is granted to `service_role` only, so the lease
store is unreachable from client keys.

Scope: this is a concurrency lease (a counting semaphore with TTL), not
a general-purpose distributed lock primitive. It covers AI request
concurrency only; nothing else in the app needs cross-instance mutual
exclusion today.

## 48 - Thread Safety

Single-threaded JavaScript does not prevent async interleaving. Shared mutable
caches, circuit state and fallback maps exist, so absence of a Mutex is not a
proof that all requests are race-safe. AI quota/budget mutations use the atomic
Postgres RPCs above. The shared rate-limit store is authoritative whenever
reachable; its per-isolate fallback is only best-effort while the store is down.

The ATS `scripts/utils/polite-fetch.ts` request-start throttle now serializes
concurrent calls through a per-registrable-domain FIFO tail. Previously callers
could read the same timestamp, wait together and burst together. Each queued
caller now observes the previous actual start before waiting. Separate domains
remain independent; finished queue tails are removed and a failed wait cannot
poison later turns. Offline fake-clock tests exercise simultaneous subdomains,
independent domains, delayed scheduling and queue recovery. This is per-process
pacing, not a distributed lock across separate ingestion workers. Existing
robots checks and HTTP retry policy are unchanged.

## 49 - Backpressure

The global AI concurrency cap is the manual backpressure valve:

- `DEFAULT_AI_GLOBAL_MAX_CONCURRENCY = 25`
  (`src/lib/ai/serviceHandler.ts`), overridable via the
  `AI_GLOBAL_MAX_CONCURRENCY` env var.
- When the lease store reports saturation the caller gets `429`
  (`AI_CONCURRENCY_CAP_REACHED`) with `Retry-After: 30`, after
  `settleBudget(0)` and `rollbackAllQuotas()` release the reservation,
  and a `concurrency_saturated` budget alert fires.
- When the lease store itself errors, the request fails closed with
  `503` (`AI_CONCURRENCY_SERVICE_UNAVAILABLE`) + `Retry-After: 30` after `settleBudget(0)` and
  `rollbackAllQuotas()` release the reservation, and a `store_error`
  alert fires. Capacity failures never consume quota.

Scope: this caps concurrent AI work only. There is no queue-level
backpressure (no work queue exists), and non-AI routes rely on the
shared rate limiter rather than a concurrency cap.

## Honest limits

- Static assertions verify the code keeps these mechanisms; they are not
  proof of behavior under live concurrent load.
- The 25-lease default is a chosen default, not an owner-tuned value.
- TTL-based lease expiry means a crashed worker's lease frees itself;
  a long-running request past its TTL can exceed the cap transiently.
