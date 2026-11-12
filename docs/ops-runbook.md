# CareerMonke Operational Runbook (Handoff & Ops)

This document provides operational instructions for deploying, rolling back, monitoring, maintaining, and triaging CareerMonke in production. Every operational procedure is verified against repository scripts and configurations.

Offline guard to verify all referenced files and scripts exist:
```bash
node scripts/check-ops-runbook.cjs
```

---

## 1. Deploy Architecture & Procedures

### Dual-Build Architecture
CareerMonke employs a dual-build deployment architecture across two cloud hosting providers:

| Environment | Role | Build Command | Output | Entrypoint Configuration |
| --- | --- | --- | --- | --- |
| **Cloudflare Pages** (`carrier-hound.pages.dev`) | **Primary** production host | `npm run build` with `CF_PAGES=1` | `.vercel/output/functions` (Edge Server Handlers) | [next.config.mjs](next.config.mjs) (omits `output: "export"`) |
| **Netlify** (`careermonke12.netlify.app`) | **Backup** production host | `npm run build` | `out/` (Static HTML/JS export) + `netlify/functions/` (Serverless functions) | [netlify.toml](netlify.toml) (`publish = "out"`, `functions = "netlify/functions"`) |

- **Cloudflare Pages Build Selection**:
  In [next.config.mjs](next.config.mjs), when `CF_PAGES="1"`, `NEXT_ON_PAGES="1"`, or `VERCEL="1"` is set in the environment, Next.js builds Edge API route handlers for Cloudflare Pages.
- **Netlify Build Selection**:
  When building without `CF_PAGES="1"` (the default in Netlify and local environments), Next.js outputs a static site to `out/`. API requests are routed to standalone Node.js serverless functions in `netlify/functions/` via HTTP rewrite redirects defined in [netlify.toml](netlify.toml).
- **Static Assets and Headers**:
  Static cache-control, CSP, and security response headers are declared in [public/_headers](public/_headers).

### Required Green CI Gates
Before any pull request or merge commit reaches production, all checks in [.github/workflows/ci.yml](.github/workflows/ci.yml) must pass:
1. **Error Budget Policy**: `scripts/test-error-budget-policy.ts`
2. **Type Check**: `npm run type-check` (`tsc --noEmit`)
3. **Log Retention Doc Check**: `scripts/test-log-retention-doc.ts`
4. **Linter**: `npm run lint` (`scripts/run-lint.cjs`)
5. **Account Deletion & Anonymization Checks**: `scripts/test-account-deletion-anonymize.ts`
6. **Application Build**: `npm run build` (Next.js production build)
7. **Tail Latency Gate Check**: `scripts/test-tail-latency-gate.ts` (with `CF_PAGES="1"`)
8. **Sourcemap Leak Guard**: `scripts/test-public-sourcemaps.mjs` and `scripts/check-public-sourcemaps.mjs`
9. **Bundle Size Budget**: `npm run check:budget` (`scripts/check-bundle-budget.mjs`)
10. **Sub-processor Inventory**: `scripts/test-subprocessor-inventory.ts`
11. **Unit & Offline Integration Test Suite**: `npm run test:all` (`scripts/suite-runner.ts`)
12. **Coverage Thresholds**: `npx vitest run --coverage`
13. **API Versioning Policy**: `scripts/test-api-versioning-policy.ts`
14. **Release Versioning Policy**: `scripts/test-release-versioning-policy.ts`
15. **Schema Dump Freshness Check**: `scripts/check-schema-dump-freshness.ts`
16. **Config Drift Integrity**: `scripts/check-config-drift.ts` (asserts all 13 deployment and workflow files match `scripts/config-drift-baseline.json`)

### Identifying the Deployed Commit
- **Cloudflare Pages**: In the Cloudflare Dashboard (**Workers & Pages** > **carrier-hound** > **Deployments**), each deployment lists the Git commit SHA, branch, and trigger timestamp from GitHub webhooks.
- **Netlify**: In the Netlify Dashboard (**Sites** > **careermonke12** > **Deploys**), every production and preview deploy displays the Git commit SHA, author, and commit message.
- **Git Tags & Releases**: Per [docs/release-versioning.md](release-versioning.md), production releases are tagged with annotated Git tags `vX.Y.Z` pointing to the exact merge commit on `main`.

---

## 2. Rollback Procedures

### Platform Web Deploy Rollback

