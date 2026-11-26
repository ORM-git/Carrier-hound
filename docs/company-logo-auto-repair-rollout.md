# Company logo auto-repair: owner rollout and rollback

Status: **code prepared, automatic repair OFF.** Nothing here runs until the owner does each step.
`LOGO_REPAIR_ENABLED` stays unset/false until step 4 passes.

Backend-only reconciliation of the existing #698 pipeline, not a second logo writer. Current UI and
reviewed static logo assets are unchanged. Python ingestion already calls the shared enqueue RPC;
regular TS and board ingestion now enqueue into the same leased worker.

Storage prerequisite: verify the current `company-logos` bucket, its raster MIME limits, service-role
writes and public object reads before applying anything. The older `20261101_company_logos_bucket.sql`
is a reference, not an instruction to rerun it blindly. Its production state is not verified here.
Only the owner runs SQL. Do not apply migrations automatically during deployment.

## What the follow-up adds

- `supabase/migrations/20261123_company_logo_review_state.sql` (NOT APPLIED): per-company owner decisions
  (`hold`, `initials`, `approved`) and rejected image fingerprints (sha256 + reason), enforced by the queue
  functions and by a trigger on `companies`, so no automatic path (TS ingest, Python ingest, sweep, manifest
  claim, retries, verification, late commits) can change a held / keep-initials company or re-select a
  rejected image. It seeds the two #698 review exclusions as holds:
  - Appen `c89af545-4a0d-463d-bcad-f15e796bdfe8`: "white mark invisible on light tile", rejected `57677de0…` (evidence 5f61f24b)
  - Glossier `44f03f3c-899b-488c-a589-cb20c4081cf7`: "faint white logo on light tile", rejected `186020c4…` (evidence 4be15678)
