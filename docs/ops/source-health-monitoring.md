# Source-health monitoring (rows 46/78)

One scheduled check, `scripts/check-source-health.ts` (`source-health-cron.yml`, daily 04:30 UTC), covers both
ingestion pipelines from the existing `public.ingest_runs` table. No new table, column, SQL, secret, webhook or recipient.

**The Python writer is off until the owner sets the repository variable `PY_HEALTH_RECORD=true`.** Until then no Python
row is written, and the check judges TypeScript only:
- its summary header reads `HEALTHY - TypeScript only, python NOT MONITORED`;
- it prints a `::notice`;
- its last line on exit 0 is `TypeScript healthy; Python NOT MONITORED`.

TypeScript failures still fail the check.

## Gate (one policy)
- **Writer:** `python-ingest.yml` step **Record run health** runs only if
  `needs.plan.outputs.mode == 'write-production-expire' && vars.PY_HEALTH_RECORD == 'true'`.
- **Checker:** `source-health-cron.yml` passes `PY_HEALTH_RECORD: ${{ vars.PY_HEALTH_RECORD }}`, and
  `loadMonitoringConfig` reads it through the one parser `pythonHealthRecordingEnabled`:
  `(value ?? '').toLowerCase() === 'true'`, with no trimming.
- **Why lowercase:** GitHub Actions string `==` is case-insensitive, so `true`/`TRUE`/`True` are on and
  `''`/`false`/`yes`/`" true"` are off, on both sides.
- **Default:** `MonitoringConfig.pythonRecording` is on only when it is exactly `true`; undefined means off.
- **When off:** Python cohorts and stray-row checks are skipped, and one check
  `{pipeline: "python", scope: "pipeline", state: "not_monitored", severity: "ok"}` is reported. The result also
  carries `notMonitored: ["python"]`.

## Evidence

| Pipeline | Writer | Row |
|---|---|---|
| TypeScript | `scripts/ingest.ts` (unchanged) | one row per shard; `per_source_counts = {<ts source id>: inserted+updated, coverage: {cycle_id, shard_id, expected_shards}}` |
| Python | `scripts/scraper/health_record.py`, step **Record run health** in `python-ingest.yml` (write mode and `PY_HEALTH_RECORD=true` only) | one row per cohort run; `per_source_counts = {<python source_id>: inserted+updated or null, python_run: {...}}` |

Python row rules:
- Only existing columns are used. `total_active` and `total_verified` are **null**, because the Python runner doesn't measure them.
- Source keys are the Python report's `source_id`, verbatim (`greenhouse:stripe`, `workday:nvidia`, `adzuna:in`). They never collide with or rename the TS IDs (`greenhouse-stripe`).
- A source's value is `null` when its count is unknown: the source failed, its Workday pagination was incomplete, or writes were withheld. It is never 0. Deferred (cooldown/budget) boards appear only under `python_run.deferred`.
- `status` is `success` only when the cohort exited 0 and every executed source completed with full pagination. Incomplete Workday pagination and a deferred no-op are `warning`. Failures without confirmed writes are `failed`, and a missing report is `failed` with outcome `no_report`.
- `python_run` carries the cohort, outcome, exit code, the guard prefix, per-source state (`completed`/`incomplete`/`failed`, reusing #873's `pagination_complete`), deferrals and GitHub run identity. It has no `coverage` key.
- Dry runs never write. The step is gated on `write-production-expire` (and on `PY_HEALTH_RECORD`), and the code refuses any report with `dry_run: true`.
- One POST, with a 15s timeout and no retry. A failed write is an `::error` annotation and a step-summary line. `continue-on-error` keeps the job's result equal to the ingestion result. The missing row then shows up as a missing or overdue cohort in the next check.

How Python rows are kept out of TypeScript logic:
- **Cleanup safety:** `shouldPerformUnseenCleanup` (`scripts/cleanup.ts`) drops Python rows (`pythonRunMeta`) before its shard logic. It does this even when no `cycleId` is passed, so a Python success row can never stand in for TS shard 0. With no TS rows left, cleanup is blocked.
- **Cycle health:** `evaluateSourceHealth` is only given TS rows.
- **Radar `dataAsOf`:** this is **the latest TypeScript run's `finished_at`** and nothing more. `src/lib/observability/radarRunMeta.ts` filters `per_source_counts->python_run is null` before ordering by `started_at` desc. A failed TypeScript run can still advance the stamp, and it can lag a successful Python write.

Side effect once the writer is on: the existing `trigger_refresh_worldwide_company_counts` trigger refreshes `worldwide_company_counts` for every finished run row, Python included. The refresh time has not been measured.

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

- **Exit 0, healthy:** every judged check is healthy. While Python is not monitored, this covers TypeScript only, and the header and last line say so.
- **Exit 1, degraded:**
  - TS cycles degraded;
  - a TS source is stale or never seen;
  - (when monitored) a Python cohort is missing, overdue or failed;
  - (when monitored) a Python source is stale, never seen or failed.
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
1. **Merge:** after review, merge the PR. Nothing here changes secrets, schema, flags or variables; the writer stays off.
2. **Turn the writer on (owner only, needs an explicit go-ahead):** set repository variable `PY_HEALTH_RECORD=true`. Then:
   - Each future write-mode Python cohort run inserts one `ingest_runs` row.
   - Each row fires the existing refresh trigger (refresh time unmeasured).
   - The daily check starts judging Python.
3. **First natural runs after that:**
   - Check that the **Record run health** step summary says "written".
   - Until both cohorts have rows, the daily check reports the missing cohorts (exit 1).
   - Workday boards fetched one page at a time are expected to report `incomplete` (exit 2). This is deliberate: partial coverage is not shown as healthy.
4. **Alert path:** confirm from a real failed `Source Health Monitoring` run that `workflow-failure-alert.yml` ran and the alert was actually seen. The tests here only mock it.
5. **Row closure:** rows 46/78 close only with a natural scheduled run's evidence and a verified alert path, not from mocks.
