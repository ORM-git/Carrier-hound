# CareerMonke Operational Runbook (Handoff & Ops)

This document provides operational instructions for deploying, rolling back, monitoring, maintaining, and triaging CareerMonke in production. All referenced repository files, workflows, and maintenance scripts are validated by an offline reference guard.

Offline guard to verify all document-relative links, script references, and file paths exist:
```bash
node scripts/check-ops-runbook.cjs
```

---

## 1. Deploy Architecture & Procedures

### Dual-Build Architecture
CareerMonke employs a dual-build deployment architecture across two cloud hosting providers:

| Environment | Role | Build Command | Output | Entrypoint Configuration |
| --- | --- | --- | --- | --- |
| **Cloudflare Pages** (`carrier-hound.pages.dev`) | **Primary** production host | `npm run build` with `CF_PAGES=1` | `.vercel/output/functions` (Edge Server Handlers) | [next.config.mjs](../next.config.mjs) (omits `output: "export"`) |
| **Netlify** (`careermonke12.netlify.app`) | **Backup** production host | `npm run build` | `out/` (Static HTML/JS export) + `netlify/functions/` (Serverless functions) | [netlify.toml](../netlify.toml) (`publish = "out"`, `functions = "netlify/functions"`) |

- **Cloudflare Pages Build Selection**:
  In [next.config.mjs](../next.config.mjs), when `CF_PAGES="1"`, `NEXT_ON_PAGES="1"`, or `VERCEL="1"` is set in the environment, Next.js builds Edge API route handlers into `.vercel/output/functions` for Cloudflare Pages.
- **Netlify Build Selection**:
  When building without `CF_PAGES="1"` (default in Netlify and local environments), Next.js outputs a static site export to `out/`. API requests are rewritten to standalone Node.js serverless functions in `netlify/functions/` via HTTP redirects defined in [netlify.toml](../netlify.toml).
- **Static Response Headers**:
  Static cache-control, CSP, and security response headers are declared in [public/_headers](../public/_headers).

### Required Green CI Gates
Before any pull request or merge commit reaches production, all checks in [.github/workflows/ci.yml](../.github/workflows/ci.yml) must pass:
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

### Web Deployment Rollback

#### 1. Cloudflare Pages Rollback (Primary Production Host)
Rolling back Netlify does **NOT** restore a failing Cloudflare Pages site. When Cloudflare Pages serves broken traffic or 5xx errors:
1. Log into Cloudflare Dashboard > **Workers & Pages** > **carrier-hound** > **Deployments**.
2. Locate the previous known green deployment in the history list.
3. Click the deployment row, click the three-dots menu or deployment overview, and select **Rollback to this deployment**.
4. Cloudflare switches global edge routing to the previous worker bundle.
5. *Wrangler Alternative* (if authenticated locally):
   ```bash
   npx wrangler pages deployment rollback <deployment-id> --project-name carrier-hound
   ```

#### 2. Netlify Rollback (Backup Host)
When the backup host Netlify serves broken traffic:
1. Navigate to Netlify Dashboard > **Sites** > **careermonke12** > **Deploys**.
2. Identify the last known green deploy prior to the incident commit.
3. Open the deploy details, click **Options**, and select **Publish deploy**.
4. Netlify will point CDN edge routing to the selected static export (see [docs/dr-runbook.md](dr-runbook.md)).
5. *CLI Alternative*:
   ```bash
   git checkout <last-known-good-commit>
   npm ci
   npm run build
   npx netlify deploy --prod --dir=out
   ```

#### 3. Host Failover & DNS Cutover
If Cloudflare Pages suffers a catastrophic infrastructure outage and traffic must be routed to the Netlify backup host:
- Follow [docs/dns-cutover-runbook.md](dns-cutover-runbook.md) to update DNS apex (`A` / `ALIAS`) and `CNAME` records at the domain registrar to point from Cloudflare Pages to Netlify (`careermonke12.netlify.app`).
- Note: This is a manual DNS cutover procedure subject to DNS TTL propagation.

