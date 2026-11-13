# Scheduled Workflows Cron-Health Gate & Operational Guide

> **Health Gate Script**: `scripts/check-cron-health.cjs`  
> **Offline Test Suite**: `scripts/test-cron-health.cjs`  
> **Execution Command**: `node scripts/check-cron-health.cjs [--json] [--repo ORM-git/Carrier-hound]`  
> **Cadence**: Run every morning of launch week (Monday 16 Nov) at 08:00 UTC / 13:30 IST.  
> **Exit Guarantee**: Exits `0` only if all scheduled workflows report `PASS`; exits `1` on any `FAIL` or `STALE` workflow.

---

## 1. Why Scheduled Workflows ARE the Product

CareerMonke does not rely on employers manually posting job vacancies. The entire value proposition rests on automated, background scheduled workflows:
- **4-hourly Ingestion (`ingest.yml`)**: Scrapes and verifies active listings directly from official company ATS portals. If it fails silently, the feed freezes and users see ghost listings.
- **Daily Candidate Digest (`daily-digest-cron.yml`)**: Computes personalized job recommendations and delivers daily alert emails. If it fails, user engagement collapses.
- **Inbound Reply Poll (`inbound-poll-cron.yml`)**: Polls Gmail for recruiter responses. If it stalls, interview invitations and status changes are missed.
- **Weekly Maintenance (`retention-cron.yml`, `db-health-probe.yml`, `db-reconciliation.yml`)**: Enforces GDPR data retention, verifies database query latency, and audits financial/user entitlement consistency.

Because two workflows failed silently during pre-launch week, the automated `check-cron-health.cjs` gate must be executed every morning of launch week to guarantee system health.

---

## 2. Known Incident History (Pre-Launch Baseline)

Launch-week reviewers and on-call engineers must recognize these known failure modes so repeats are immediately identified and triaged:

1. **Early-Access Digest Env Credential Failures (`early-access-digest-cron.yml`)**:
   - **Incident**: Failed on 12 Nov (Run #15, `2026-11-12T22:55:31Z`).
   - **Root Cause**: Environment credential misconfiguration (expired or missing Google/Gmail OAuth refresh tokens in workflow secrets).
   - **Launch Repeat Signature**: Exit with `failure` during the email dispatch step.

2. **8 Nov Retention Purge Query Timeout (`retention-cron.yml`)**:
   - **Incident**: Failed on 8 Nov (Run #1, `2026-11-08T22:59:09Z`).
   - **Root Cause**: Query timeout and connection lock during bulk deletion of unpartitioned audit telemetry.
   - **Launch Repeat Signature**: Exit with `failure` on Sunday night purge runs (`30 19 * * 0`).

3. **Ingestion Pipeline Cancellations and Stalls (`ingest.yml`)**:
   - **Incident**: Cancelled on 13 Nov (Run #44, `2026-11-13T04:20:02Z`) and failed on 12 Nov (Runs #42, #43).
   - **Root Cause**: Exceeded step timeouts or concurrency cancellation when overlapping runs were queued.
   - **Launch Repeat Signature**: Status `cancelled` or `failure`, resulting in public jobs feed staleness.

4. **Source Health Scraper Timeout (`source-health-cron.yml`)**:
   - **Incident**: Failed on 12 Nov (Run #1, `2026-11-12T12:59:17Z`).
   - **Root Cause**: Scraper network timeout against rate-limiting ATS career portals.

5. **Inert Probe Variable (`db-health-probe.yml`)**:
   - **Current Status**: Completed with conclusion `skipped` on 9 Nov (`2026-11-09T09:42:13Z`).
   - **Root Cause**: Guarded by `if: ${{ vars.DB_HEALTH_PROBE_ENABLED == 'true' }}` which is intentionally inert until enabled in repository variables. Flagged as `FAIL` by the health gate until activated or scheduled.

6. **New Reconciliation Workflow Pending Run (`db-reconciliation.yml`)**:
   - **Current Status**: Merged on 11 Nov, first scheduled run is Monday 03:27 UTC. Reports `STALE` (zero completed runs recorded) until its first execution.

---

## 3. Scheduled Workflows Master Inventory

| # | Workflow File | Workflow Name | Schedule (UTC) | Interval | 1.5x Cap | Core Purpose | Failure Blast Radius | First Response (Ops Runbook) |
| :-: | :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| **1** | `ingest.yml` | Scaled Job Ingestion & Cleanup Pipeline | `0 */4 * * *` | 4 hours | 6.0h | Scrapes verified ATS career portals, validates postings, and soft-deletes expired listings. | **Critical (P0)**: Public jobs feed freezes; zero new jobs; candidate search results degrade; core product promise fails. | [`docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs`](docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs) (*Pending PR #593*) |
| **2** | `inbound-poll-cron.yml` | Inbound Reply Poll | `15 */4 * * *` | 4 hours | 6.0h | Polls Gmail API for recruiter/employer email replies and updates candidate application tracking status. | **High (P1)**: Recruiter messages and interview invitations not reflected in application tracker. | [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending PR #593*) |
| **3** | `daily-digest-cron.yml` | Daily Candidate Matching & Digest Cron | `30 21 * * *` | 24 hours | 36.0h | Matches candidate preferences to verified open jobs and dispatches daily personalized alert emails. | **High (P1)**: Candidates receive no daily matching emails; engagement and re-engagement loops collapse. | [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending PR #593*) |
| **4** | `early-access-digest-cron.yml` | Daily Early-Access Signup Digest Cron | `0 18 * * *` | 24 hours | 36.0h | Summarizes new user signups and dispatches daily recap email to site owner. | **Medium (P2)**: Site owner lacks visibility into daily signup volume and waitlist growth. | [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending PR #593*) |
| **5** | `dunning-dispatch-cron.yml` | Dunning Outbox Dispatch Cron | `30 4 * * *` | 24 hours | 36.0h | Dispatches payment retry notifications for failed subscription renewals. | **Low at launch (P3)** (Payments OFF); **High post-launch (P1)**: Involuntary subscriber churn without warning. | [`docs/ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating`](docs/ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating) (*Pending PR #593*) |
| **6** | `source-health-cron.yml` | Source Health Monitoring | `30 4 * * *` | 24 hours | 36.0h | Tests ATS career portal DOM structures and parse success rates; alerts on broken parsers. | **Medium (P2)**: Broken company scrapers remain undetected until job feed volume drops. | [`docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs`](docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs) (*Pending PR #593*) |
| **7** | `retention-cron.yml` | Weekly Retention Purge Cron | `30 19 * * 0` | 168 hours | 252.0h | Purges expired telemetry, audit logs, and anonymized candidate data per data retention policy. | **High (P1)**: GDPR/privacy non-compliance; unbounded database table growth; index bloat. | [`docs/ops-runbook.md#database-migrations-procedure`](docs/ops-runbook.md#database-migrations-procedure) (*Pending PR #593*) |
| **8** | `db-health-probe.yml` | Read-only DB Health Probe | `13 2 * * 1` | 168 hours | 252.0h | Executes read-only probe against Supabase connection pooler, query latency, and active connections. | **Medium (P2)**: Connection pool exhaustion or query latency degradation goes unnoticed. | [`docs/ops-runbook.md#database-migrations-procedure`](docs/ops-runbook.md#database-migrations-procedure) (*Pending PR #593*) |
| **9** | `db-reconciliation.yml` | Weekly Database Reconciliation Audit | `27 3 * * 1` | 168 hours | 252.0h | Audits user entitlement records against payments and application states to detect data drift. | **Medium (P2)**: Entitlement inconsistencies or orphaned state drift accumulate unnoticed. | [`docs/ops-runbook.md#database-migrations-procedure`](docs/ops-runbook.md#database-migrations-procedure) (*Pending PR #593*) |
| **10** | `capacity-report-cron.yml` | Capacity Headroom Report | `0 5 * * 1` | 168 hours | 252.0h | Evaluates database storage, API quotas, and compute headroom against tier limits. | **Medium (P2)**: Launch-week traffic spikes cause unpredicted quota exhaustion. | [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending PR #593*) |
| **11** | `license-guard.yml` | OSS License Guard | `0 4 * * 1` | 168 hours | 252.0h | Audits production dependencies for viral or copyleft licenses (GPL/AGPL). | **Low (P3)**: Legal license compliance exposure on newly added npm dependencies. | [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) (*Pending PR #593*) |
| **12** | `plan-regression.yml` | Plan Regression | `17 3 * * 1` | 168 hours | 252.0h | Evaluates EXPLAIN query plans on critical read paths to catch sequential scan regressions. | **High (P1)**: Unindexed query paths slip into production, causing database CPU spikes and 504s. | [`docs/ops-runbook.md#database-migrations-procedure`](docs/ops-runbook.md#database-migrations-procedure) (*Pending PR #593*) |
| **13** | `security-scan.yml` | Security & Secret Scanning | `0 4 * * 1` | 168 hours | 252.0h | Executes Gitleaks secret scanning and generates CycloneDX SBOM. | **High (P1)**: Leaked credentials or unpatched vulnerabilities remain live in production. | [`docs/ops-runbook.md#5-environment-variables--secrets-reference`](docs/ops-runbook.md#5-environment-variables--secrets-reference) (*Pending PR #593*) |

---

## 4. Verdict Definitions & Threshold Mathematics

The health gate evaluates each scheduled workflow against three strict states:

1. **`PASS`**:
   - The latest completed workflow run concluded with `success`.
   - The run occurred within **$1.5 \times \text{Interval}$**:
     $$\text{Age}_{\text{hours}} \le 1.5 \times \text{Interval}_{\text{hours}}$$
   - *Example*: A 4-hourly workflow (`ingest.yml`) must have a green run completed within the last 6.0 hours.
   - *Example*: A daily workflow (`daily-digest-cron.yml`) must have a green run completed within the last 36.0 hours.
   - *Example*: A weekly workflow (`retention-cron.yml`) must have a green run completed within the last 252.0 hours (10.5 days).

2. **`STALE`**:
   - The workflow has not completed a run within $1.5 \times \text{Interval}$, even if the previous run succeeded.
   - Catches GitHub Actions schedule drop-offs, queue starvation, or runner scheduler delays.
   - Also assigned when **zero completed runs** are found for a workflow in the repository history.

3. **`FAIL`**:
   - The latest completed workflow run concluded with any non-success status: `failure`, `cancelled`, `timed_out`, `skipped`, `startup_failure`, or `action_required`.
   - Catches active crashes, syntax errors, missing secrets, or runtime exceptions.

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
- Repository target
- Aggregate verdict (`passedAll: boolean`)
- Total, pass, stale, and fail counts
- Per-workflow status, run ID, age, and remediation detail

### Handling Rate Limits
The script uses the public GitHub Actions API and requires no authentication for normal read rates. If executing in an environment sharing IP addresses with heavy GitHub traffic:
```bash
GITHUB_TOKEN=your_token node scripts/check-cron-health.cjs
# or pass explicitly:
node scripts/check-cron-health.cjs --token your_token
```

### Running the Offline Test Suite
To verify verdict logic, interval parsing, and negative controls without contacting GitHub:
```bash
node scripts/test-cron-health.cjs
```
Runs 20 offline test cases against an in-memory mock fixture server, ensuring all error, stale, and failure branches return non-zero exit codes.
