# Python ingestion cohort owner verification

Use this sequence after reviewing the code. The workflow itself remains scheduled every four hours and shares the `ingest-pipeline` lock with the TypeScript ingester; `cancel-in-progress: false` keeps active runs alive. GitHub cron is best-effort, so a missed slot is not proof of a code failure.

1. Review the exact PR head SHA, both source cohorts, the workflow checks and the report schema. Confirm the PR is merged and deployed to the default branch before relying on its schedule. Do not dispatch from a feature branch.
2. Separately approve an owner-run manual workflow execution. The existing schedule and manual entry point retain write, production and expiry authority; each cohort has a separate source-failure veto and report. A failing cohort leaves the aggregate run red while the other cohort still executes.
3. Inspect both uploaded JSON reports. Check selected/completed/failed source IDs, fetched and deduped totals, persistence-confirmed inserted/updated/unchanged counts, expiry outcomes, guard reason, SHA, and timestamps. A dry-run projection is not a confirmed write; fetched jobs are not newly added jobs; a zero net active delta can be legitimate. Note: GitHub Actions job status inspection (e.g. checking job conclusions) confirms execution status, but is NOT full artifact report validation, which requires inspecting confirmed database write counts in the uploaded JSON artifact report.
4. On the established CareerMonke test-account site, record timestamped before/after values from the public `/api/stats` endpoint alongside the run SHA and both reports. Missing guest-stat fields are unknown, not zero. Do not use the production database, service-role credentials, or a user's session token in a public checker.
5. Escalate missing repository secrets, workflow permissions, inactive workflow configuration, or scheduling restrictions to the repository owner. Do not add a token, external scheduler, automatic dispatch loop, or retry that bypasses the shared lock.

---

## Scheduled Ingestion Watchdog & Catch-Up Operations

To safeguard against dropped GitHub Actions cron events, an independent scheduled Cloudflare Worker watchdog (`workers/ingest-watchdog`) monitors ingestion cadence. Native GitHub cron (`47 2-23/4 * * *`) remains the primary scheduler; the watchdog acts strictly as a secondary catch-up safety net.

### Architecture & Dedupe Safety

1. **Cadence & Cohort Freshness**:
   - The watchdog triggers every 15 minutes (`*/15 * * * *`).
   - Freshness is derived from verified production-write cohort jobs on `main` (matching `Python ingestion [<cohort>] (write-production-expire)`).
   - Cohorts (`non-workday` and `workday`) are tracked independently. Dry-run jobs (`(dry-run)`), other-branch runs, and skip-only runs are strictly excluded from production freshness.
   - If any cohort's last verified write is overdue by > 45 minutes beyond the 4-hour cadence (total > 285 minutes) and no run is active, the watchdog dispatches catch-up for the degraded cohort(s). If only one cohort is degraded, only that cohort is dispatched, avoiding rewriting healthy cohorts.
2. **Attempt Cooldown & Concurrency Gate**:
   - Both the watchdog worker and the workflow admission gate (`scripts/scraper/watchdog_gate.py`) enforce a 45-minute bounded attempt cooldown. If a cohort attempt recently failed, rapid re-dispatching is suppressed to prevent infinite retry loops.
   - When dispatched, the workflow acquires the existing `concurrency: group: ingest-pipeline, cancel-in-progress: false` serialized lock.
   - Inside the `plan` job, `scripts/scraper/watchdog_gate.py` evaluates recent completed runs on `main`. If all requested cohorts succeeded within the 195-minute cooldown window, or if an attempt occurred within 45 minutes, it skips execution (`skip=true`).
   - If credentials, API responses, or cohort jobs cannot be verified (e.g. HTTP 401/403/429, timeout, network error), the gate fails closed (`skip=true`, exit 1) and never authorizes a production attempt. Verified first-run bootstrap (API 200 with zero runs) is admitted.
3. **Stale Job Protection & Observable Alerts**:
   - Active runs queued or running for $\ge 120$ minutes are reported via webhook alert without dispatching duplicate runs.
   - Mandatory webhook destination validation, explicit network timeouts (15s), bounded retries with `Retry-After`, and alert deduplication (30m) prevent webhook spam.

### Narrowly Scoped Credentials & Secrets

The watchdog operates under least privilege:

1. **Fine-Grained GitHub Personal Access Token (PAT)**:
   - **Repository Access**: Only `ORM-git/Carrier-hound`.
   - **Permissions**: `Actions: Read and write` (to inspect `/actions/workflows/python-ingest.yml/runs` and trigger `/dispatches`).
   - **Contents / Pull Requests / Administration / Secrets**: No access.
2. **Alert Destination**:
   - Mandatory webhook URL (`ALERT_WEBHOOK_URL`) for Slack, Discord, PagerDuty, or HTTP monitoring sink. Missing or invalid webhook URL fails closed.
3. **Manual Dispatch Secret (Optional)**:
   - `DISPATCH_SECRET`: If configured, allows authorized operators to trigger catch-up reconciliation via `POST /dispatch`.

### Activation Procedure (Owner Prerequisite)

> [!IMPORTANT]
> Do NOT deploy or run live dispatches without explicit repository owner approval.

To activate the watchdog once approved:
```bash
# 1. Set required secrets in workers/ingest-watchdog
npx wrangler secret put GITHUB_TOKEN --cwd workers/ingest-watchdog
npx wrangler secret put ALERT_WEBHOOK_URL --cwd workers/ingest-watchdog
npx wrangler secret put DISPATCH_SECRET --cwd workers/ingest-watchdog  # optional

# 2. Deploy to Cloudflare Workers
npx wrangler deploy --cwd workers/ingest-watchdog

# 3. Verify health and read-only inspection (dry-check)
curl -s https://carrier-hound-ingest-watchdog.<subdomain>.workers.dev/health
curl -s https://carrier-hound-ingest-watchdog.<subdomain>.workers.dev/check

# 4. Optional manual catch-up trigger (requires DISPATCH_SECRET)
curl -X POST https://carrier-hound-ingest-watchdog.<subdomain>.workers.dev/dispatch \
  -H "Authorization: Bearer <DISPATCH_SECRET>"
```

### Rollback & Deactivation

1. **Emergency Pause**: Revoke or clear `GITHUB_TOKEN`:
   ```bash
   npx wrangler secret delete GITHUB_TOKEN --cwd workers/ingest-watchdog
   ```
   Or disable the Cron Trigger in Cloudflare Dashboard under **Workers & Pages > carrier-hound-ingest-watchdog > Triggers > Cron Triggers**.
2. **Full Teardown**:
   ```bash
   npx wrangler delete carrier-hound-ingest-watchdog --cwd workers/ingest-watchdog
   ```
   Native GitHub Actions scheduled cron runs continue unaffected.
