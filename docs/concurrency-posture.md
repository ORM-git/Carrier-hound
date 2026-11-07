# Concurrency, Locking & Backpressure Posture

Backend sheet ranks 45 (Pessimistic Locking), 46 (Distributed Locks),
48 (Thread Safety) and 49 (Backpressure). This is an audit of what the
code does today plus the guard that keeps a later refactor from silently
dropping it (`scripts/test-concurrency-posture.ts`, registered in the CI
suite). It introduces no new capability and changes no runtime behavior.

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

The deployment targets single-threaded isolates (Cloudflare Workers /
edge runtime; Netlify Node functions are single-request-per-event), so
there is no in-process shared mutable state to race on. All state shared
across requests lives in Postgres and is mutated through the atomic RPCs
above (`for update` locks, single-statement guarded updates with
predicates like `sets_remaining > 0`), never read-modify-write in
application code. The in-memory rate-limit fallback store is per-isolate
best-effort and fails open to the shared store (see
`src/lib/api/sharedRateLimit.ts`); it is correctness-uncritical because
the shared store is authoritative when reachable.

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
