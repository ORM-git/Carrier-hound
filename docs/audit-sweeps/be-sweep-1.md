# Backend Audit Sweep 1 — Partial Row Verdicts on `main`

- **Repository**: `ORM-git/Carrier-hound`
- **Baseline inspected**: `main` (`83ac3133`)
- **Scope**: 21 backend audit rows previously marked `PARTIAL` (excludes `serverless limits`, covered by a separate in-flight PR)
- **Summary counts**: **9 `CLOSE`** · **12 `GAP`** (**21** total)
  - **`CLOSE` (9)**: Retries, Exponential backoff, Pessimistic locking, Distributed locks, Backpressure, Mass assignment, Third-party script risk, Log level discipline, Common crawl usage
  - **`GAP` (12)**: Dead letter queues (`Code + Owner step`), Webhook delivery log & replay (`Code`), Cron failure visibility (`Code + Owner step`), API gateways (`Code + Owner step`), Event-driven architecture (`Code + Owner step`), Saga pattern (`Code`), Session revocation (`Code + Owner step`), Zero-downtime migrations (`Code + Owner step`), Change management (`Owner step`), Big-O hot-path (`Code + Owner step`), Twelve-factor (`Code + Owner step`), Prompt/response logging (`Owner step`)

## Owner Sign-Off Block