### Database & Migration Rollback Pointer
- **Schema & Index Rollbacks**: Detailed operational rollback procedures for schema additions, backfills, and indexes are documented in [supabase/scripts/rollback-notes.md](../supabase/scripts/rollback-notes.md).
- **Expand/Contract Invariant**: Schema changes must follow expand/contract discipline per [docs/zero-downtime-migrations.md](zero-downtime-migrations.md). Every SQL migration file in `supabase/migrations/` includes a dedicated commented `-- ROLLBACK` block verified by `scripts/test-migration-rollback-policy.ts`.
- **Concurrent Indexes**: Newly created concurrent indexes can be dropped online using `DROP INDEX CONCURRENTLY IF EXISTS <index_name>` per [docs/concurrent-covering-index.md](concurrent-covering-index.md). Note that while `CONCURRENTLY` avoids blocking writes during the build, it takes lock states during initialization and completion, can wait on long-running transactions, and leaves invalid index definitions if interrupted.

---

## 3. Cron & Scheduled Jobs Inventory

CareerMonke runs scheduled automation workflows via GitHub Actions in [.github/workflows/](../.github/workflows/):

| Workflow Name | File | Schedule | Script / Command | Purpose |
| --- | --- | --- | --- | --- |
| **Scaled Job Ingestion** | [.github/workflows/ingest.yml](../.github/workflows/ingest.yml) | `0 */4 * * *` (Every 4h) | `scripts/ingest.ts` | Ingests ATS job postings across 6 parallel shards; validates company boards and cleans up dead listings. |
| **Weekly Retention Purge** | [.github/workflows/retention-cron.yml](../.github/workflows/retention-cron.yml) | `30 19 * * 0` (Weekly Sun 19:30 UTC) | `scripts/retention-cron.ts` | Calls `purge_operational_logs()` to prune operational log tables (`page_views`, `gmail_send_log`, `cron_run_logs`, `admin_audit_log`, `webhook_events`, `failed_events`, `funnel_events`), `archive_expired_jobs()` to move expired listings to `jobs_archive`, and `reindex_bloated_indexes()`. Does not purge accounts. |
| **Daily Candidate Matching** | [.github/workflows/daily-digest-cron.yml](../.github/workflows/daily-digest-cron.yml) | `30 21 * * *` (Daily 21:30 UTC) | `scripts/daily-digest-cron.ts` | Scores candidate resumes against active jobs using deterministic `computeFitDiagnostics` (offline scoring engine) and queues candidate job digest emails. |
| **Daily Early-Access Digest** | [.github/workflows/early-access-digest-cron.yml](../.github/workflows/early-access-digest-cron.yml) | `0 18 * * *` (Daily 18:00 UTC) | `scripts/early-access-digest-cron.ts` | Summarizes new subscriber signups and dispatches daily owner email via Google Apps Script mail relay. |
| **Dunning Outbox Dispatch** | [.github/workflows/dunning-dispatch-cron.yml](../.github/workflows/dunning-dispatch-cron.yml) | `30 4 * * *` (Daily 04:30 UTC) | `scripts/dunning-dispatch-cron.ts` | Drains the `dunning_logs` outbox and dispatches renewal warning notices for failed subscription payments. Exits 0 on missing mail configuration. |
| **Capacity Headroom Report** | [.github/workflows/capacity-report-cron.yml](../.github/workflows/capacity-report-cron.yml) | `0 5 * * 1` (Weekly Mon 05:00 UTC) | `scripts/report-capacity-headroom.ts` | Audits Supabase storage, row counts, and Groq token usage against documented tier limits per [docs/capacity-headroom.md](capacity-headroom.md). |
| **Read-only DB Health Probe** | [.github/workflows/db-health-probe.yml](../.github/workflows/db-health-probe.yml) | `13 2 * * 1` (Weekly Mon 02:13 UTC) | `scripts/probe-db-health.ts` | Runs `db_health_snapshot()` to record index bloat, cache hit ratio, and table statistics per [docs/db-health-probe.md](db-health-probe.md). |
| **DB Reconciliation Audit** | [.github/workflows/db-reconciliation.yml](../.github/workflows/db-reconciliation.yml) | `27 3 * * 1` (Weekly Mon 03:27 UTC) | `scripts/run-db-reconciliation.ts` | Executes data integrity audit comparing `jobs` vs `jobs_public`, unallocated credits, and funnel sanity per [docs/payment-reconciliation.md](payment-reconciliation.md). |
| **Source Health Monitoring** | [.github/workflows/source-health-cron.yml](../.github/workflows/source-health-cron.yml) | `30 4 * * *` (Daily 04:30 UTC) | `scripts/check-source-health.ts` | Probes upstream ATS endpoints (Greenhouse, Lever, Ashby) to detect dead or rate-limited career boards. |
| **Inbound Reply Poll** | [.github/workflows/inbound-poll-cron.yml](../.github/workflows/inbound-poll-cron.yml) | `15 */4 * * *` (Every 4h :15) | `scripts/poll-inbound-replies.ts` | Ingests support/feedback email responses into `public.inbound_replies` per [docs/inbound-replies.md](inbound-replies.md). |
| **Cron Failure Alerter** | [.github/workflows/workflow-failure-alert.yml](../.github/workflows/workflow-failure-alert.yml) | Event-driven on `workflow_run` failure | `scripts/workflow-failure-alert.ts` | Captures failures only for named workflows whose final conclusion is `failure`. Requires `GITHUB_TOKEN` and `SENTRY_DSN`. Does not detect soft failures. |

