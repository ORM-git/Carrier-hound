# Row 34: alias prefix-fallback audit result

Offline, file-only. Read from `main` @ `61cd5b6e`, 27 Nov 2026. No database, no network. `enrichment.py` is not edited
(#698 touches that file).

## What was audited

- **from source**: `COMPANY_ALIASES` has 96 keys, 79 of them with 5+ characters (`scripts/scraper/enrichment.py:670`).
  `normalize_company_alias` tries exact token lookups first (`:783-788`), then a prefix fallback for keys of 5+ characters
  (`:791-793`).
- Tool: `scripts/scraper/audit_alias_prefix.py`. It calls the real `normalize_company_alias` twice per name: once as-is,
  and once with the prefix loop disabled through a recording alias map. A different result means only the prefix branch
  mapped the name. No normalization logic is copied.
- Inputs (files only):
  - `scripts/scraper/company_seeds.json`: `name` and `slug` of `layer1_public_ats` (29 entries), `workday_cxs` (7),
    and the `amazon` / `microsoft` entries. Slugs are included because `enrichment.py:814` also passes seed slugs
    through the function.
  - `data/ats-candidates-all.json`: the `company` field. **Only 551 of 27,588 entries have a company name** (507
    distinct). The other 27,037 carry only a board `token` and were **not audited**: the brief scopes this to company
    names, and candidate tokens are not passed to this function unless they become seeds.
- Distinct names checked: **560**.

## Result

**2 prefix-only matches out of 560 names.**

| Name (origin) | Alias key | Inherited canonical name | Read verdict |
|---|---|---|---|
| `Palantir Technologies` (seeds layer1 name) | `palantir` | `Palantir Technologies` | Same company. **Not** a possible false match. |
| `Bosch Group` (seeds layer1 name) | `bosch` | `Bosch Group` | Same company. **Not** a possible false match. |

Both rows were read by hand; nothing was judged automatically. Both hits are full company names that miss the exact
lookup and only resolve through the prefix branch, to the same company. No possible false match was found in these
inputs.

## Limits

- This covers only the names in the two files above. Names that arrive at runtime from aggregator sources (JobSpy,
  Adzuna and others via `fetch_aggregators_and_india.py:117`) are not in any repo file and were not audited.
  Collisions there are **unverified**.
- Reproduce: `python -m scripts.scraper.audit_alias_prefix` (add `--json` for the full list).