| # | Audit Row | Verdict | Classification | Summary |
| --- | --- | --- | --- | --- |
| 1 | Dead letter queues | `GAP` | `Code + Owner step` | DLQ table, replay helpers, admin endpoint, and tests exist; `scripts/email-retry-cron.ts` has no `.github/workflows/*.yml` schedule and DB migrations (`20261105a_failed_events.sql` unmarked; `20261107c_outbox_queue.sql` / `20261107e_outbox_fencing.sql` `NOT APPLIED`) remain unverified live. |
| 2 | Webhook delivery log & replay | `GAP` | `Code` | `webhook_events` stores only post-success/ignored idempotency keys; rejected webhooks (400/404) and payload/header/status history are not logged, `POST /api/admin/replay` replays only `failed_events`, and no Next.js/Cloudflare Razorpay webhook route exists. |
| 3 | Cron failure visibility | `GAP` | `Code + Owner step` | Script crons wire Sentry reporting and check-in heartbeats, but `SCHEDULED_CRON_WORKFLOWS` includes obsolete "Daily Job Ingestion & Cleanup Pipeline" and omits "OSS License Guard", `scripts/email-retry-cron.ts` is unscheduled, and live `SENTRY_DSN` alert activation stays unverified owner state. |
| 4 | API gateways | `GAP` | `Code + Owner step` | Edge middleware and shared rate-limit/body-size/origin helpers exist, but rate limiting is opt-in per route (not gateway-wide) and relies on owner-configured Upstash Redis env vars (`docs/managed-redis.md`) for distributed enforcement. |
| 5 | Retries | `CLOSE` | `—` | `rpcWithRetry`, `polite-fetch.ts`, `fetchWithRetry`, subscription retry waits, and deliberate non-retry refund paths are implemented and locked by registered offline guards + Vitest tests. |
| 6 | Exponential backoff | `CLOSE` | `—` | `withJitter` (`src/lib/reliability/jitter.ts`, ±20%) is locked across 4 backend/scraper/worker sites by `scripts/test-jitter-policy.ts` and `scripts/test-resilience-posture.ts`, while `src/lib/api/retryFetch.ts` independently applies jittered exponential backoff to client API retries. |
| 7 | Event-driven architecture | `GAP` | `Code + Owner step` | Outbox DDL and library (`src/lib/queue/outbox.ts`) exist, but `docs/outbox-queue.md` marks `20261107c` / `20261107e` `NOT APPLIED`, no producer or consumer is wired, and no `done`/`dead` purge policy exists. |
| 8 | Saga pattern | `GAP` | `Code` | Local single-request try/catch compensations (`rollbackAllQuotas`, `settleBudget(0)`, `refundSet`) exist, but there is no durable saga coordinator/state machine or compensating-action log across multi-step/async flows. |
| 9 | Pessimistic locking | `CLOSE` | `—` | Row-level `FOR UPDATE` locks in `20261104a_global_ai_budget.sql` and `20261103d_consume_atomic_fn.sql` are documented (`docs/concurrency-posture.md`) and locked by `scripts/test-concurrency-posture.ts`. |
| 10 | Distributed locks | `CLOSE` | `—` | Lease-based PostgreSQL semaphore (`ai_concurrency_leases`, `ai_concurrency_acquire`, `ai_concurrency_release`) with `LOCK TABLE ... IN EXCLUSIVE MODE` is documented for AI concurrency and locked by `scripts/test-concurrency-posture.ts`. |
| 11 | Backpressure | `CLOSE` | `—` | Bounded AI concurrency (`DEFAULT_AI_GLOBAL_MAX_CONCURRENCY = 25`), `429`/`503` + `Retry-After: 30` fail-closed responses, quota/budget rollback, and public rate limits are verified by registered tests. |
| 12 | Mass assignment | `CLOSE` | `—` | `pickAllowed` (`SERVER_OWNED_FIELDS`, `PROTOTYPE_KEYS`), API route spread guards, and `scripts/test-mass-assignment-variable-writes.ts` lock variable-arg Supabase writes; Netlify writes use explicit field objects. |
| 13 | Third-party script risk | `CLOSE` | `—` | SRI-pinned `pdf.min.js`, pinned `pdf.worker.min.js`, documented Razorpay checkout CSP exception, and `public/_headers` / `netlify.toml` sync checks are guarded by `scripts/check-config-drift.ts` and Vitest. |
| 14 | Session revocation | `GAP` | `Code + Owner step` | `signOutUser()` (`src/lib/auth/session.ts`) calls `supabase.auth.signOut()` which defaults to global scope (`@supabase/auth-js`) revoking refresh sessions, but admin/global signout (`POST /api/account/signout-all`) has no UI wiring, `scripts/test-banned-user-enforcement.ts` is unregistered in `suite-runner.ts`, and stateless access JWTs remain valid until expiry. |
| 15 | Zero-downtime migrations | `GAP` | `Code + Owner step` | Offline policy guards cover migration discipline, but migrations `20261106k_autocomplete_pg_trgm.sql` and `20261107a_jobs_role_dedupe.sql` create non-concurrent indexes (`jobs_title_trgm_idx` and `jobs_role_key_active_idx`), two lock-risk exceptions remain documented, and 34 pending migrations without `APPLIED` markers remain unverified live. |
| 16 | Change management | `GAP` | `Owner step` | Hotfix, release versioning, handoff, and incident docs are guarded offline, but the first-release checklist (`v1.0.0` tag / GitHub Release) is uncompleted and all 6 handoff backup access checks are marked `Not verified`. |
| 17 | Big-O hot-path | `GAP` | `Code + Owner step` | `docs/hot-path-complexity-review.md` covers 3 `src/lib/jobs/service.ts` functions and explicitly keeps the row `PARTIAL`; no registered guard exists, AI/cron/admin routes remain unreviewed, and live `EXPLAIN (ANALYZE)` stays pending. |
| 18 | Twelve-factor | `GAP` | `Code + Owner step` | `docs/twelve-factor.md` explicitly keeps the row `PARTIAL` (Factors V, VI, VIII, X, XI, XII `Partial`; IX `Unproven`) with 3 open owner steps for pipeline documentation, local parity, and log draining. |
| 19 | Log level discipline | `CLOSE` | `—` | Structured logger (`LOG_LEVEL` filtering + redaction), `routeBudget` instrumentation, registered `scripts/test-structured-logger.ts`, and 5 Vitest adoption/envelope suites enforce log discipline. |
| 20 | Prompt/response logging | `GAP` | `Owner step` | `docs/ai-prompt-and-provider-notes.md` keeps storage/logging `PARTIAL` and retains owner step #3 to verify vendor-side Groq prompt-retention dashboard settings and decide on telemetry scope. |
| 21 | Common crawl usage | `CLOSE` | `—` | URL-discovery scrapes `collinfo.json` for latest index with `CC-MAIN-2026-43` fallback and enforces ATS-only filters and rate limits; offline test suites mock network calls and verify capability only (proving neither live accessibility nor compliance). |

---

