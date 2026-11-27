# Backfill plan: salary normalization columns for existing jobs (checklist #21)

**Status: PLAN ONLY. Not implemented, not run.** No database access, no dry run against production or any
live snapshot, until the owner has applied
`docs/proposed/20261127_salary_normalization_and_skill_requirements.NOT_APPLIED.sql` **and** given an explicit go.

## What it would fill

`salary_annual_min`, `salary_annual_max`, `salary_period_inferred`, `salary_conversion_assumed` for rows that
already exist. New and changed rows get these from ingest (`scripts/ingest.ts`, `scripts/scraper/engine.py`)
once the columns exist. Unchanged rows are never rewritten by ingest, so they stay NULL without a backfill.

## Hard rule

**A stored `salary_period` is not evidence.** Legacy TS adapters (Adzuna, Breezy, Personio, Recruitee, RemoteOK,
Teamtailor, Workable) wrote `'yearly'` with no source support, and `parseSalary` defaulted to `'yearly'` when the text
named no period. A row is annualized only when one of the evidence types below states its period. Every other
row gets `salary_annual_*` = NULL.

## Method (future dry-run audit)

1. Read-only export of active jobs with salary amounts: `id, source, source_type, source_job_id, salary_min,
   salary_max, salary_period, salary_text, currency`, plus the description from `job_descriptions` (or `jobs.description`).
2. For each row, decide the evidence type (first match wins). Decide only from evidence the row already holds or that is
   stored on our side. Do not re-fetch sources for this.
3. Compute the columns with the same code ingest uses (`ingestNormalizationColumns` in TS, or
   `salary_normalization_columns` in Python), passing `salary_period_stated` only where step 2 found evidence.
4. Write a CSV report (no DB writes): `id, evidence_type, decided_period, annual_min, annual_max, inferred,
   conversion_assumed, reason`. The owner reviews it. Only after a second explicit go: batched `UPDATE ... WHERE id IN (...)`
   that touches only the four new columns, never `salary_min`, `salary_max`, `salary_period` or `salary_text`.

## Decisions per evidence type

| Evidence type | Where it would come from | Decision |
|---|---|---|
| Provenance column saying the period was source-stated | None exists today. Ingest does not persist `salary_period_stated`. | Not available. Nothing is decided from it. |
| Raw native interval field (Lever `salaryRange.interval`, Ashby compensation `interval`, SmartRecruiters compensation `period`) | Only if a stored raw payload exists. Raw HTML/JSON snapshots are row 25, still Missing. | Not available until row 25 exists. Without it: NULL. |
| Source text that states one unambiguous period | `parseSalary` / `detectNormalizedPeriod` over the stored description. Not over `salary_text`, which our own formatter suffixes with "/yr". | Annualize only if exactly one supported period is stated and the parsed amounts equal the stored `salary_min`/`salary_max`. Daily/weekly: NULL, because `salary_period` cannot hold them. Ambiguous, negated or conflicting: NULL with the reason. |
| Greenhouse pay range whose own title/blurb says "hour" | Not stored separately. Only re-derivable from a raw payload. | NULL unless a raw payload exists. |
| Stored `salary_period` only (any value) | `jobs.salary_period` | **NULL.** `salary_period_inferred = true`. |
| No salary amounts | — | All four columns NULL. |

`salary_conversion_assumed` follows `ANNUALIZATION_FACTORS` (`src/lib/salary/normalize.ts`): false for yearly and monthly,
true for hourly.

## Expected coverage

**UNKNOWN.** No authorized production snapshot was available for this plan, so it gives no row counts, shares or estimates.
The dry run's CSV is where the first real numbers would come from. Structurally, most rows will stay NULL, because the two
strongest evidence types (provenance, raw payload) do not exist for historical rows.

## Stop conditions

- The columns are missing: stop, write nothing.
- Any row whose parsed text amounts disagree with the stored amounts: record it as `amount_mismatch`, NULL, and never "fix" the stored amounts.
- The export is not read-only, or its target is not the owner-approved snapshot: stop.