#### 1. Cloudflare Pages Instant Rollback (Primary Host)
1. Navigate to Cloudflare Dashboard > **Workers & Pages** > **carrier-hound** > **Deployments**.
2. Locate the previous known green deployment in the history list.
3. Click the deployment details and select **Rollback to this deployment**.
4. Cloudflare immediately flips global edge routing to the previous worker bundle without requiring a new build.

#### 2. Netlify Instant Rollback (Backup Host)
1. Navigate to Netlify Dashboard > **Sites** > **careermonke12** > **Deploys**.
2. Identify the last green deploy prior to the incident commit.
3. Open the deploy details, click **Options**, and select **Publish deploy**.
4. Netlify will reroute CDN edge traffic to the previous static export within 30 seconds (see [docs/dr-runbook.md](dr-runbook.md)).
5. *CLI Alternative*:
   ```bash
   git checkout <last-known-good-commit>
   npm ci
   npm run build
   npx netlify deploy --prod --dir=out
   ```

### Database & Migration Rollback Pointer
- **Schema & Index Rollbacks**: Detailed operational rollback steps for database schema additions, backfills, and index builds are documented in [supabase/scripts/rollback-notes.md](../supabase/scripts/rollback-notes.md).
- **Expand/Contract Invariant**: Schema changes must follow expand/contract separation per [docs/zero-downtime-migrations.md](zero-downtime-migrations.md). Every SQL migration file in `supabase/migrations/` includes a dedicated `-- ROLLBACK` section verified by `scripts/test-migration-rollback-policy.ts`.
- **Concurrent Indexes**: Any newly created concurrent index can be safely dropped online with zero table locks using `DROP INDEX CONCURRENTLY IF EXISTS <index_name>` per [docs/concurrent-covering-index.md](concurrent-covering-index.md).

---

## 3. Cron & Scheduled Jobs Inventory

CareerMonke runs scheduled automation workflows via GitHub Actions in [.github/workflows/](.github/workflows/):

| Workflow Name | File | Schedule | Script / Command | Purpose |
| --- | --- | --- | --- | --- |
| **Scaled Job Ingestion** | [.github/workflows/ingest.yml](.github/workflows/ingest.yml) | `0 */4 * * *` (Every 4h) | `scripts/ingest.ts` | Ingests ATS job postings across 6 parallel shards; validates company boards and cleans up dead listings (generates ingest-report artifact). |
| **Weekly Retention Purge** | [.github/workflows/retention-cron.yml](.github/workflows/retention-cron.yml) | `30 19 * * 0` (Weekly Sun 19:30 UTC) | `scripts/retention-cron.ts` | Calls `purge_operational_logs()` to prune expired logs, rate limit tables, and soft-deleted records per [docs/retention-policy.md](retention-policy.md). |
| **Daily Candidate Matching** | [.github/workflows/daily-digest-cron.yml](.github/workflows/daily-digest-cron.yml) | `30 21 * * *` (Daily 21:30 UTC) | `scripts/daily-digest-cron.ts` | Scores candidate resumes against active jobs using Groq LLM API and queues daily candidate matching digests. |
| **Daily Early-Access Digest** | [.github/workflows/early-access-digest-cron.yml](.github/workflows/early-access-digest-cron.yml) | `0 18 * * *` (Daily 18:00 UTC) | `scripts/early-access-digest-cron.ts` | Summarizes new subscriber signups and dispatches daily owner email via Google Apps Script mail relay. |
| **Dunning Outbox Dispatch** | [.github/workflows/dunning-dispatch-cron.yml](.github/workflows/dunning-dispatch-cron.yml) | `30 4 * * *` (Daily 04:30 UTC) | `scripts/dunning-dispatch-cron.ts` | Drains the `dunning_logs` outbox and sends renewal payment alert notices for failed subscription renewals. |
| **Capacity Headroom Report** | [.github/workflows/capacity-report-cron.yml](.github/workflows/capacity-report-cron.yml) | `0 5 * * 1` (Weekly Mon 05:00 UTC) | `scripts/report-capacity-headroom.ts` | Audits Supabase storage, row counts, and Groq token usage against documented tier limits per [docs/capacity-headroom.md](capacity-headroom.md). |
| **Read-only DB Health Probe** | [.github/workflows/db-health-probe.yml](.github/workflows/db-health-probe.yml) | `13 2 * * 1` (Weekly Mon 02:13 UTC) | `scripts/probe-db-health.ts` | Runs `db_health_snapshot()` to record index bloat, cache hit ratio, and table statistics per [docs/db-health-probe.md](db-health-probe.md). |
| **DB Reconciliation Audit** | [.github/workflows/db-reconciliation.yml](.github/workflows/db-reconciliation.yml) | `27 3 * * 1` (Weekly Mon 03:27 UTC) | `scripts/run-db-reconciliation.ts` | Executes data integrity audit comparing `jobs` vs `jobs_public`, unallocated credits, and funnel sanity per [docs/payment-reconciliation.md](payment-reconciliation.md). |
| **Source Health Monitoring** | [.github/workflows/source-health-cron.yml](.github/workflows/source-health-cron.yml) | `30 4 * * *` (Daily 04:30 UTC) | `scripts/check-source-health.ts` | Probes upstream ATS endpoints (Greenhouse, Lever, Ashby) to detect dead or rate-limited career boards. |
| **Inbound Reply Poll** | [.github/workflows/inbound-poll-cron.yml](.github/workflows/inbound-poll-cron.yml) | `15 */4 * * *` (Every 4h :15) | `scripts/poll-inbound-replies.ts` | Ingests support/feedback email responses into `public.inbound_replies` per [docs/inbound-replies.md](inbound-replies.md). |
| **Cron Failure Alerter** | [.github/workflows/workflow-failure-alert.yml](.github/workflows/workflow-failure-alert.yml) | Event-driven on `workflow_run` failure | `scripts/workflow-failure-alert.ts` | Captures cron failures, reports them to Sentry, and opens/updates deduplicated GitHub tracking issues. |