## 1. Dead letter queues

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Migration & helpers: `supabase/migrations/20261105a_failed_events.sql` defines `public.failed_events`; `src/lib/events/failedEvents.ts` implements `recordFailedEvent`, `replayFailedEvents`, `replayFailedEmailEvents`, and `scrubSensitiveData`.
  - Replay endpoints & scripts: `src/app/api/admin/replay/route.ts` exposes admin GET/POST inspection and replay; `scripts/email-retry-cron.ts` provides a CLI replay entrypoint.
  - Registered tests: `scripts/test-failed-events-dead-letter.ts` and `scripts/test-poison-message-handling.ts` are both registered in `scripts/suite-runner.ts`.
  - Related outbox DLQ scaffold: `docs/outbox-queue.md`, `supabase/migrations/20261107c_outbox_queue.sql`, and `supabase/migrations/20261107e_outbox_fencing.sql` (tested by `scripts/test-outbox-queue.ts`).
- **Remaining Gap**:
  - **Code**: `scripts/email-retry-cron.ts` is not scheduled by any workflow under `.github/workflows/`, so failed-event replay does not run automatically unattended. In addition, the newer `outbox` dead-letter queue (`public.outbox`) has no wired producer/consumer and no `done`/`dead` purge job (`docs/outbox-queue.md`).
  - **Owner step**: `supabase/migrations/20261105a_failed_events.sql` has no applied marker in `scripts/list-pending-migrations.cjs`, and `20261107c_outbox_queue.sql` / `20261107e_outbox_fencing.sql` are explicitly `NOT APPLIED` in `docs/outbox-queue.md` (unverified live).

## 2. Webhook delivery log & replay

- **Verdict**: `GAP`
- **Classification**: `Code`
- **Evidence on `main`**:
  - Table & handler: `supabase/migrations/20261019_webhook_events.sql` creates `public.webhook_events`; `netlify/functions/billing-razorpay-webhook.ts` verifies HMAC-SHA256 signatures, deduplicates via `webhook_events`, calls `fulfil_payment_order`, and sends fulfillment errors to `failed_events` via `recordFailedEvent` (`src/lib/events/failedEvents.ts`).
  - Admin replay & tests: `src/app/api/admin/replay/route.ts`, plus registered `scripts/test-failed-events-dead-letter.ts` and `scripts/test-razorpay-mode-isolation.ts` in `scripts/suite-runner.ts`.
- **Remaining Gap**:
  - **Code**: `public.webhook_events` stores only minimal post-success/ignored idempotency metadata (`event_id`, `provider`, `event_type`, `processed_at`). Rejected webhook requests (`400` missing/invalid signature, `400` invalid JSON, `400` mode mismatch, `404` missing order) and full sanitized delivery request/response history (headers, status codes, payloads) are not persisted. `POST /api/admin/replay` replays only `failed_events` rows rather than arbitrary webhook deliveries, and there is no Next.js/Cloudflare Pages Razorpay webhook handler under `src/app/api/billing/razorpay/` (only `order` and `verify` routes exist).

## 3. Cron failure visibility

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Script-level Sentry & check-ins: `scripts/lib/cron-sentry.ts` (`reportCronFailure`) and `scripts/lib/cron-heartbeat.ts` (`startCronHeartbeat`, `buildCheckInUrl`) are wired into all 5 script crons (`scripts/daily-digest-cron.ts`, `scripts/dunning-dispatch-cron.ts`, `scripts/early-access-digest-cron.ts`, `scripts/email-retry-cron.ts`, `scripts/retention-cron.ts`).
  - Workflow-level alerting: `.github/workflows/workflow-failure-alert.yml` and `scripts/lib/workflow-failure-alert.ts` (`SCHEDULED_CRON_WORKFLOWS`) monitor scheduled workflows with daily deduplicated GitHub issue creation and Sentry error reporting.
  - Registered guards: `scripts/test-cron-failure-visibility.ts`, `scripts/test-cron-heartbeat-monitoring.ts`, and `scripts/test-workflow-failure-alert.ts` are all registered in `scripts/suite-runner.ts`.