### Soft-Deleted Account Purge (Database-level pg_cron)
Account tombstone deletion is managed outside GitHub Actions via the owner's database-level `pg_cron` schedule `purge-soft-deleted-accounts-daily` (`15 3 * * *`, daily at 03:15 UTC). This job runs `public.purge_soft_deleted_accounts()` directly within PostgreSQL (verified active by owner on Nov 10; current run success unverified). There is deliberately no duplicate scheduler configured in GitHub Actions to avoid concurrent purge contention.

### First-Response Steps When a Cron Fails
1. **Locate Logs and Error Details**:
   - The cron failure alerter ([.github/workflows/workflow-failure-alert.yml](../.github/workflows/workflow-failure-alert.yml)) automatically logs failures to Sentry and creates or updates a deduplicated issue in GitHub with the run URL and job ID for workflows whose final conclusion is `failure`.
   - Open the GitHub Actions run URL and inspect the failed step output.
2. **Diagnose Common Failure Reasons**:
   - `missing_env`: If the log reports missing secrets (see [docs/runbooks.md](runbooks.md)), verify that the required secret names are present in GitHub Repository **Settings** > **Secrets and variables** > **Actions**.
   - `statement_timeout`: If database queries timed out, check the timeout bounds documented in [docs/statement-timeouts.md](statement-timeouts.md) and verify database load via [docs/db-health-probe.md](db-health-probe.md).
   - Upstream API rate limits & circuit breaking: When Groq rate limits (upstream 429) or repeatedly fails, `groqCircuitBreaker` trips open and returns HTTP 503 with `{ error: "AI temporarily busy" }` and `Retry-After: 30`, or HTTP 502 with quota/budget rollbacks (`rollbackAllQuotas()`, `settleBudget(0)`). There is no automatic fallback to heuristic text generation on AI completion routes. For dead ATS boards, run `scripts/board-verify-all.ts`.
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
   - *Retention Failure*: Temporary log accumulation; resolved on next successful cycle provided table bloat does not exceed statement timeout.

---

## 4. Database Migrations Procedure

### Live DB State Verification vs Repository Checks
Operational preflight checks must distinguish between repo-side metadata and live database reality:
- `scripts/list-pending-migrations.cjs` **only scans header comment markers** (`-- Status: NOT APPLIED`) inside files in `supabase/migrations/`.
- `scripts/check-schema-dump-freshness.ts` **only verifies the repository copy** (`supabase/schema.generated.sql`) against migration files in git.
- **Neither tool queries the live database or proves live database state.**

