# Source-health monitoring (rows 46/78)

One scheduled check, `scripts/check-source-health.ts` (`source-health-cron.yml`, daily 04:30 UTC), now covers both
ingestion pipelines from the existing `public.ingest_runs` table. No new table, column, SQL, secret, webhook or recipient.

## Evidence

| Pipeline | Writer | Row |
|---|---|---|
| TypeScript | `scripts/ingest.ts` (unchanged) | one row per shard; `per_source_counts = {<ts source id>: inserted+updated, coverage: {cycle_id, shard_id, expected_shards}}` |
| Python | `scripts/scraper/health_record.py`, step **Record run health** in `python-ingest.yml` (write mode only) | one row per cohort run; `per_source_counts = {<python source_id>: inserted+updated or null, python_run: {...}}` |

Python row rules:
- Only existing columns are used. `total_active` and `total_verified` are **null**, because the Python runner doesn't measure them.
- Source keys are the Python report's `source_id`, verbatim (`greenhouse:stripe`, `workday:nvidia`, `adzuna:in`). They never collide with or rename the TS IDs (`greenhouse-stripe`).
- A source's value is `null` when its count is unknown: the source failed, its Workday pagination was incomplete, or writes were withheld. It is never 0. Deferred (cooldown/budget) boards appear only under `python_run.deferred`.
- `status` is `success` only when the cohort exited 0 and every executed source completed with full pagination. Incomplete Workday pagination and a deferred no-op are `warning`. Failures without confirmed writes are `failed`, and a missing report is `failed` with outcome `no_report`.
- `python_run` carries the cohort, outcome, exit code, the guard prefix, per-source state (`completed`/`incomplete`/`failed`, reusing #873's `pagination_complete`), deferrals and GitHub run identity. It has no `coverage` key, so the TS cleanup safety check (`shouldPerformUnseenCleanup`, filtered by `cycle_id`) and `evaluateSourceHealth` never treat a Python row as a TS shard.
- Dry runs never write. The step is gated on `write-production-expire`, and the code refuses any report with `dry_run: true`.
- One POST, with a 15s timeout and no retry. A failed write is an `::error` annotation and a step-summary line. `continue-on-error` keeps the job's result equal to the ingestion result. The missing row then shows up as a missing or overdue cohort in the next check.

Side effects of a Python row, both existing behaviour:
- The `trigger_refresh_worldwide_company_counts` trigger refreshes `worldwide_company_counts` whenever a finished run row is written, as it already does for TS rows.
- `/api/radar`'s `dataAsOf` uses the newest row's `finished_at`, which can now be a Python run.

## Expectations (checked-in configuration only)
- **TypeScript:** the enabled IDs in `scripts/config/companies-scheduled.json`.
- **Python:** `scripts/scraper/expected_sources.json`, generated from `company_seeds.json` by the runner's own `plan_sources`/`select_sources`. CI checks it for drift with `python -m scripts.scraper.health_record expected-sources --check` (in `test_health_record.py`). Regenerate it with `--write`.
- **Missing configuration** is `not_configured`, never healthy.

## Windows (pinned against the workflows by `sourceMonitoring.test.ts` and `test_health_record.py`)

| Check | Window | Why |
|---|---|---|
| TS shard cycles | `SOURCE_HEALTH_STALE_HOURS` (12h), newest 50 TS rows | unchanged policy; Python rows excluded |
| TS per-source freshness | 24h | `ingest.yml` every 4h, one shard per board per cycle; two lost ~12h delivery gaps |
| Python cohort missing/overdue | 12h | `python-ingest.yml` every 4h; watchdog catch-up at 240+45 min; GitHub delivery gaps up to 11.3h |
| Python non-Workday source | 24h | every cohort run |
| Python Workday board | 72h | ≤4 of 7 boards per run, 24h failure-backoff cap, rotation and delivery gaps |
| Lookback | 7 days, paginated (1000/page, cap 10,000) | a cut-off window is reported as `truncated`, never hidden |

## States and exit codes

- **Exit 0, healthy:** every check is healthy.
- **Exit 1, degraded:**
  - TS cycles degraded;
  - a TS source is stale or never seen;
  - a Python cohort is missing, overdue or failed;
  - a Python source is stale, never seen or failed.
- **Exit 2, evidence unavailable:**
  - `insufficient_evidence`;
  - Workday `incomplete` (one page of a larger board);
  - `deferred` (deliberate cooldown or budget, not a failure);
  - `not_configured`, `truncated`, rows for an unconfigured cohort;
  - TS `no_data`, `in_progress` or `invalid`;
  - query failure or missing environment.

Degraded wins over unavailable. Run summaries list states and source IDs only, never URLs or credentials.

## Alerting
There's no new path. A non-zero exit fails `Source Health Monitoring`, and `workflow-failure-alert.yml` (unchanged) already
lists both it and `Python Job Ingestion (every 4 hours)`. **A failed workflow run is not proof that anyone received an alert.**

## Owner-only activation and closure evidence
1. **Merge:** after review, merge the PR. Nothing here changes secrets, schema or flags.
2. **First natural runs:**
   - The first scheduled `python-ingest.yml` run after merge writes the first Python rows. Check its **Record run health** step summary says "written".
   - Until both cohorts have rows, the daily check reports the missing cohorts (exit 1).
   - Workday boards fetched one page at a time are expected to report `incomplete` (exit 2) until pagination is complete. This is deliberate: partial coverage is not shown as healthy.
3. **Alert path:** confirm from a real failed `Source Health Monitoring` run that `workflow-failure-alert.yml` ran and the alert was actually seen. The tests here only mock it.
4. **Row closure:** rows 46/78 close only with a natural scheduled run's evidence and a verified alert path, not from mocks.
