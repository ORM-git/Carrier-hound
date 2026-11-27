# Row 82: alert metric/event contract (SPEC ONLY)

**Status: Partial, spec only.** No code, helper, workflow or migration exists or is proposed to be built from this file
yet. Read from `main` @ `71339758`, 27 Nov 2026. Labels: **from source (file:line)** = read at that commit;
**unverified** = not checked; **observed** = counted from downloaded CI artifacts (section 8).

The ledger goal (row 82) is an audit target. No owner message approving it as a requirement was found.

## 1. Input

- One per-run report JSON per cohort, written by `run_ingestion` and aggregated by `ingest_report.py`.
  - from source: the report is written as `reports/python-ingest-$COHORT.json` (`.github/workflows/python-ingest.yml:210`).
  - from source: the aggregate job downloads all cohort reports, then runs
    `python -m scripts.scraper.ingest_report aggregate` (`python-ingest.yml:244-263`).
- Per-source rows are `report.sources[]`. The columns the aggregator reads are `PER_SOURCE_COLUMNS`
  (from source: `scripts/scraper/ingest_report.py:21-22`).
- No `ingest_runs` change, and no edit to files owned by open #557 (`scripts/ingest.ts`, `sourceHealth.ts`, …) or #791
  (`src/lib/observability/sourceHealth.ts`).
  - from source: `ingest_runs` has one writer, `scripts/ingest.ts:543,1116`. The Python pipeline does not write it.

## 2. Dry runs

- Dry-run marker: the top-level report field `dry_run` (from source: `scripts/scraper/run_ingestion.py:741`).
- from source: the aggregator reads it as `bool(report.get("dry_run", True))` (`ingest_report.py:30`). **An absent field
  counts as a dry run.** The contract keeps that rule.
- from source: dry run is the CLI default. `dry_run_from_args` returns true unless `--write-to-database` is passed
  (`scripts/scraper/engine.py:154-158`).
  - Scheduled workflow runs use `write-production-expire` (`python-ingest.yml` ~109-111).
  - Manual dispatch defaults to `dry-run` (`python-ingest.yml:31-34`).
- **Rule:** every metric on a dry-run report is `no_data`, never 0. Dry runs persist nothing, so
  `duplicate_skipped` is 0 there by construction (corrections 2 and 4 below).

## 3. Metrics

### 3.1 `apply_url_collision_rate`: UNDEFINED (denominator field: none today)

- Numerator, from source: per-source `duplicate_skipped` and run-level `duplicate_skipped_count`
  (`run_ingestion.py:640, 749-750`).
  - It counts only apply-URL collisions at persist time: the prelookup finds the URL owned by another job, or the
    insert or update returns a unique violation (`engine.py:625, 771, 837, 875`).
  - It is **not** a duplicate-job rate.
- Denominator wanted: attempted persist writes. **Denominator field: none today.**
  - from source: `persisted_counts` holds successful `inserted` / `updated` / `unchanged`, and is null on dry runs
    (`run_ingestion.py:753-757`).
  - from source: `projected_counts` is the plan from `partition_set_diff(all_jobs, [])`, computed against an empty
    existing set (`run_ingestion.py:453-454`), not attempts.
  - from source: per-source `failed` is derived, `len(keys) - rej - len(dups) - len(persisted)`, and only when
    `writes_attempted` (`run_ingestion.py:643`).
  - None of these is "attempted writes".
- `fetched` is **not** a substitute: it is the raw count before dedupe and validation (`run_ingestion.py:129`).
- The metric stays undefined until a report field counts attempted writes. Adding one is a later, separate change.

### 3.2 `workday_freshness_lag`: Workday sources only

- Definition: `sampled_at − last_success_at`, one value per Workday source per non-dry-run report.
- **Coverage: Workday sources only.**
  - from source: `last_success_at`, `cooldown_reason` and `next_eligible_at` are set only when
    `src["source_type"] == "workday"` (`run_ingestion.py:650-654`). Every other source has them null.
  - observed: in each non-Workday report read, **33-34 non-Workday sources, 0 with `last_success_at`**. All are excluded.
- Exclusion: a null or unparseable `last_success_at` is excluded and counted in `excluded_sources`.
  - observed: some Workday sources also lack it (e.g. 2 of 3 had it in one run, 0 of 1 in another).
- Quantiles: filter the samples **first** (finite and `>= 0`, as `evaluateSlo` does at
  `src/lib/observability/slo.ts:36-37`), then call `percentile(samples, p)` (`slo.ts:24-30`, nearest-rank,
  p in (0,100]).
  - from source: `percentile()` itself does not drop NaN or negative values, and throws `RangeError` for p outside
    (0,100].
  - An empty sample list gives `percentile() = null`, so the status is `no_data`.
- `sampled_at`: the report's own run time. Which report field carries it is **unverified**. Pin it before code, and
  never use the evaluator's wall clock.

