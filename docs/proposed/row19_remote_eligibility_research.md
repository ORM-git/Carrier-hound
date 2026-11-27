# Row 19: remote allowed countries / timezone (research note)

Research only. No code, no database reads. Read from `main` @ `71339758`, 27 Nov 2026.
Labels: **from source** means read in this repo's code or schema at that commit; **unverified** means not checked
against data or provider docs.

## Follow-up after the snapshot (27 Nov 2026)

PR #857 merged as `03fbda717f35327afaa35a0e6ff45ad63aebc1c3`. The TS no-geography fallback now returns `unknown`, with offline detector and eligibility tests. This corrects classification on later TS ingest/re-ingest writes; it does not backfill existing rows. No production ingest run or changed production counts were verified here. Explicit worldwide text and country-coded radar placement retain their existing behavior. The change aligns this fallback, not every TS/Python detector branch.

The allowed-countries list and timezone-window design below remain unbuilt. The historical fallback-change option is no longer an outstanding owner question.

## Historical status (main `61cd5b6e`, superseded where noted above)

- **Partial.** Evidence: one `remote_eligibility` text value per job (`supabase/schema.sql:39`); TS detector
  `scripts/utils/sanitizer.ts:1088-1107`; Python `scripts/scraper/fetchers.py:150-156`; worldwide reader
  `src/lib/geo/cities.ts:370`, `src/lib/jobs/eligibility.ts:192-216`. No allowed-countries list or timezone column.
- **Smallest next change:** align the TS fallback (`sanitizer.ts:1107`) to return `unknown` like Python, with one
  test. It changes stored values on the next TS ingest, so it needs the owner's go.
- **Files vs open PRs:** `scripts/utils/sanitizer.ts` is in none of #557, #791, #698, #749. No overlap.
  Open PRs checked (live, 27 Nov): #557 (`ingest.ts`, `sourceHealth.ts`, `check-source-health.ts`, `20261108d_jobs_first_seen_at_immutable.sql`, …), #791 (`sourceHealth.ts` + test), #698 (draft; `engine.py`, `enrichment.py`, `run_ingestion.py`, logo files), #749 (`engine.py`, `persistence.py`, test).

## What exists

- **from source**: `jobs.remote_eligibility` is free `text` in `supabase/schema.sql:39`. The values the writers produce
  are `worldwide | country_restricted | unknown` (the Python validator's allowed set, `scripts/scraper/persistence.py`).
- **from source**: there is no column for a *list* of allowed countries, and no timezone column. A job carries one
  `country_code`.
- **from source**: the only timezone handling in eligibility is a text match. `src/lib/geo/cities.ts:370` treats a
  location containing "all timezones" as worldwide remote.

## Two writers disagree on the same input

| Input | TS `detectRemoteEligibility` (`scripts/utils/sanitizer.ts:1088-1107`) | Python `_greenhouse_remote_eligibility` (`scripts/scraper/fetchers.py:150-156`) |
|---|---|---|
| not remote | `unknown` | `unknown` |
| remote + "anywhere / worldwide / global / all regions" | `worldwide` | `worldwide` (only if no country evidence) |
| remote + a detectable country | `country_restricted` | `country_restricted` |
| remote + **no** location signal (e.g. "Remote") | **`worldwide`** (final fallback, line 1107) | **`unknown`** |

- **from source**: the TS fallback calls a bare "Remote" job worldwide. Readers trust that value.
  `src/lib/jobs/eligibility.ts:192-216` treats `remote_eligibility = worldwide` as eligible everywhere, and
  `cities.ts` resolves it to "Worldwide Remote". A US-only remote job posted as just "Remote" on a TS-ingested source
  is therefore shown to every country.
- **unverified**: how many rows this affects. No production read was made.
- **from source**: Python also reports `country_restricted` when the location names a single country, but stores only
  one `country_code`. A posting listing "US, Canada, UK" keeps at most one of them.

## Historical options (fallback option now addressed by #857)

1. Align TS with Python: a remote job with no signal is `unknown`, not `worldwide`. This is small, but it changes
   eligibility for existing TS sources on their next ingest, so the scope is the owner's call.
2. Add an allowed-countries list (e.g. `remote_countries text[]`) and an optional timezone window. This needs a NOT APPLIED
   proposal, writer changes in both pipelines, and a serving change (Agent B's area).
3. Provider fields: whether ATS payloads expose structured remote-country lists is **unverified**. Check each
   provider's official docs before relying on them.
