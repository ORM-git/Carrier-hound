# Python ingestion cohort owner verification

Use this sequence after reviewing the code. The workflow itself remains scheduled every four hours and shares the `ingest-pipeline` lock with the TypeScript ingester; `cancel-in-progress: false` keeps active runs alive. GitHub cron is best-effort, so a missed slot is not proof of a code failure.

1. Review the exact PR head SHA, both source cohorts, the workflow checks and the report schema. Confirm the PR is merged and deployed to the default branch before relying on its schedule. Do not dispatch from a feature branch.
2. Separately approve an owner-run manual workflow execution. The existing schedule and manual entry point retain write, production and expiry authority; each cohort has a separate source-failure veto and report. A failing cohort leaves the aggregate run red while the other cohort still executes.
3. Inspect both uploaded JSON reports. Check selected/completed/failed source IDs, fetched and deduped totals, persistence-confirmed inserted/updated/unchanged counts, expiry outcomes, guard reason, SHA, and timestamps. A dry-run projection is not a confirmed write; fetched jobs are not newly added jobs; a zero net active delta can be legitimate.
4. On the established CareerMonke test-account site, record timestamped before/after values from the public `/api/stats` endpoint alongside the run SHA and both reports. Missing guest-stat fields are unknown, not zero. Do not use the production database, service-role credentials, or a user's session token in a public checker.
5. Escalate missing repository secrets, workflow permissions, inactive workflow configuration, or scheduling restrictions to the repository owner. Do not add a token, external scheduler, automatic dispatch loop, or retry that bypasses the shared lock.

---

## Scheduled Ingestion Watchdog & Catch-Up Operations

To safeguard against dropped GitHub Actions cron events, an independent scheduled Cloudflare Worker watchdog (`workers/ingest-watchdog`) monitors ingestion cadence. Native GitHub cron (`47 2-23/4 * * *`) remains the primary scheduler; the watchdog acts strictly as a secondary catch-up safety net.

### Architecture & Dedupe Safety

1. **Cadence Threshold**: The watchdog triggers every 15 minutes (`*/15 * * * *`). If the 4-hour cadence is overdue by > 45 minutes (total > 285 minutes since the last completed successful ingestion) and no workflow run is currently active, it dispatches `python-ingest.yml` on `main`.
2. **Serialized Concurrency & Cooldown Gate**:
   - The dispatch passes `inputs.watchdog = true`.
   - The workflow acquires the existing `concurrency: group: ingest-pipeline, cancel-in-progress: false` lock.
   - Inside the `plan` job, `scripts/scraper/watchdog_gate.py` evaluates recent completed runs. If any successful ingestion run completed within the bounded 195-minute cooldown window (e.g. an earlier cron or queued catch-up run just finished), the gate sets `skip=true`.
   - The workflow completes green without running scraper jobs or writing to the database.
   - Zero database migrations or Cloudflare KV atomicity assumptions; deduplication safety is enforced within the concurrency-serialized workflow.
3. **Stale Job Protection & Cohort Inspection**:
   - Active runs queued or running for $\ge 120$ minutes are reported via alert without dispatching duplicate runs.
   - Actual per-cohort outcomes (`jobs` endpoint) are inspected; partial failures trigger alert diagnostics.

### Narrowly Scoped Credentials & Secrets

The watchdog uses the principle of least privilege:

1. **Fine-Grained GitHub Personal Access Token (PAT)**:
   - **Repository Access**: Only `ORM-git/Carrier-hound`.
   - **Permissions**: `Actions: Read and write` (required only to inspect `/actions/workflows/python-ingest.yml/runs` and trigger `/dispatches`).
   - **Contents / PRs / Administration / Secrets**: No access.
2. **Alert Destination**:
   - Webhook URL (Slack, Discord, PagerDuty, or HTTP monitoring sink) to receive immediate notifications on dispatch errors, stale jobs, or missing configuration. Missing credentials fail visibly (never silently healthy).

### Activation Procedure (Owner Prerequisite)

> [!IMPORTANT]
> Do NOT deploy or run live dispatches without explicit repository owner approval.

To activate the watchdog once approved:
```bash
# 1. Set required secrets in workers/ingest-watchdog
npx wrangler secret put GITHUB_TOKEN --cwd workers/ingest-watchdog
npx wrangler secret put ALERT_WEBHOOK_URL --cwd workers/ingest-watchdog

# 2. Deploy to Cloudflare Workers
npx wrangler deploy --cwd workers/ingest-watchdog

# 3. Verify health and dry check endpoints
curl -f https://carrier-hound-ingest-watchdog.<subdomain>.workers.dev/health
curl -f https://carrier-hound-ingest-watchdog.<subdomain>.workers.dev/check
```

### Rollback & Deactivation

1. **Emergency Pause**: Revoke or clear `GITHUB_TOKEN`:
   ```bash
   npx wrangler secret delete GITHUB_TOKEN --cwd workers/ingest-watchdog
   ```
   Or disable the Cron Trigger in the Cloudflare Dashboard under **Workers & Pages > carrier-hound-ingest-watchdog > Triggers > Cron Triggers**.
2. **Full Teardown**:
   ```bash
   npx wrangler delete carrier-hound-ingest-watchdog --cwd workers/ingest-watchdog
   ```
   Native GitHub Actions scheduled cron runs continue unaffected.