### First-Response Steps When a Cron Fails
1. **Locate Logs and Error Details**:
   - The cron failure alerter ([.github/workflows/workflow-failure-alert.yml](.github/workflows/workflow-failure-alert.yml)) automatically logs the event to Sentry and creates or updates a deduplicated issue in GitHub with the run URL and job ID.
   - Open the GitHub Actions run URL and inspect the failed step output.
2. **Diagnose Common Failure Reasons**:
   - `missing_env`: If the log reports missing secrets (see [docs/runbooks.md](runbooks.md)), verify that the required secret names are present in GitHub Repository **Settings** > **Secrets and variables** > **Actions**.
   - `statement_timeout`: If database queries timed out, check the timeout bounds documented in [docs/statement-timeouts.md](statement-timeouts.md) and verify database load via [docs/db-health-probe.md](db-health-probe.md).
   - Upstream API rate limits (e.g. Groq 429 or ATS 403): Groq routes feature circuit breakers and fall back to heuristics automatically; for dead boards, run `scripts/board-verify-all.ts`.
3. **Manual Re-run Procedure**:
   - Trigger the workflow manually via GitHub CLI or Web UI:
     ```bash
     # Re-run failed job ingestion
     gh workflow run ingest.yml -f mode=scheduled -f dry_run=false

     # Re-run daily digest
     gh workflow run daily-digest-cron.yml -f dry_run=false

     # Re-run retention purge
     gh workflow run retention-cron.yml -f dry_run=false
     ```
4. **Blast Radius / Impact**:
   - *Ingestion Failure*: Live job feed becomes stale, but existing jobs remain searchable.
   - *Digest Failure*: Email notifications delayed; no user data is deleted or corrupted.
   - *Retention Failure*: Temporary log accumulation; resolved on next successful cycle.

---

## 4. Database Migrations Procedure

### The NOT APPLIED Header Convention
Every new migration file placed in `supabase/migrations/` must carry a standardized header declaring its pending status and self-referencing record command (enforced by `scripts/list-pending-migrations.cjs` and `scripts/test-migration-discipline.ts`):
```sql
-- Migration: <timestamp>_<name>.sql
-- Status: NOT APPLIED - record-migration.cjs <timestamp>_<name>
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs <timestamp>_<name>
```

### Inspecting Pending Migrations
To review all unapplied migrations and verify their record commands:
```bash
node scripts/list-pending-migrations.cjs
```

### Migration Apply Procedure
1. **Pre-flight Check**:
   - Review the target SQL file in `supabase/migrations/`.
   - Verify zero-downtime rules per [docs/zero-downtime-migrations.md](zero-downtime-migrations.md) (expand first, contract later; no raw table drops or destructive column updates).
   - If adding indexes, ensure `CREATE INDEX CONCURRENTLY` is used in an autocommit-capable session per [docs/concurrent-covering-index.md](concurrent-covering-index.md).