### Mandatory Live Preflight Before Apply or Rollback
Before applying any migration or executing any rollback SQL, the operator must execute a live read-only inspection:
1. **Inspect Live Migration Ledger**:
   Verify table and column existence, then inspect applied migrations:
   ```sql
   -- Precheck: Verify schema_migrations table and column existence
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'schema_migrations'
     AND column_name IN ('filename', 'checksum', 'applied_at');

   -- Inspect live migration ledger (template query; verify against live DB)
   SELECT filename, checksum, applied_at
   FROM public.schema_migrations
   ORDER BY applied_at DESC
   LIMIT 10;
   ```
2. **Execute Read-Only Preflight**:
   Run [supabase/scripts/preflight-readonly.sql](../supabase/scripts/preflight-readonly.sql) to check table existence, active lock contention, and constraint validity.
3. **Inspect Target Database Objects Directly**:
   Verify target schema objects using `psql` CLI or Supabase Dashboard SQL Editor (template queries tested for syntax; not claimed to be run live during doc creation):

   *Option A: In `psql` CLI only (interactive session)*:
   ```bash
   \d+ public.jobs
   ```

   *Option B: In Supabase Dashboard SQL Editor (query-based)*:
   ```sql
   -- Structure check via information_schema
   SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'jobs'
   ORDER BY ordinal_position;

   -- Index status and validity query
   SELECT
     c_idx.relname AS index_name,
     i.indisvalid,
     i.indisready
   FROM pg_catalog.pg_index i
   JOIN pg_catalog.pg_class c_idx ON c_idx.oid = i.indexrelid
   JOIN pg_catalog.pg_class c_tbl ON c_tbl.oid = i.indrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = c_tbl.relnamespace
   WHERE n.nspname = 'public'
     AND c_tbl.relname = 'jobs'
   ORDER BY c_idx.relname;
   ```

### The NOT APPLIED Header Convention
Every new migration file placed in `supabase/migrations/` must carry a standardized header declaring its pending status and self-referencing record command (enforced by `scripts/list-pending-migrations.cjs` and `scripts/test-migration-discipline.ts`):
```sql
-- Migration: <timestamp>_<name>.sql
-- Status: NOT APPLIED - record-migration.cjs <timestamp>_<name>.sql
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs <timestamp>_<name>.sql
```

### Migration Apply Procedure
1. **Pre-flight & Zero-Downtime Review**:
   - Review the target SQL file in `supabase/migrations/`.
   - Verify zero-downtime rules per [docs/zero-downtime-migrations.md](zero-downtime-migrations.md) (expand first, contract later; no raw table drops or destructive column updates).
   - If adding indexes, ensure `CREATE INDEX CONCURRENTLY` is used in an autocommit-capable session per [docs/concurrent-covering-index.md](concurrent-covering-index.md).
2. **Execute in Supabase SQL Editor**:
   - Log into Supabase Dashboard > **SQL Editor**.
   - Paste and execute the migration SQL.
3. **Record Migration in Database Ledger**:
   - Run `scripts/record-migration.cjs` to register the exact file name (including `.sql`), SHA-256 hash, and execution timestamp into the `public.schema_migrations` table:
     ```bash
     node scripts/record-migration.cjs <timestamp>_<name>.sql
     # Example:
     node scripts/record-migration.cjs 20261105c_database_safety.sql
     ```
4. **Verify Schema Freshness**:
   - Check that the repo's generated schema snapshot reflects the new state:
     ```bash
     npx tsx scripts/check-schema-dump-freshness.ts
     ```

### Batched Backfill Script Matrix
Backfill operations must never run as single unbatched transactions. Backfill scripts have distinct execution models and safety flags verified from source:

| Script | Dry-Run Flag / Default | Live Write Flag | Overwrite / Targeting Behavior | Backup Mechanism | Safety Classification |
| --- | --- | --- | --- | --- | --- |
| `scripts/backfill-country-code.ts` | **Default: DRY RUN** | `--apply` | Writes only where `country_code IS NULL` or invalid ISO-2 format | Generates pre-update CSV snapshot | Conditional write (`--apply` required; NULL-only) |
| `scripts/backfill-salaries.ts` | **Default: DRY RUN** | `--apply` | `--apply` writes only where `salary_min IS NULL`. `--skip-suspicious` excludes suspicious rows only together with `--apply`. `--restore <csv> --apply` is a separate overwriting mode. | Writes pre-update CSV to `backups/` | Conditional write (`--apply` writes only NULL salaries; overwrites only under `--restore`) |
| `scripts/backfill-company-logos.ts` | **Default: DRY RUN** | `--write` | Optional `--missing-only` / `--schedule` filters `logo_url IS NULL`. Self-hosted URLs in `company-logos` are skipped unless `--force`. Without `--missing-only`, broader replacement is possible. Versioned storage keys prevent DB overwrites. | Reviewed JSON manifest file required for write | Conditional write (`--write` required; broader replacement possible without `--missing-only`) |
| `scripts/backfill-job-descriptions.ts` | `--dry` or `-d` to simulate | **LIVE WRITE BY DEFAULT** | Mutates job descriptions in place (targets NULL and short stub strings); deduplicates and marks duplicate jobs inactive. | None (manual preflight dump required) | **DESTRUCTIVE: WRITE BY DEFAULT** (destructive unless `--dry` / `-d`) |
| `scripts/backfill-internships.ts` | **NONE (No dry-run flag exists)** | **LIVE WRITE BY DEFAULT** | Directly mutates `job_type` in place where internship keywords match. **No dry-run flag exists in script.** | None (manual preflight dump required) | **DESTRUCTIVE: WRITE BY DEFAULT** (destructive live execution by default; no `--dry` flag) |

> [!WARNING]
> Both `scripts/backfill-job-descriptions.ts` and `scripts/backfill-internships.ts` commit live writes by default when executed. Always run `scripts/backfill-job-descriptions.ts` with `--dry` first. For `scripts/backfill-internships.ts`, take an external database snapshot before running.

---

## 5. Environment Variables & Secrets Reference

All production secrets and environment variables must be managed through hosting provider dashboards and GitHub Secrets (never committed to git). Configuration template: [.env.example](../.env.example).

### Cloudflare Pages & Netlify (Production Hosting)