- **Remaining Gap**:
  - **Code**: `SCHEDULED_CRON_WORKFLOWS` in `scripts/lib/workflow-failure-alert.ts` includes the obsolete `"Daily Job Ingestion & Cleanup Pipeline"` (replaced by `"Scaled Job Ingestion & Cleanup Pipeline"`) and omits the scheduled `"OSS License Guard"` (`.github/workflows/license-guard.yml`). In addition, `scripts/email-retry-cron.ts` is not scheduled by any workflow under `.github/workflows/`.
  - **Owner step**: Sentry error reporting across workflows and crons requires `SENTRY_DSN` configured in repository/host environment secrets (`sentry.server.config.ts`), which remains an unverified owner step in production.

## 4. API gateways

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Edge/request helpers: `src/middleware.ts`, `src/lib/api/sharedRateLimit.ts`, `src/lib/api/envCheck.ts`, `src/lib/security/bodySize.ts`, `src/lib/security/sameOrigin.ts`, `docs/openapi.yaml`, `docs/managed-redis.md`.
  - Registered guard: `scripts/test-resilience-posture.ts` in `scripts/suite-runner.ts`.
- **Remaining Gap**:
  - **Code**: There is no unified API gateway enforcement layer across all endpoints; rate limiting (`checkSharedRateLimit`), body-size limits, and origin checks are opt-in per route (`scripts/test-resilience-posture.ts` verifies `checkSharedRateLimit` only on `/api/stats`, `/api/ticker`, and `/api/early-access`).
  - **Owner step**: `docs/managed-redis.md` documents that `src/lib/api/sharedRateLimit.ts` falls back to per-instance in-memory state when Upstash Redis environment variables are unset, and platform-level WAF / rate-limiting rules on Cloudflare Pages or Netlify live in host dashboards rather than code.

## 5. Retries

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Code paths: `src/lib/db/rpcRetry.ts` (`rpcWithRetry`, `isDeadlockError`, `DEADLOCK_SQLSTATE`), `scripts/utils/polite-fetch.ts` (`MAX_RETRIES`, `Retry-After` handling), `src/lib/api/retryFetch.ts` (`fetchWithRetry`, wired in `src/lib/api/stats.ts`), `src/lib/billing/subscription.ts`, and deliberate no-retry refund protection in `src/lib/billing/consume.ts` (`refundSet`).
  - Registered guards & unit tests: `scripts/test-rpc-retry.ts`, `scripts/test-polite-fetch-retries.ts`, and `scripts/test-resilience-posture.ts` in `scripts/suite-runner.ts`, plus Vitest suites `src/lib/__tests__/retryFetch.test.ts` and `src/lib/__tests__/politeFetchRetries.test.ts`.

## 6. Exponential backoff

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Policy & implementation: `docs/retry-jitter.md` and `src/lib/reliability/jitter.ts` (`withJitter` with default ±20% jitter).
  - Scope:
    - 4 backend/scraper/worker backoff sites are locked by registered `scripts/test-jitter-policy.ts` and `scripts/test-resilience-posture.ts`: `scripts/utils/polite-fetch.ts` 429 response backoff, `scripts/utils/polite-fetch.ts` network failure backoff, `src/lib/billing/subscription.ts` dual retry waits, and `src/lib/events/failedEvents.ts` replay delay.
    - In addition, client API retry helper `src/lib/api/retryFetch.ts` (`fetchWithRetry`, wired into `src/lib/api/stats.ts`) applies `withJitter` to exponential backoff (`baseDelayMs * backoffMultiplier^attempt`, capped at `maxDelayMs`), verified by `src/lib/__tests__/retryFetch.test.ts` and `src/lib/__tests__/jitter.test.ts`.

## 7. Event-driven architecture

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Outbox schema & worker helpers: `docs/outbox-queue.md`, `supabase/migrations/20261107c_outbox_queue.sql`, `supabase/migrations/20261107e_outbox_fencing.sql`, `src/lib/queue/outbox.ts` (`enqueueOutbox`, `claimOutboxBatch`, `ackOutbox`, `failOutbox`), and registered `scripts/test-outbox-queue.ts` in `scripts/suite-runner.ts`.
  - Webhook fulfillment: `netlify/functions/billing-razorpay-webhook.ts` and `src/app/api/billing/razorpay/verify/route.ts` checked by `scripts/test-resilience-posture.ts`.