- The worker decodes every candidate and rejects transparent / all-white / faint / speck images before upload
  (`src/lib/companies/logoVisibility.ts`: ≥2% of the tile must have ≥1.5:1 contrast on white, slate-50 and
  #F4F4F5). Such companies get initials.

## Steps (owner)

1. **Apply SQL**: first inspect existing columns/functions and migration history; if missing, run
   `20261122_company_logo_contract.sql`, followed by `20261123_company_logo_review_state.sql` in the
   Supabase SQL editor. Check: `SELECT company_id, decision, reason FROM company_logo_reviews WHERE cleared_at IS NULL;`
   shows the two holds (only rows for companies that exist).
2. **Fresh bounded dry-run** (read-only, uploads nothing): Actions → *Company Logo Repair (gated)* → Run
   workflow, mode `dry-run`, limit `20`, verify `0`. Review the artifact: `summary-*.json` (counts:
   eligible_hosted, intentional_initials, held, pending, failed), `manifest-*.json`, the preview images.
   Held companies never appear in it.
3. **Canary write: only a reviewed manifest, never a queue run.** With `LOGO_REPAIR_ENABLED` still off:
   1. **Make a canary-sized manifest with its own dry-run** (read-only): locally,
      `npx tsx scripts/repair-company-logos.ts --limit 5 --out reports/logo-repair/canary`, or Run workflow
      with mode `dry-run`, limit `5`, verify `0`. The dry-run itself picks at most 5 companies and writes
      `manifest-*.json` plus the exact preview image for each.
   2. **Review that manifest:** every company ID, its current `logo_url` and the proposed image and sha256 in
      the preview. Keep the file unchanged; it is what the write checks.
   3. **Run the exact command that dry-run printed.** It always carries `--manifest <file> --limit <n> --concurrency <c> --verify 0`.
      The write claims only the listed IDs. It skips any company whose `logo_url` changed since the review
      (manifest drift) or whose resolved image no longer matches the reviewed sha256, and it runs no
      verification pass outside the manifest.
   - **Do not use workflow mode `write` for a canary.** It passes no manifest: it claims whatever is at the
     top of the queue (`p_ids: null`), which need not be the companies or images you reviewed. A numeric
     limit is not the same as an exact, reviewed selection.
   - **Do not trim a larger reviewed manifest by lowering `--limit`.** The CLI refuses a manifest with more
     companies than `--limit`. A hand-trimmed copy is a new manifest and needs its own review before any
     write; generating a fresh 5-company dry-run is simpler.
   - Check the run summary has no alerts, then spot-check those exact companies on /jobs at phone width.
4. **Enable** (separate approval, after the canary is verified; scheduled maintenance stays OFF until then):
   set repository variable `LOGO_REPAIR_LIMIT=20`, then `LOGO_REPAIR_ENABLED=true`. Each scheduled
   run (twice an hour) claims at most 20 companies and re-verifies at most 25 hosted logos; holds and
   keep-initials companies are skipped.

## Disable immediately

Set `LOGO_REPAIR_ENABLED` to `false` (or delete it). All workflow writes, including manual writes, require the flag. Manual dry-runs remain available on main.
Scheduled runs stop at the next tick; cancel a running
one from the Actions tab. Any lease it held expires on its own (15 minutes); nothing is left half-written
(commits are conditional on the lease token and the logo the worker read).

## Inspect failures and backlog

- Each run's summary is uploaded as `company-logo-repair-<run id>` (30 days) and logged in `company_logo_runs`.
- `SELECT company_logo_coverage('<project origin>');` gives hosted / intentional_initials / held / approved /
  pending / failed / missing / queued_retries / orphan_links.
- `SELECT id, name, logo_status, logo_failure_reason, logo_attempts, logo_next_attempt_at FROM companies WHERE logo_status IN ('failed','pending') ORDER BY logo_next_attempt_at;`
- The job fails (GitHub alert) on infrastructure errors, a stalled previous run, a rising backlog or no progress.

## Review operations (explicit, reviewer + reason required)

```sql
SELECT set_company_logo_review('<company id>', 'hold',     '<reason>', '<reviewer>');  -- do not touch
SELECT set_company_logo_review('<company id>', 'initials', '<reason>', '<reviewer>');  -- clears logo_url, keeps initials
SELECT set_company_logo_review('<company id>', 'approved', '<reason>', '<reviewer>');
SELECT set_company_logo_review('<company id>', 'clear',    '<reason>', '<reviewer>');  -- lift a decision
SELECT set_company_logo_hash_rejection('<company id>', '<sha256>', 'reject', '<reason>', '<reviewer>');
SELECT set_company_logo_hash_rejection('<company id>', '<sha256>', 'clear',  '<reason>', '<reviewer>');
```

Rows are never deleted; clearing keeps the history (`cleared_at`, `cleared_by`, `cleared_note`). An
`initials` decision stores the previous `logo_url` in its review row for a manual restore.

## Roll back

- **A run's logo changes**: run that run's `rollback-*.sql`. Each line restores the previous `logo_url` only if
  the row still holds that run's value and the company is not under review, so later legitimate changes
  (a newer repair, an owner decision) are never overwritten. Storage objects are versioned and never deleted.
- **This migration**: disable first, then follow the ROLLBACK block at the end of
  `20261123_company_logo_review_state.sql` (re-run `20261122`, then drop the review objects). `companies.logo_url`
  is untouched. Export the review tables first if you want to keep the history.


## Guard-check failures and legacy writer caveat

A shared-image hash query error withholds the candidate before upload in both write and dry-run mode.
The outcome explicitly reports the unavailable guard and a retry time. A pre-migration dry-run cannot
be treated as candidate identity acceptance when that check is unavailable.
The rejected-hash trigger can identify content from versioned keys or logo_hash. A legacy id-only URL
with a null hash cannot identify its bytes. The automatic worker always writes a versioned key plus
hash. Do not introduce legacy/null-hash writers without separate review; holds still apply regardless.
