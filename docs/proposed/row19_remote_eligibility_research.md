# Row 19: remote allowed countries / timezone (research note)

Research only. No code, no database reads. Read from `main` @ `71339758`, 27 Nov 2026.
Labels: **from source** means read in this repo's code or schema at that commit; **unverified** means not checked
against data or provider docs.

## What exists

- **from source**: `jobs.remote_eligibility` is free `text` in `supabase/schema.sql:39`. The values the writers produce
  are `worldwide | country_restricted | unknown` (the Python validator's allowed set, `scripts/scraper/persistence.py`).
- **from source**: there is no column for a *list* of allowed countries, and no timezone column. A job carries one
  `country_code`.
- **from source**: the only timezone handling in eligibility is a text match. `src/lib/geo/cities.ts:370` treats a
  location containing "all timezones" as worldwide remote.

## Two writers disagree on the same input

| Input | TS `detectRemoteEligibility` (`scripts/utils/sanitizer.ts:1087-1107`) | Python `_greenhouse_remote_eligibility` (`scripts/scraper/fetchers.py`) |
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

## Options for the owner (not decided here)

1. Align TS with Python: a remote job with no signal is `unknown`, not `worldwide`. This is small, but it changes
   eligibility for existing TS sources on their next ingest, so the scope is the owner's call.
2. Add an allowed-countries list (e.g. `remote_countries text[]`) and an optional timezone window. This needs a NOT APPLIED
   proposal, writer changes in both pipelines, and a serving change (Agent B's area).
3. Provider fields: whether ATS payloads expose structured remote-country lists is **unverified**. Check each
   provider's official docs before relying on them.