- **Remaining Gap**:
  - **Code**: `docs/outbox-queue.md` states *"Nothing enqueues, claims or consumes anything; no caller is wired"* and notes there is no automatic cleanup/retention for `done` or `dead` outbox rows.
  - **Owner step**: Both outbox migrations (`20261107c_outbox_queue.sql` and `20261107e_outbox_fencing.sql`) remain explicitly marked `NOT APPLIED` in `docs/outbox-queue.md`.

## 8. Saga pattern

- **Verdict**: `GAP`
- **Classification**: `Code`
- **Evidence on `main`**:
  - Compensating rollbacks: `src/lib/ai/serviceHandler.ts` (`rollbackAllQuotas`, `settleBudget(0)`) and `src/lib/billing/consume.ts` (`refundSet` + fallback row restoration), verified statically by registered `scripts/test-resilience-posture.ts` in `scripts/suite-runner.ts`.
- **Remaining Gap**:
  - **Code**: Compensations are synchronous single-request `try`/`catch` rollbacks only. There is no durable multi-step saga coordinator, persisted workflow state machine, or durable compensating-action log for cross-service or asynchronous multi-step flows (as `public.outbox` in `src/lib/queue/outbox.ts` is unapplied and unwired).

## 9. Pessimistic locking

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Documentation & migrations: `docs/concurrency-posture.md` (`# 45 - Pessimistic Locking`), `supabase/migrations/20261104a_global_ai_budget.sql` (`SELECT ... FOR UPDATE` on `ai_global_budget_daily`), and `supabase/migrations/20261103d_consume_atomic_fn.sql` (`FOR UPDATE` row lock inside `consume_addon_set`).
  - Registered guard: `scripts/test-concurrency-posture.ts` in `scripts/suite-runner.ts` enforces the scope documented in `docs/concurrency-posture.md` (single-row quota and AI budget mutations).

## 10. Distributed locks

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Documentation & migrations: `docs/concurrency-posture.md` (`# 46 - Distributed Locks`) and `supabase/migrations/20261104a_global_ai_budget.sql` (`ai_concurrency_leases`, `ai_concurrency_acquire`, `ai_concurrency_release` using `LOCK TABLE ... IN EXCLUSIVE MODE`, RLS, and `service_role`-only grants).
  - Registered guard: `scripts/test-concurrency-posture.ts` in `scripts/suite-runner.ts`. `docs/concurrency-posture.md` explicitly scopes distributed locking to cross-instance AI request concurrency (`counting semaphore with TTL`), recording that no other workflow requires cross-instance mutual exclusion today.

## 11. Backpressure

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Documentation & enforcement: `docs/concurrency-posture.md` (`# 49 - Backpressure`) and `src/lib/ai/serviceHandler.ts` (`DEFAULT_AI_GLOBAL_MAX_CONCURRENCY = 25`, `AI_GLOBAL_MAX_CONCURRENCY`, HTTP `429 AI_CONCURRENCY_CAP_REACHED`, fail-closed `503 AI_CONCURRENCY_SERVICE_UNAVAILABLE` with `Retry-After: 30`, plus `settleBudget(0)` and `rollbackAllQuotas()`).
  - Registered guards: `scripts/test-concurrency-posture.ts` and `scripts/test-global-ai-budget.ts` in `scripts/suite-runner.ts`.

## 12. Mass assignment

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Helper & guards: `src/lib/security/pickFields.ts` (`pickAllowed`, `SERVER_OWNED_FIELDS`, `PROTOTYPE_KEYS`), Vitest `src/lib/__tests__/massAssignment.test.ts` (guards API routes against spread body writes), and registered `scripts/test-mass-assignment-variable-writes.ts` in `scripts/suite-runner.ts` (locks every variable-argument `.insert`/`.update`/`.upsert` write in `src/`). Netlify function writes (including `netlify/functions/account-delete.ts`) pass explicit field objects.

## 13. Third-party script risk

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Policy & enforcement: `docs/third-party-scripts.md`, `docs/security/csp.md`, `public/_headers`, `netlify.toml`, and `src/lib/resume/parser.ts` (SRI-verified `pdf.min.js` + version-pinned `pdf.worker.min.js`, plus documented Razorpay `checkout.razorpay.com/v1/checkout.js` CSP exception).
  - Guards: `scripts/check-config-drift.ts` (header/CSP parity across `public/_headers` and `netlify.toml`) and Vitest `src/lib/__tests__/thirdPartyScripts.test.ts`.

