# Row 34: agency flag and company aliases (research note)

Research only. No code, no database reads. Read from `main` @ `71339758`, 27 Nov 2026.
Labels: **from source** = read in this repo at that commit; **unverified** = not checked against data or docs.

## Status (main `61cd5b6e`)

- **Partial.** Evidence: there is no agency column (`public.companies` and `jobs` in `supabase/schema.sql`). Aliases live
  in `scripts/scraper/enrichment.py:670` (`COMPANY_ALIASES`), with a prefix fallback at `enrichment.py:792`. The
  category regex at `enrichment.py:770` is not an agency flag.
- **Smallest next change:** an offline, file-only collision audit of the prefix fallback against
  `scripts/scraper/company_seeds.json` (a new test or script; no edit to `enrichment.py`). An agency flag first needs the
  owner to choose between a curated list and a provider field.
- **Files vs open PRs:** `enrichment.py` is touched by #698 (draft, logo lane). The audit does not edit it, so there is no
  overlap. Editing the alias logic later would overlap #698. Open PRs checked (live, 27 Nov): #557 (`ingest.ts`, `sourceHealth.ts`, `check-source-health.ts`, `20261108d_jobs_first_seen_at_immutable.sql`, …), #791 (`sourceHealth.ts` + test), #698 (draft; `engine.py`, `enrichment.py`, `run_ingestion.py`, logo files), #749 (`engine.py`, `persistence.py`, test).

## Agency flag

- **from source**: there is no agency or staffing flag anywhere. `public.companies` (`supabase/schema.sql`) has
  `name, slug, canonical_domain, category, ...`; `category` allows `MNC_BIGTECH | HIGH_PRODUCT_YC | OTHER_STARTUPS |
  INDIAN_IT_AND_OTHER`; `jobs` has none either.
- **from source**: the closest signal is `_IT_SERVICE_PATTERN_RE` in `scripts/scraper/enrichment.py`, which matches words
  like `staffing`, `outsourcing`, `consulting` and `services` to pick a *category*. It does not mark a posting as placed by an agency,
  and words like "services" are far broader than recruiting agencies.
- **from source**: the word "agency" in a board token is not evidence. `data/ats-candidates-all.json` has tokens such as
  `criminaljusticeagency`, `krollbondratingagency` and `thebrandagency` (government, ratings and marketing firms).
- **unverified**: whether any provider exposes a structured "posted by agency / third party" field.

A flag that is never inferred from name words alone would need either a curated list (a `data/` registry with
evidence per entry) or a provider field. Which one is the owner's decision.

## Company aliases

- **from source**: `COMPANY_ALIASES` in `scripts/scraper/enrichment.py` has **96** entries, counted by parsing the dict
  literal. **79** of them have keys of 5+ characters.
- **from source**: `normalize_company_alias` tries an exact token match first, then falls back to a **prefix** match for
  any key of 5+ characters (`token.startswith(alias_key)`). An unrelated company whose normalized name merely starts with
  an alias key inherits that company's name, category and domain. Example shape: a key `postman` would also match
  `postmanpatlogistics`.
- **unverified**: whether such collisions exist in current seeds or data. This needs an offline run over
  `scripts/scraper/company_seeds.json` and the aggregator fixtures; no production read.
- **from source**: the TS path has no equivalent alias table. Company identity there is the source's name plus
  `slugify` (`scripts/utils/sanitizer.ts`), so one employer can appear under two spellings across pipelines.

## Suggested next steps (owner to scope)

1. An offline collision audit of the prefix match against repo seeds and fixtures (read-only, file-based).
2. If an agency flag is wanted: decide curated list vs provider field first; then a NOT APPLIED column proposal.