2. **Execute in Supabase SQL Editor**:
   - Log into Supabase Dashboard > **SQL Editor**.
   - Paste and execute the migration SQL.
3. **Record Migration in Database Ledger**:
   - Run `scripts/record-migration.cjs` to register the file name, SHA-256 hash, and execution timestamp into the `public.schema_migrations` table:
     ```bash
     node scripts/record-migration.cjs <migration_file_name_or_id>
     ```
4. **Verify Schema Freshness**:
   - Check that the repo's generated schema snapshot reflects the new state:
     ```bash
     npx tsx scripts/check-schema-dump-freshness.ts
     ```

### Batched Backfill Guidance
Massive table data updates must never be performed inside single monolithic migration transactions. Use the repository's dedicated backfill tools:
- [scripts/backfill-country-code.ts](scripts/backfill-country-code.ts): Backfills country codes with null-only filtering and pre-update CSV snapshot.
- [scripts/backfill-salaries.ts](scripts/backfill-salaries.ts): Backfills parsed salary bounds with rate-limited chunking.
- [scripts/backfill-company-logos.ts](scripts/backfill-company-logos.ts): Enriches company logos with rollback safety.
- [scripts/backfill-job-descriptions.ts](scripts/backfill-job-descriptions.ts): Backfills cleaned job descriptions.

**Backfill Invariants**:
1. **Dry-Run by Default**: Backfill scripts require an explicit `--apply` flag to commit writes.
2. **Null-Only Targeting**: Strictly select `WHERE column IS NULL` to prevent overwriting legitimate ingested values.
3. **Chunked Batches**: Process in small batches (e.g. 50–100 rows per transaction) to prevent connection starvation and lock escalation.
4. **Pre-Update Snapshot**: Generate a local CSV backup prior to executing writes.

---

## 5. Environment Variables & Secrets Reference

All production secrets and environment variables must be managed through hosting provider dashboards and GitHub Secrets (never committed to git). Configuration template: [.env.example](.env.example).

### Cloudflare Pages & Netlify (Production Hosting)

| Variable Name | Scope | Broken Feature When Missing |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend & Edge Functions | Next.js production build crashes in [next.config.mjs](next.config.mjs); all database queries fail; `/api/health/ready` returns 503. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend & Edge Functions | Build crashes in [next.config.mjs](next.config.mjs); public read queries (`jobs_public`) fail. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions & Server API | Server endpoints (`/api/stats`, `/api/jobs/pro`, `/api/jobs/top10`, `/api/track`, `/api/account/delete`) return 500 via `src/lib/api/envCheck.ts`. |
| `UPSTASH_REDIS_REST_URL` | Serverless & Edge | Distributed rate limits and locks unavailable; graceful fallback to in-memory rate limiting via `src/lib/api/sharedRateLimit.ts`. |
| `UPSTASH_REDIS_REST_TOKEN` | Serverless & Edge | Distributed Redis commands fail; in-memory fallback engages. |
| `GROQ_API_KEY` | Edge AI Routes | `/api/ai` completions, resume tailoring, and interview packs fail over to rule-based fallback templates. |
| `NEXT_PUBLIC_BILLING_ENABLED` | Frontend Build | Feature flag in `src/lib/flags/flags.ts`. When `false` or missing, paywall and checkout routes remain deactivated. |
| `RAZORPAY_KEY_ID` | Serverless Billing | Order creation at `/api/billing/razorpay/order` returns 500. |
| `RAZORPAY_KEY_SECRET` | Serverless Billing | Payment signature verification fails; orders cannot be validated. |
| `RAZORPAY_WEBHOOK_SECRET` | Serverless Webhooks | Webhook handler at `/api/billing/razorpay/webhook` returns 500 configuration error; subscription activations stall. |
| `ADMIN_SECRET` | Admin Endpoints | All endpoints under `/api/admin/*` reject callers with 401 Unauthorized. |
| `SENTRY_DSN` | Telemetry & Observability | Errors logged locally to console only; no remote incident telemetry. |
| `ENABLE_SERVER_TRACING` | Edge Observability | Feature flag in `src/lib/flags/flags.ts`. Server spans stay OFF (0 overhead) unless set to `true`. |

### GitHub Actions (CI & Scheduled Cron Workflows)

