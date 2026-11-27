# Row 82: alert metric/event contract (SPEC ONLY)

**Status: Partial, spec only.** No code, helper, workflow or migration exists or is proposed to be built from this file
yet. Read from `main` @ `71339758`; line numbers re-checked on `61cd5b6e`, 27 Nov 2026.

**No alert can fire yet.** No metric here is qualified: thresholds are not established for any of them, including
`workday_freshness_lag` (section 5), and the collision-rate denominator is unqualified (3.1). The only open items are
thresholds, delivery, and that denominator (section 7). Labels: **from source (file:line)** = read at that commit;
**unverified** = not checked; **agent-read, unverified by keeper** = counted by Agent A from downloaded CI artifacts
(section 8), not independently checked.

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

### 3.1 `apply_url_collision_rate`: UNDEFINED (denominator not qualified)

- Numerator, from source: per-source `duplicate_skipped` (`run_ingestion.py:640`) and run-level
  `duplicate_skipped_count` (`run_ingestion.py:750`).
  - It counts only apply-URL collisions at persist time: the prelookup finds the URL owned by another job, or the
    insert or update returns a unique violation (`engine.py:625, 771, 837, 875`).
  - It is **not** a duplicate-job rate.
- `fetched` is **not** a denominator: it is the raw count before dedupe and validation (`run_ingestion.py:129, 417`).
- **`validated` is a CANDIDATE denominator, not qualified.** Per source, `validated = len(keys) - rej`
  (`run_ingestion.py:638`). Open points:
  1. **Stage.** `keys` comes from `rep["jobs"]` (`run_ingestion.py:633`), and `rep["jobs"]` is the raw fetch list
     (`run_ingestion.py:129`). So `keys` is taken **before** salary sanitizing, prevalidation, in-run dedupe and the
     row cap (`run_ingestion.py:418-422`).
     - Rows dropped by in-run dedupe (`select_unique_jobs`, `:421`) or by the cap (`:422`) are neither rejected, nor
       `duplicate_skipped`, nor persisted. The code folds them into per-source `failed` when writes were attempted
       (`:643`).
     - `keys` is also a set, so repeated source keys within one source collapse.
  2. **Mixed rejections.** `rejected` holds prevalidation rejections (`:419`, before dedupe) plus DB-stage rejections
     appended later (`:498`). The per-source `rej` matches both (`:626, 635`).
  3. **Withheld writes.** `writes_attempted` (`:469`) is a local variable and is not in the report JSON.
     - `persisted_counts` being present (`:753`) only means "not a dry run". It does not prove writes were attempted.
     - When writes are withheld (`guard_block_reason` "write_withheld", `:697, 701`), nothing reaches persistence, so
       `duplicate_skipped` is 0.
     - `guard_block_reason` is a top-level report key (seen in one real report, section 8). It may be usable as a
       withheld/dry-run marker. Its use is **unverified**.
- **apply_url_collision_rate stays UNDEFINED until the owner of run_ingestion.py confirms the stage, or the report
  exposes an attempted-write count.**
- **Zero / invalid rule (for when it is defined):** a missing, null, non-numeric or 0 denominator gives `no_data`,
  never 0%. A dry-run report or a withheld-write run gives `no_data`.

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
- `sampled_at`: the report's top-level `finished_at` (from source: `run_ingestion.py:724`, written once when the report
  is built; `started_at` is `:723`). Both keys are present in one real report's key list (section 8). Never use the
  evaluator's wall clock. A missing or unparseable `finished_at` makes the report `invalid` for this metric.

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
- Without thresholds no metric is qualified, `workday_freshness_lag` included, so **no alert can fire yet**.

## 6. Event shape (proposed; no alert-event type exists today)

```json
{ "alert_id": "<metric>:<source>:<cycle-or-date>", "metric": "workday_freshness_lag", "source": "<source id>",
  "severity": "warning" | "critical", "state": "firing" | "resolved",
  "value": <number>, "threshold": <number>, "sampled_at": "<ISO-8601>", "reason": "<text>" }
```

- `alert_id` is deterministic, so a later dedupe layer can key on it.
- No metric can produce events yet. `workday_freshness_lag` is defined but has no threshold (section 5); the others are
  undefined (3.1, 3.4, 3.5).

## 7. Open items (owner decisions, nothing to build yet)

Only these three are open:

1. **Thresholds.** None are established for any metric. They need measured data from owner-run baselines.
2. **Delivery.** Both options use existing channels; no recommendation to build either.
   - (a) The evaluator runs in the aggregate step and fails it. `workflow-failure-alert.yml` already opens an issue for
     "Python Job Ingestion (every 4 hours)" (from source: lines 5-18). Cost: a metric alert looks like a broken ingest run.
   - (b) The evaluator writes its result into the summary and does not change the exit code. A separate step or workflow
     raises the alert later. Cost: a CI-config change, out of scope now.
3. **Collision-rate denominator qualification** (3.1). Either the owner of `run_ingestion.py` confirms the stage of
   `validated`, or the report exposes an attempted-write count.

Recorded, not open: freshness lag is Workday-only by data (3.2). Covering other sources would need `last_success_at`
for them, which is a separate change.

## 8. Observed counts (agent-read, unverified by keeper)

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
- Key-list check (Prompt 7): one more download of run `45910126572`'s non-Workday report (2026-11-26 23:18 UTC), deleted
  after reading. Its top-level keys include `started_at`, `finished_at` and `guard_block_reason` (null in that run).
  Agent-read, unverified by keeper.