| Variable Name | Scope | Route-Verified Failure Behavior When Missing |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend & Edge Functions | Next.js production build crashes in [next.config.mjs](../next.config.mjs); all database queries fail; `/api/health/ready` returns 503. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend & Edge Functions | Build crashes in [next.config.mjs](../next.config.mjs); public read queries (`jobs_public`) fail. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions & Server API | Route-specific failure behavior: `/api/stats` returns 500 `{ error, missingVariable }` via `src/lib/api/envCheck.ts`; `/api/jobs/pro` and `/api/jobs/top10` return 500; `/api/track` logs to Sentry and returns 200 `{ ok: true, fallback: true }` (fail-open client telemetry); admin routes return 500 (`getSupabaseAdmin` throws). |
| `UPSTASH_REDIS_REST_URL` & `UPSTASH_REDIS_REST_TOKEN` | Serverless & Edge | Distributed Redis commands fail; graceful fallback to in-memory rate limiting via `src/lib/api/sharedRateLimit.ts`. |
| `GROQ_API_KEY` | Edge AI Routes | Edge routes (`/api/ai`, `/api/ai/stream`, `netlify/functions/ai.ts`). When missing, `src/lib/ai/serviceHandler.ts` returns 500 `{ error: "Missing required environment variable: GROQ_API_KEY", missingVariable: "GROQ_API_KEY" }` before quota debit (no rule-based fallback). |
| `NEXT_PUBLIC_BILLING_ENABLED` | Frontend Build & Serverless API | Feature flag in `src/lib/flags/flags.ts`. When `false` or missing, paywall and checkout routes return 503 `BILLING_DISABLED`. |
| `RAZORPAY_KEY_ID` / `NEXT_PUBLIC_RAZORPAY_KEY_ID` & `RAZORPAY_KEY_SECRET` | Serverless Billing | Serverless billing endpoints (`/api/billing/razorpay/order`, `/api/billing/razorpay/verify`, and Netlify billing functions). Gate order: billing disabled returns 503 `BILLING_DISABLED`, invalid/missing auth header returns 401, then missing or non-test keys return 503 `{ error: "test keys not configured", code: "RAZORPAY_TEST_KEYS_NOT_CONFIGURED" }`. `NEXT_PUBLIC_RAZORPAY_KEY_ID` alias is supported. |
| `RAZORPAY_WEBHOOK_SECRET` | Serverless Webhooks | Webhook handler at `/api/billing/razorpay/webhook` returns 500 configuration error; subscription activations stall. |
| `ADMIN_EMAILS` | Admin Auth Config | Declared in `src/lib/admin/constants.ts`. Comma-separated list of authorized admin email addresses (supplements hardcoded `ADMIN_EMAIL` code default). Access requires verified user with `email_confirmed_at` / `confirmed_at` and linked Google OAuth provider (`isVerifiedAdminUser`). (Note: `ADMIN_EMAIL` and `ADMIN_EMAIL_LIST` in `src/lib/admin/constants.ts` are exported code constants, not env vars). |
| `SENTRY_DSN` | Telemetry & Observability | Errors logged locally to console only; no remote incident telemetry. |
| `ENABLE_SERVER_TRACING` *(Pending PR #585)* | Edge Observability | Feature flag in `src/lib/flags/flags.ts` (unmerged on main). Evaluated from `process.env` only; runtime dynamic binding via Cloudflare dashboard is unverified. |

### GitHub Actions (CI & Scheduled Cron Workflows)

| Secret / Variable Name | Consumer Workflows | Route-Verified Failure Behavior When Missing |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY` | Ingest, Retention, Digests, Reconciliation | Ingestion (`ingest.yml`) aborts or falls back to dry-run; retention purge and DB probe jobs fail with exit code 1. |
| `APPS_SCRIPT_MAIL_URL` & `APPS_SCRIPT_MAIL_SECRET` | Early-Access Digest, Dunning Dispatch | `early-access-digest-cron.ts` fails with `missing_env` error (conclusion=failure). In contrast, `dunning-dispatch-cron.ts` logs a warning and exits with code 0 (soft failure, not detected by `workflow-failure-alert.yml`). |
| `EARLY_ACCESS_NOTIFY_EMAIL` | Early-Access Digest | `early-access-digest-cron.ts` fails with `missing_env` error. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Inbound Reply Poll | `poll-inbound-replies.ts` aborts without polling support inbox. |
| `GITHUB_TOKEN` | Cron Failure Alerter | Built-in token. `workflow-failure-alert.ts` cannot search or create tracking issues for failed cron runs. |

---

## 6. Incident Triage (First 15 Minutes)

### Scenario A: Site Down / 5xx Spike on Cloudflare Pages
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
- **T + 5m: Assess Root Domain Failure**
  - *If `/api/health` returns 502/503/timeout*: Primary host Edge or deployment failure.
    - Log into Cloudflare Dashboard > **Workers & Pages** > **carrier-hound** > **Deployments**.
    - Roll back to previous green deployment.
    - If Cloudflare is experiencing an infrastructure outage, review [docs/dns-cutover-runbook.md](dns-cutover-runbook.md) for registrar DNS switching to the Netlify backup host.
  - *If `/api/health` returns 200 but `/api/health/ready` returns 503*: Database connection or table failure.
    - Open Supabase Dashboard > **Settings** > **Database** to verify project state and pooler health.
    - Check Sentry (`careermonke` project) for database error spikes.
- **T + 10m: Run Smoke Suite**
  ```bash
  npx tsx scripts/smoke-post-deploy.ts
  ```

### Scenario B: Ingest Pipeline Stalled (Zero New Jobs)
- **T + 0m: Review Pipeline Runs**
  - Check [.github/workflows/ingest.yml](../.github/workflows/ingest.yml) execution status in GitHub Actions.
  - Check open issues created by [scripts/workflow-failure-alert.ts](../scripts/workflow-failure-alert.ts).
- **T + 3m: Inspect Ingestion Artifacts**
  - Download `ingest-report-shard-*` artifact from the latest Actions run.
  - Inspect extracted report summaries for error codes and per-source counts.
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

*Validated with:* `node scripts/check-ops-runbook.cjs`