## 14. Session revocation

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Global refresh revocation: `signOutUser()` in `src/lib/auth/session.ts` calls `supabase.auth.signOut()`. In the installed `@supabase/auth-js` (`GoTrueClient.ts` line 4069 / `GoTrueClient.js`), `signOut(options = { scope: 'global' })` defaults to `scope: 'global'`, revoking the user's refresh tokens globally across devices in Supabase Auth and purging client storage.
  - Server endpoints & tests: `src/app/api/account/signout-all/route.ts` and `src/lib/account/signoutAllHandler.ts` call `supabaseAdmin.auth.admin.signOut(token, "global")` (rate-limited), tested by Vitest `src/lib/__tests__/signoutAll.test.ts`. Moderation blocking exists in `src/lib/admin/auth.ts` (`verifyUserNotBanned` backed by `blocked_users`) and `scripts/test-banned-user-enforcement.ts`.
- **Remaining Gap**:
  - **Code**: While `signOutUser()` revokes refresh tokens on standard logout, the dedicated global signout endpoint `POST /api/account/signout-all` has no UI wiring in `src/app/settings/page.tsx` or elsewhere in the user interface. In addition, `scripts/test-banned-user-enforcement.ts` is not registered in `scripts/suite-runner.ts`.
  - **Code + Owner step**: Stateless Supabase access JWTs remain valid until their expiration window elapsed unless protected routes perform a real-time server check (`verifyUserNotBanned` / token blacklist), or JWT expiry is tightened in Supabase Auth project configuration.

## 15. Zero-downtime migrations

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Documentation & offline suite guards: `docs/zero-downtime-migrations.md`, `docs/concurrent-covering-index.md`, `scripts/list-pending-migrations.cjs`, plus 7 registered offline tests in `scripts/suite-runner.ts` (`scripts/test-migration-discipline.ts`, `scripts/test-not-valid-validate-policy.ts`, `scripts/test-covering-index-policy.ts`, `scripts/test-migration-rollback-policy.ts`, `scripts/test-schema-dump-freshness.ts`, `scripts/test-pending-apply-markers-policy.ts`, `scripts/test-migration-raise-placeholders.ts`).
- **Remaining Gap**:
  - **Code**: Beyond the two documented lock-risk exceptions (`supabase/migrations/20261106m_reindex_maintenance.sql` and `supabase/migrations/20261106g_drop_redundant_subscriptions_index.sql`), two other migrations create non-concurrent indexes without `CONCURRENTLY`: `supabase/migrations/20261106k_autocomplete_pg_trgm.sql` creates `jobs_title_trgm_idx` using `create index if not exists`, and `supabase/migrations/20261107a_jobs_role_dedupe.sql` creates `jobs_role_key_active_idx` using `CREATE INDEX IF NOT EXISTS`.
  - **Owner step**: Migrations are applied manually outside CI/deploy automation. Migrations without an `APPLIED` header (34 marked `NOT APPLIED` / `PENDING APPLICATION` and remaining unmarked out of 72 total per `scripts/list-pending-migrations.cjs`) remain unverified against live production database state until inspected or applied; a missing `APPLIED` header in git is not proof of live state.

## 16. Change management

- **Verdict**: `GAP`
- **Classification**: `Owner step`
- **Evidence on `main`**:
  - Governance docs & CI: `docs/hotfix-process.md`, `docs/release-versioning.md`, `docs/maintainer-handoff.md`, `docs/incident-log.md`, `.github/workflows/ci.yml`, guarded by registered offline checks in `scripts/suite-runner.ts` (`scripts/test-hotfix-process-doc.ts`, `scripts/test-release-versioning-policy.ts`, `scripts/test-maintainer-handoff.ts`, `scripts/test-incident-response-docs.ts`).
- **Remaining Gap**:
  - **Owner step**: `docs/release-versioning.md` leaves the pre-launch first-release checklist (`v1.0.0` git tag and GitHub Release) uncompleted, `docs/maintainer-handoff.md` marks all 6 production access-backup capabilities `Not verified`, and Cloudflare/Netlify deployment pipelines plus database migration execution are manual/dashboard-driven rather than reproducible release workflows (`docs/twelve-factor.md`).