| Secret / Variable Name | Consumer Workflows | Broken Feature When Missing |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY` | Ingest, Retention, Digests, Reconciliation | Ingestion, cleanup, retention purge, and DB probe jobs fail or skip to dry-run mode. |
| `APPS_SCRIPT_MAIL_URL` & `APPS_SCRIPT_MAIL_SECRET` | Early-Access Digest, Dunning Dispatch | `early-access-digest-cron.ts` and `dunning-dispatch-cron.ts` crash with `missing_env`; notification emails fail to send. |
| `EARLY_ACCESS_NOTIFY_EMAIL` | Early-Access Digest | `early-access-digest-cron.ts` aborts due to missing notification recipient. |
| `GROQ_API_KEY`, `FAST_MODEL`, `SMART_MODEL` | Daily Candidate Matching Digest | AI candidate matching in `daily-digest-cron.ts` fails to generate score rationales. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Inbound Reply Poll | `poll-inbound-replies.ts` aborts without polling support inbox. |
| `GITHUB_TOKEN` | Cron Failure Alerter | Built-in token. `workflow-failure-alert.ts` cannot search or create tracking issues for failed cron runs. |

---

## 6. Incident Triage (First 15 Minutes)

### Scenario A: Site Down / 5xx Spike
- **T + 0m: Probe Edge Availability**
  ```bash
  curl -i https://careermonke.com/api/health
  # Expected: HTTP 200 {"status":"ok"}
  ```
- **T + 2m: Probe Database Readiness**
  ```bash
  curl -i https://careermonke.com/api/health/ready
  # Expected: HTTP 200 {"status":"ready","checks":{"env":"pass","database":"pass"}}
  ```
- **T + 5m: Assess Root Domain**
  - *If `/api/health` returns 502/503/timeout*: Edge routing or deployment failure.
    - Check Cloudflare Pages deployment dashboard.
    - Initiate Netlify instant rollback in Netlify Dashboard (**Options** > **Publish deploy**) per Section 2.
  - *If `/api/health` returns 200 but `/api/health/ready` returns 503*: Database connection or table failure.
    - Open Supabase Dashboard > **Settings** > **Database** to verify project state and pooler health.
    - Check Sentry (`careermonke` project) for database error spikes.
- **T + 10m: Run Smoke Suite**
  ```bash
  npx tsx scripts/smoke-post-deploy.ts
  ```

### Scenario B: Ingest Pipeline Stalled (Zero New Jobs)
- **T + 0m: Review Pipeline Runs**
  - Check [.github/workflows/ingest.yml](.github/workflows/ingest.yml) execution status in GitHub Actions.
  - Check open issues labeled by [scripts/workflow-failure-alert.ts](scripts/workflow-failure-alert.ts).
- **T + 3m: Inspect Ingestion Artifacts**
  - Download `ingest-report-shard-*` artifact from the latest Actions run.
  - Inspect the extracted ingest report JSON and Markdown summary for error codes and per-source counts.
- **T + 7m: Audit ATS Source Health**
  ```bash
  npx tsx scripts/check-source-health.ts
  npx tsx scripts/board-verify-all.ts
  ```
- **T + 12m: Run Test Ingestion in Dry-Run Mode**
  ```bash
  npx tsx scripts/ingest.ts --dry --cap 20
  ```
- **T + 15m: Re-dispatch Ingestion**
  ```bash
  gh workflow run ingest.yml -f mode=scheduled
  ```

### Scenario C: Payment Webhooks Failing (Subscriptions Not Activating)
- **T + 0m: Check Webhook Delivery Status**
  - Open Razorpay Dashboard (`https://dashboard.razorpay.com/app/webhooks`).
  - Inspect failed events sent to `/api/billing/razorpay/webhook` (or `.netlify/functions/billing-razorpay-webhook`).
  - Note HTTP error code:
    - *400 Bad Signature*: Secret mismatch. Verify `RAZORPAY_WEBHOOK_SECRET` in hosting provider environment settings.
    - *500 Internal Error*: Function or database error.
- **T + 5m: Check Sentry & Hosting Logs**
  - Search Sentry for tag `route:/api/billing/razorpay/webhook`.
  - Check `dunning_logs` and `payment_transactions` tables in Supabase for unhandled states.
- **T + 10m: Run Reconciliation Audit**
  ```bash
  npx tsx scripts/run-db-reconciliation.ts
  ```
- **T + 15m: Redeliver Failed Webhooks**
  - In Razorpay Dashboard, select failed webhook events and click **Retry** to reprocess after configuration resolution.

---

*Verified with:* `node scripts/check-ops-runbook.cjs`
