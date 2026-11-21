# Scheduled Workflows Cron-Health Gate & Operational Guide

> **Health Gate Script**: `scripts/check-cron-health.cjs`  
> **Offline Test Suite**: `scripts/test-cron-health.cjs`  
> **Execution Command**: `node scripts/check-cron-health.cjs [--json] [--repo ORM-git/Carrier-hound]`  
> **Cadence**: Run every morning of launch week (Monday 16 Nov) at 08:00 UTC / 13:30 IST.  
> **Exit Guarantee**: Exits `0` only if all scheduled workflows on the default branch report `PASS`; exits `1` on any `FAIL` or `STALE` workflow.

---

## 1. Why Scheduled Workflows ARE the Product

CareerMonke does not rely on employers manually posting job vacancies. The entire value proposition rests on automated, background scheduled workflows:
- **4-hourly Ingestion (`ingest.yml`)**: Scrapes and verifies active listings directly from official company ATS portals. If it fails silently, the feed freezes and users see ghost listings.
- **Daily Candidate Digest (`daily-digest-cron.yml`)**: Computes match scores and queues idempotent digest recommendation records in the database (delivery handled by downstream mail dispatchers). If it stalls, candidate match queues fall behind.
- **Inbound Reply Poll (`inbound-poll-cron.yml`)**: Polls Gmail for recruiter responses. If it stalls, interview invitations and status changes are missed.
- **Weekly Maintenance (`retention-cron.yml`, `db-health-probe.yml`, `db-reconciliation.yml`)**: Enforces database log hygiene, verifies database query latency, and audits financial/user entitlement consistency.
- **Source Health Monitoring (`source-health-cron.yml`)**: Evaluates ingestion pipeline health by querying recent `ingest_runs` from the database (no direct ATS portal scraping).

Because two workflows failed silently during pre-launch week, the automated `check-cron-health.cjs` gate must be executed every morning of launch week to guarantee schedule execution and freshness.

> [!IMPORTANT]
> **Scope & Health Guarantees**: Workflow success proves only GitHub Actions runner schedule execution, non-skipped job completion, and freshness within $1.5\times$ interval. It does **not** verify end-user email deliverability, GDPR erasure compliance, database backup restoration integrity, external API quota health, or production application performance.

---

## 2. Known Incident History (Pre-Launch Baseline)

Launch-week reviewers and on-call engineers must recognize these known failure modes so repeats are immediately identified and triaged:

