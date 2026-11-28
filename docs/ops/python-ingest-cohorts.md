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

1. **Cadence & Shared Threshold (240 + 45 = 285 min)**:
   - The watchdog triggers every 15 minutes (`*/15 * * * *`).
   - Both worker and workflow admission gate share the same timing configuration: cadence = 240 minutes, grace = 45 minutes, overdue threshold = 285 minutes.
   - Freshness is evaluated per cohort: a successful cohort that completed 200 minutes ago is fresh (< 285m threshold) and is **never rewritten**.
   - Cohorts (`non-workday` and `workday`) are tracked independently. Dry-run jobs (`(dry-run)`), other-branch runs, and skip-only runs are strictly excluded from production freshness.
   - If only one cohort is degraded or overdue, the watchdog dispatches only that degraded cohort, preventing repeated rewrites of the healthy cohort.
2. **Freshness Signal & Accepted PR Limitation**:
   - For this PR, `job-name + conclusion` (`Python ingestion [<cohort>] (write-production-expire)` with `conclusion == 'success'`) is the accepted freshness signal.
   - **Limitation & Follow-Up**: Full artifact report validation (downloading and parsing uploaded JSON artifacts to confirm database write counts) is not performed by the watchdog in this PR; this remains an intentional follow-up. Do not claim full report verification.
3. **Attempt Cooldown (45 min) & Concurrency Gate**:
   - Both worker and workflow admission gate enforce a 45-minute bounded attempt cooldown. If a cohort attempt recently failed or completed, rapid re-dispatching is suppressed to prevent infinite retry loops.
   - When dispatched, the workflow acquires the existing `concurrency: group: ingest-pipeline, cancel-in-progress: false` serialized lock.
   - Inside the `plan` job, `scripts/scraper/watchdog_gate.py` re-evaluates requested cohorts after acquiring the lock. If all requested cohorts succeeded within 285 minutes, or if an attempt occurred within 45 minutes, it skips execution (`skip=true`).
   - If credentials, API responses, or cohort jobs cannot be verified (e.g. HTTP 401/403/429/timeout, empty jobs, malformed data), the gate fails closed (`skip=true`, exit 1) and never authorizes a production attempt. Verified first-run bootstrap (API 200 with zero runs) is admitted.
4. **Retry-After & Ambiguous Dispatch Protection**:
   - Full `Retry-After` is honored (supporting delta-seconds and HTTP-date). If the requested wait exceeds the worker's retry budget (30s), it defers visibly with an error rather than retrying early.
   - If a dispatch POST encounters a network error or timeout ambiguity, the watchdog **never blindly retries** the POST. Instead, it queries the workflow runs endpoint to recheck whether a run was created; if unconfirmed, it fails closed to prevent double-dispatch.
5. **Alert Destination & Best-Effort Deduplication**:
   - Mandatory webhook URL (`ALERT_WEBHOOK_URL`) for Slack, Discord, PagerDuty, or HTTP monitoring sink. Missing or invalid webhook URL fails closed.
   - In-memory alert deduplication (30m TTL) is **best-effort** across Cloudflare Worker isolates (resets on worker cold starts or isolate migration).
6. **Strictly Read-Only Endpoints**:
   - `GET /check` and `GET /inspect` perform genuinely read-only inspection.
   - `GET /health` returns `200 OK` only when config is valid and ingestion is healthy; it returns `503 Service Unavailable` (not-ready) for stale or unverifiable ingestion state.
   - Manual catch-up dispatches require authenticated explicit `POST /dispatch` with `Authorization: Bearer <DISPATCH_SECRET>`.

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

## Source-health record

Each write-mode cohort run also writes one `ingest_runs` row (step **Record run health**), read by the daily source-health check. See [source-health-monitoring.md](source-health-monitoring.md).