## 17. Big-O hot-path

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Complexity review: `docs/hot-path-complexity-review.md` documents time complexity and candidate-pool bounds for 3 functions in `src/lib/jobs/service.ts` (`getLiveJobs`, `loadAllActiveJobs`, `getTopRankedJobsForCandidate`).
- **Remaining Gap**:
  - **Code**: `docs/hot-path-complexity-review.md` explicitly states *"The row stays PARTIAL: it covers one path, and a full review of every route is not done."* Inner `computeFitDiagnostics` and other AI/cron/admin routes lack documented complexity bounds, and no offline regression guard in `scripts/suite-runner.ts` locks hot-path bounds.
  - **Owner step**: Live `EXPLAIN (ANALYZE)` and `scripts/benchmark-query.ts` validation against production-scale data remains unrun.

## 18. Twelve-factor

- **Verdict**: `GAP`
- **Classification**: `Code + Owner step`
- **Evidence on `main`**:
  - Scorecard & guard: `docs/twelve-factor.md` and registered `scripts/test-twelve-factor-evidence.ts` in `scripts/suite-runner.ts`.
- **Remaining Gap**:
  - **Code + Owner step**: `docs/twelve-factor.md` explicitly notes *"this doc keeps it PARTIAL"*, rating Factors V, VI, VIII, X, XI, XII as `Partial` and IX as `Unproven`, with 3 open owner steps (confirm ratings, document the real Cloudflare/Netlify deploy pipeline, and decide on local stack parity & centralized log draining).

## 19. Log level discipline

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Structured logger & routing telemetry: `docs/structured-logging.md`, `src/lib/observability/logger.ts` (`LOG_LEVEL` filtering `debug`/`info`/`warn`/`error`/`silent` defaulting to `info`, secret redaction, reserved keys), and `src/lib/api/routeBudget.ts`.
  - Registered guard & unit tests: `scripts/test-structured-logger.ts` in `scripts/suite-runner.ts`, plus Vitest suites `src/lib/__tests__/structuredLoggingLibAdoption.test.ts`, `src/lib/__tests__/structuredLoggingAdoption.test.ts`, `src/lib/__tests__/loggerEnvelope.test.ts`, `src/lib/__tests__/loggerLevelKeys.test.ts`, and `src/lib/__tests__/routeBudgetLogging.test.ts`.

## 20. Prompt/response logging

- **Verdict**: `GAP`
- **Classification**: `Owner step`
- **Evidence on `main`**:
  - Documentation & behavior: `docs/ai-prompt-and-provider-notes.md`, `docs/data-classification.md`, `docs/log-retention.md`, and `src/lib/ai/serviceHandler.ts` (persists validated `response_payload` in `plan_usage_events` for idempotent replay while runtime logs exclude prompt text).
- **Remaining Gap**:
  - **Owner step**: `docs/ai-prompt-and-provider-notes.md` explicitly states *"All four rows stay PARTIAL"* (`What is logged and stored`) and retains open owner step #3 to verify the Groq dashboard prompt-retention setting (30-day Groq retention noted in privacy docs) and decide whether any prompt logging or extended response telemetry is required.

## 21. Common crawl usage

- **Verdict**: `CLOSE`
- **Classification**: `—`
- **Evidence on `main`**:
  - Documentation & scraper implementation: `SOURCES.md` (`# 1. Common Crawl Public URL Index`), `scripts/board-discovery.ts` (`discoverFromCommonCrawl` fetches `https://index.commoncrawl.org/collinfo.json` to select the latest index `collinfo[0].id` with `CC-MAIN-2026-43` fallback, using ATS-domain filters only), and `scripts/utils/polite-fetch.ts` (allows `commoncrawl.org` under 1 req/s rate limit + `Retry-After` backoff).
  - Registered guards & scope limitations: `scripts/test-board-discovery.ts` and `scripts/test-ats-adapters.ts` in `scripts/suite-runner.ts`.
  - Scope limitation: CLOSE covers only the repository's URL-discovery capability in code. Both offline test suites mock network requests and prove neither live external accessibility of the Common Crawl index nor legal compliance of fetched outputs.