1. **Early-Access Digest Secret/Env Failure (`early-access-digest-cron.yml`)**:
   - **Incident**: Failed on 12 Nov (Run #15, `2026-11-12T22:55:31Z`).
   - **Root Cause**: **Unknown / unconfirmed** (persisted job logs lack verified root-cause telemetry; suspected env/secret configuration during email dispatch step).
   - **Launch Repeat Signature**: Exit with `failure` during the email dispatch step.

2. **8 Nov Retention Purge Execution Failure (`retention-cron.yml`)**:
   - **Incident**: Failed on 8 Nov (Run #1, `2026-11-08T22:59:09Z`).
   - **Root Cause**: **Unknown / unconfirmed** (initial run encountered execution failure during RPC invocation; unverified in persisted logs).
   - **Clarification**: *Note: This workflow (`retention-cron.yml`, running `scripts/retention-cron.ts` for operational log purge, expired job archiving, and index reindexing) is distinct from the database-level `pg_cron` account purge executed on 10 Nov.*

3. **Ingestion Pipeline Cancellations and Stalls (`ingest.yml`)**:
   - **Incident**: Cancelled on 13 Nov (Run #44, `2026-11-13T04:20:02Z`) and failed on 12 Nov (Runs #42, #43).
   - **Root Cause**: **Unknown / unconfirmed** (investigation required into runner step timeout or queue concurrency cancellation).
   - **Launch Repeat Signature**: Status `cancelled` or `failure`, resulting in public jobs feed staleness.

4. **Source Health Database Query Failure (`source-health-cron.yml`)**:
   - **Incident**: Failed on 12 Nov (Run #1, `2026-11-12T12:59:17Z`).
   - **Root Cause**: **Unknown / unconfirmed** (failure occurred during database query evaluation of recent `ingest_runs`).

5. **Guard-Gated Probe Variable (`db-health-probe.yml`)**:
   - **Current Status**: Completed with conclusion `skipped` on 9 Nov (`2026-11-09T09:42:13Z`).
   - **Guard Design**: Guarded by `if: ${{ vars.DB_HEALTH_PROBE_ENABLED == 'true' }}` which is intentionally inert until enabled in repository variables. Flagged as `FAIL` by the health gate because all guarded jobs were skipped.
   - **Operational Guidance**: *DB probe is guard-gated by design. Enabling it is an intentional operational decision, not a routine fix for cron-health failures.*

6. **Guard-Gated Reconciliation Workflow (`db-reconciliation.yml`)**:
   - **Current Status**: Merged on 11 Nov, guarded by `if: ${{ vars.DB_RECONCILIATION_ENABLED == 'true' }}`. Reports `STALE` (zero completed scheduled runs on default branch) until its first execution.
   - **Operational Guidance**: *DB reconciliation is guard-gated by design. Do NOT recommend enabling it as a routine fix.*

---

## 3. Scheduled Workflows Master Inventory

| # | Workflow File | Workflow Name | Schedule (UTC) | Interval | 1.5x Cap | Core Purpose | Failure Blast Radius | First Response (Ops Runbook) |
| :-: | :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| **1** | `ingest.yml` | Scaled Job Ingestion & Cleanup Pipeline | `0 */4 * * *` | 4 hours | 6.0h | Scrapes verified ATS career portals, validates postings, and soft-deletes expired listings. | **Critical (P0)**: Public jobs feed freezes; zero new jobs; candidate search results degrade; core product promise fails. | [`./ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs`](./ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs) (*Pending in-flight PR #593*) |
| **2** | `inbound-poll-cron.yml` | Inbound Reply Poll | `15 */4 * * *` | 4 hours | 6.0h | Polls Gmail API for recruiter/employer email replies and updates candidate application tracking status. | **High (P1)**: Recruiter messages and interview invitations not reflected in application tracker. | [`./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending in-flight PR #593*) |
| **3** | `daily-digest-cron.yml` | Daily Candidate Matching & Digest Cron | `30 21 * * *` | 24 hours | 36.0h | Computes match scores and queues idempotent candidate recommendation records into digest database table (does not dispatch email directly). | **High (P1)**: Candidates receive no daily matching recommendations; match pipelines stall. | [`./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending in-flight PR #593*) |
| **4** | `early-access-digest-cron.yml` | Daily Early-Access Signup Digest Cron | `0 18 * * *` | 24 hours | 36.0h | Summarizes new user signups and dispatches daily recap email to site owner. | **Medium (P2)**: Site owner lacks visibility into daily signup volume and waitlist growth. | [`./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending in-flight PR #593*) |
| **5** | `dunning-dispatch-cron.yml` | Dunning Outbox Dispatch Cron | `30 4 * * *` | 24 hours | 36.0h | Dispatches payment retry notifications for failed subscription renewals. | **Low at launch (P3)** (Payments OFF); **High post-launch (P1)**: Involuntary subscriber churn without warning. | [`./ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating`](./ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating) (*Pending in-flight PR #593*) |
| **6** | `source-health-cron.yml` | Source Health Monitoring | `30 4 * * *` | 24 hours | 36.0h | Queries database `ingest_runs` to evaluate per-source parse success rates, error counts, and zero-yield anomalies (does not scrape external ATS portals). | **Medium (P2)**: Degraded company ingest sources remain undetected until job feed volume drops. | [`./ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs`](./ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs) (*Pending in-flight PR #593*) |
| **7** | `retention-cron.yml` | Weekly Retention Purge Cron | `30 19 * * 0` | 168 hours | 252.0h | Purges expired telemetry, audit logs, and archives expired jobs per data retention policy. | **High (P1)**: GDPR/privacy non-compliance; unbounded database table growth; index bloat. | [`./ops-runbook.md#database-migrations-procedure`](./ops-runbook.md#database-migrations-procedure) (*Pending in-flight PR #593*) |
| **8** | `db-health-probe.yml` | Read-only DB Health Probe | `13 2 * * 1` | 168 hours | 252.0h | Guard-gated probe against Supabase connection pooler, query latency, and active connections. | **Medium (P2)**: Connection pool exhaustion or query latency degradation goes unnoticed. | [`./ops-runbook.md#database-migrations-procedure`](./ops-runbook.md#database-migrations-procedure) (*Pending in-flight PR #593*) |
| **9** | `db-reconciliation.yml` | Weekly Database Reconciliation Audit | `27 3 * * 1` | 168 hours | 252.0h | Guard-gated audit of user entitlement records against payments and application states. | **Medium (P2)**: Entitlement inconsistencies or orphaned state drift accumulate unnoticed. | [`./ops-runbook.md#database-migrations-procedure`](./ops-runbook.md#database-migrations-procedure) (*Pending in-flight PR #593*) |
| **10** | `capacity-report-cron.yml` | Capacity Headroom Report | `0 5 * * 1` | 168 hours | 252.0h | Evaluates database storage, API quotas, and compute headroom against tier limits. | **Medium (P2)**: Launch-week traffic spikes cause unpredicted quota exhaustion. | [`./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending in-flight PR #593*) |
| **11** | `license-guard.yml` | OSS License Guard | `0 4 * * 1` | 168 hours | 252.0h | Audits production dependencies for viral or copyleft licenses (GPL/AGPL). | **Low (P3)**: Legal license compliance exposure on newly added npm dependencies. | [`./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](./ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending in-flight PR #593*) |
| **12** | `plan-regression.yml` | Plan Regression | `17 3 * * 1` | 168 hours | 252.0h | Evaluates EXPLAIN query plans on critical read paths to catch sequential scan regressions. | **High (P1)**: Unindexed query paths slip into production, causing database CPU spikes and 504s. | [`./ops-runbook.md#database-migrations-procedure`](./ops-runbook.md#database-migrations-procedure) (*Pending in-flight PR #593*) |
| **13** | `security-scan.yml` | Security & Secret Scanning | `0 4 * * 1` | 168 hours | 252.0h | Executes Gitleaks secret scanning and generates CycloneDX SBOM. | **High (P1)**: Leaked credentials or unpatched vulnerabilities remain live in production. | [`./ops-runbook.md#5-environment-variables--secrets-reference`](./ops-runbook.md#5-environment-variables--secrets-reference) (*Pending in-flight PR #593*) |

---

## 4. Verdict Definitions & Threshold Mathematics

The health gate evaluates each scheduled workflow against three strict states:

1. **`PASS`**:
   - The latest completed scheduled workflow run on the default branch (`event=schedule`, `branch=main`) concluded with `success`.
   - All guarded jobs in the workflow executed successfully; if all guarded jobs were skipped (`conclusion: "skipped"`), the workflow is marked `FAIL`.
   - The run occurred within **$1.5 \times \text{Interval}$**:
     $$\text{Age}_{\text{hours}} \le 1.5 \times \text{Interval}_{\text{hours}}$$
   - *Example*: A 4-hourly workflow (`ingest.yml`) must have a green run completed within the last 6.0 hours.
   - *Example*: A daily workflow (`daily-digest-cron.yml`) must have a green run completed within the last 36.0 hours.
   - *Example*: A weekly workflow (`retention-cron.yml`) must have a green run completed within the last 252.0 hours (10.5 days).

2. **`STALE`**:
   - The workflow has not completed a scheduled run on the default branch within $1.5 \times \text{Interval}$, even if previous runs succeeded.
   - Catches GitHub Actions schedule drop-offs, queue starvation, or runner scheduler delays.
   - Also assigned when **zero completed scheduled runs** are found on the default branch in repository history.
   - *Note*: Manual (`workflow_dispatch`) or PR runs do not reset schedule freshness. They are reported separately as diagnostics.

3. **`FAIL`**:
   - The latest completed scheduled run concluded with any non-success status: `failure`, `cancelled`, `timed_out`, `skipped`, `startup_failure`, or `action_required`.
   - All guarded jobs in a green workflow were skipped (no work executed).
   - Any individual job within the scheduled run failed.
   - Invalid, missing, or future timestamps detected (fails closed; age is never `NaN` or `0`).
   - Unsupported or invalid cron pattern detected (fails closed; never guesses 24h).

---

## 5. Usage & Daily Launch-Week Runbook

### Daily Morning Check (Terminal Output)
```bash
node scripts/check-cron-health.cjs
```

### Launch-Week Audit Log (Appends Dated Record)
```bash
node scripts/check-cron-health.cjs --json
```
Appends a structured JSON Lines record to `reports/cron-health/cron-health-YYYY-MM-DD.jsonl` recording:
- ISO timestamp
- Repository target and branch
- Aggregate verdict (`passedAll: boolean`)
- Total, pass, stale, and fail counts
- Per-workflow scheduleRun evidence (id, runNumber, conclusion, status, event, headBranch, headSha, createdAt, completedAt)
- Diagnostic latest run evidence (if different from schedule run)
- Timestamp field used and age in hours

### Handling Rate Limits Safely
The script queries the public GitHub Actions API. To prevent rate-limiting in environments sharing egress IPs, supply a GitHub token:
```bash
GITHUB_TOKEN=your_token node scripts/check-cron-health.cjs
# or pass explicitly:
node scripts/check-cron-health.cjs --token your_token
```
> [!NOTE]
> The checker strictly enforces token security: `GITHUB_TOKEN` is only transmitted over HTTPS to verified GitHub endpoints (`api.github.com` or `*.github.com`). It is automatically stripped when connecting to local or insecure endpoints, and is never leaked in reports, logs, or error URLs.

### Running the Offline Test Suite
To verify verdict logic, interval parsing, inventory drift, and HTTP robustness negative controls without contacting GitHub:
```bash
node scripts/test-cron-health.cjs
```
Runs 44 offline test cases against local mock servers and fixtures, verifying all error, stale, and failure branches exit with code 1.