### 3.3 Deferred sources (cooldown)

- Sources with a `cooldown_reason` / `next_eligible_at`, and the run-level `deferred_sources`
  (`run_ingestion.py:727`), are reported as deferred.
- They are excluded from failure counts and from freshness lag for that run. Workday only, for the same reason as 3.2.

### 3.4 `repost_rate`: UNDEFINED

- Nothing in the reports or schema links a repost to an earlier job. A repost under a new `source_job_id` is a new row
  (see `docs/proposed/row39_fetch_vs_new_job_research.md`, PR #853).
- No metric and no placeholder until row 39/35 define repost identity.

### 3.5 Country × occupation coverage: UNDEFINED

- It needs a country/occupation matrix and corpus counts. Neither is in the report JSON. The counts would be an
  owner-run production read.
- Not guessed here.

## 4. Status vocabulary (reused from `sourceHealth.ts`)

- from source: `"healthy" | "degraded" | "no_data" | "invalid" | "in_progress"` (`src/lib/observability/sourceHealth.ts:24`).
- `healthy`: evaluated, no threshold crossed. `degraded`: at least one threshold crossed.
- `no_data`: dry-run report, no eligible samples, or an undefined metric.
- `invalid`: a non-array or unparseable input, or a missing or invalid policy.
  - This matches today: `sourceHealth.ts:166-169` returns `invalid` for a bad policy.
  - There is **no `not_configured`** status.
- `in_progress`: not used by these metrics. Reports are written once per completed cohort.
- `firing` / `resolved` are **event states** (section 6), not statuses.

## 5. Thresholds: NOT ESTABLISHED

- No threshold exists for any metric here. The caller passes a policy object; missing or invalid means `invalid`
  (section 4). There are no defaults.
- The existing failure/staleness policy is separate and not reused:
  `MAX_FAILURES_IN_WINDOW = 1`, `STALE_AFTER_HOURS = 12` by default, overridable by `SOURCE_HEALTH_STALE_HOURS`
  (from source: `scripts/check-source-health.ts:7-8`).
- The section 8 observations are context only. **They do not set thresholds.**

## 6. Event shape (proposed; no alert-event type exists today)

```json
{ "alert_id": "<metric>:<source>:<cycle-or-date>", "metric": "workday_freshness_lag", "source": "<source id>",
  "severity": "warning" | "critical", "state": "firing" | "resolved",
  "value": <number>, "threshold": <number>, "sampled_at": "<ISO-8601>", "reason": "<text>" }
```

- `alert_id` is deterministic, so a later dedupe layer can key on it.
- Only `workday_freshness_lag` can produce events today. The other metrics are undefined (3.1, 3.4, 3.5).

## 7. Open items (owner decisions, nothing to build yet)

1. **Delivery.** Both options use existing channels; no recommendation to build either.
   - (a) The evaluator runs in the aggregate step and fails it. `workflow-failure-alert.yml` already opens an issue for
     "Python Job Ingestion (every 4 hours)" (from source: lines 5-18). Cost: a metric alert looks like a broken ingest run.
   - (b) The evaluator writes its result into the summary and does not change the exit code. A separate step or workflow
     raises the alert later. Cost: a CI-config change, out of scope now.
2. **A report field for attempted writes**, to define 3.1.
3. **`last_success_at` for non-Workday sources**, if freshness lag should cover them. Today it is Workday-only by data.
4. **The `sampled_at` field** (3.2).
5. **Thresholds** from measured data (owner-run).
6. **Live baselines and real delivery checks** need production access and are owner-run.

## 8. Observed counts (bounded read-only research)

- Read: **12 report JSONs** from the **6 most recent `python-ingest.yml` runs** (all `schedule`), each with a
  `non-workday` and a `workday` cohort report.
  - Runs `45458361517`, `45535361727`, `45607641666`, `45720435755`, `45810986130`, `45910126572`.
  - Created 2026-11-24 18:19 UTC to 2026-11-26 23:18 UTC.
  - Downloaded through GitHub Actions artifacts only, then deleted. No database, no production reads.
- **Dry runs:** 0 of 12 (`dry_run: false` in all). As expected for scheduled runs.
- **Sources per report:**
  - non-Workday cohort: 33-34 sources, all non-Workday;
  - Workday cohort: 1-4 sources, all Workday.
- **`last_success_at` present:**
  - non-Workday sources: 0 in every report;
  - Workday sources: 0 of 1 to 4 of 4, depending on the run.
- **Apply-URL collisions** (`duplicate_skipped_count`):
  - Workday reports: 0 in all 6;
  - non-Workday reports: 0 in the earliest run, then **472-477** in each of the other 5;
  - the largest single source: 351-352; non-zero sources per report: 6-8.
- Not interpreted and not used for thresholds. Why the earliest run shows 0 is **unverified**.
