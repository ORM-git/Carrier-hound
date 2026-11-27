# Row 34: agency flag and company aliases (research note)

Research only. No code, no database reads. Read from `main` @ `71339758`, 27 Nov 2026.
Labels: **from source** = read in this repo at that commit; **unverified** = not checked against data or docs.

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
