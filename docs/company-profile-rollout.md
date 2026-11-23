# Company-tab enrichment: owner rollout pack

This pack covers what you need to choose 1 to 3 companies and review exactly what a production canary would change, **before** approving any write.
Nothing here has been run against production. No production SQL, enrichment, canary write, merge or deploy was done.

## 1. Code and schema baseline (checked 23 November 2026)

| Ref | SHA | What it holds |
|---|---|---|
| `main` | `3140f3e0ea16f02a16695e7099b4a0816c58b2c2` | None of the Company-profile work below. |
| PR #700 `codex/company-tab-profile` | `d9bc850bc13153ac5a64f226f2682bf553ae6ff4` | Profile types, Pro-only API, UI, migration `20261122a`, safe fetch, extraction, batch CLI (local/staging writes only), and the later Company-tab visual fixes. |
| PR #704 `feat/company-profile-canary` | `18ad0231cc2cc776576b49793f6054f72e2d1de7` | The separately gated production canary (at most 3 explicit IDs, reviewed plan, journaled write/resume/rollback). Based on #700's older `861a86c7`, so it lacks #700's last two visual commits. |
| This branch `feat/company-profile-planner` | see PR | #704's head, plus a merge of #700's `d9bc850b` (clean, no conflicts), plus this follow-up. It contains both sets of work unchanged. |

Merge order: #700, then #704, then this branch. Or merge this branch alone, since it contains both.
**Being in a branch is not being live.** The site shows the older Company section until this code is merged and deployed.

### Schema: owner-reported state, not verified here

- You reported that the profile tables exist in production and are empty. That has not been independently checked.
- #704's canary doc said "not applied". It now points here instead.
- **Do not rerun the migration to find out.** Run the read-only preflight instead:
  `supabase/scripts/preflight-company-profile-20261122a.sql` (SELECT only).
  - **Statement 1** checks every expected column (type and nullability), the primary keys, unique and check constraints, foreign keys, the leadership identity index (`NULLS NOT DISTINCT`), both observation functions (pinned `search_path`, timestamp-only conflict update), function and table grants (service_role only), and RLS. Every row should say `ok = true`.
  - **Statement 2** gives exact row counts.
- **If every check passes:** the existing migration is what production has. No schema change is needed, and this branch adds none.
- **If any check fails:** send the output. A new, separate migration would be written for the specific gap. The applied migration file is never edited.

## 2. What this branch adds

- **Read-only inventory and candidate planner**
  - Files: `src/lib/company-profile/inventory.ts` and `scripts/inventory-company-profiles.ts`.
  - It selects companies, ATS boards, active-job counts and existing profile rows, in UUID order with a resumable cursor.
  - **It never fetches a company page**, and its store has no write methods.
  - It refuses `--write`, `--production`, `--company-ids` and every other unknown flag. It refuses to write its output inside the repository.
- **Plan review summary**
  - File: `src/lib/company-profile/review.ts`.
  - #704's dry-run now also writes `<plan>.summary.md` beside the JSON plan. It lists the sources (URL, final URL, status, time, bytes, sha256), every proposed fact, leader and news item with its source and dates, the zero-yield reason for each empty section, and the actions by table.
- **Read-only schema preflight**, described above.
- **Crawl hardening** (shared by the batch path and the canary)
  - A homepage that redirects to a different site now stops with `off_domain_redirect`. Before, subpage links were resolved against the other host and fetched there; identity checks still rejected that content. `www.` to apex redirects are unaffected.
  - News whose `datePublished` is more than one day after the fetch time is rejected, along with invalid dates, which were already rejected.
- **UI**: the Company card labels the job's location as "Job location:", so it cannot be read as company HQ. HQ appears only as the sourced fact.

Unchanged: the batch CLI's production refusal, the canary's 3-company cap and every gate, write, resume and rollback behaviour, Pro-only authorization, public masking and the #700 visual fixes.

## 3. What the current safe parser can and cannot find

Content is taken only from the company's own site, and only when identity is proven:

- **Identity**
  - The homepage at the stored canonical domain must link to one of the company's **enabled** ATS boards.
  - It must carry schema.org `Organization` structured data whose name or URL matches the company.
- **Facts**: overview, website, HQ, founded year, employee range and LinkedIn/X links, from that Organization data only.
- **Leadership**: a schema.org `Person` with an executive job title, affiliated with that Organization, on an `about`, `leadership`, `team` or `management` page.
- **News**: a schema.org `NewsArticle` or `Article` with a real `datePublished`, on a same-host `news`, `press`, `stories`, `blog` or `report` page.
- **Bounds**: robots.txt and the homepage, plus at most 3 same-host subpages. Each is spaced 1 second apart, retried at most twice on 5xx or timeout, and never retried on 429 or 403. DNS is pinned, each redirect is revalidated, and type and size are capped.

Expect many companies to yield **facts but no leadership or news**, because most sites do not publish that structured data. A verified homepage is not evidence that leaders or news exist. The plan summary states the reason for each empty section.
Never used: logged-in pages, paywalls, search snippets, third-party biographies, guessed executives or headcounts, or paid data providers.
Any extraction expansion (for example dated RSS items for news) would be a separate change with its own tests and the same provenance and affiliation checks. It is not part of this branch.

## 4. Reading the inventory

The JSON report includes `definitions` for every category. Categories **overlap**: one never-enriched company counts in `stale`, `never_enriched` and all three `missing_*` columns.

- **Company counts** count companies. **Row counts** count fact, leader, news and refresh-state rows.
- **An empty section is coverage, not a failure.** `error` means a company's stored rows could not be read or validated; the inventory never crawls.
- **Eligible** means a usable, unique domain, at least one enabled ATS board, and a refresh that is due.
- **Review queue**: missing or invalid domains, and domains shared by two company rows. These are fixed or confirmed by hand. A domain is never inferred from the company name.
- **Holds**: fresh (the canary would skip it), refresh not due (a recent failure is cooling down), no enabled ATS board, or an error.
- **Ranking** (shown in every report):
  1. More active jobs first.
  2. More missing sections first.
  3. Never enriched, then oldest successful refresh.
  4. UUID ascending, as a stable tie-break.

  This uses only existing data. No usage tracking was added.
- **Requests per company**: 2 minimum (robots.txt and homepage), 5 maximum (plus 3 subpages), 15 with every retry.
- **Proposed source URLs** before the plan are `https://<domain>/robots.txt` and `https://<domain>/`. The subpages become known only in the read-only plan.

Examples generated from synthetic fixtures (a test rebuilds them byte-for-byte): `scripts/fixtures/company-profile/inventory-example.json` and `.summary.md`, and `canary-plan.json` with `canary-plan.summary.md`.

## 5. Staged rollout (owner-run; placeholders only)

Run from a **clean checkout of the reviewed commit**. You supply credentials in your shell environment; never put them in a file, a command line or a ticket.
Keep inventories, plans and journals **outside** the repository (for example `../canary/`).

```sh
git clone <REPO_URL> carrier-hound-review && cd carrier-hound-review
git checkout <REVIEWED_COMMIT_SHA> && npm ci
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: provided by the owner in this shell only

# 0. Schema preflight (read-only): run supabase/scripts/preflight-company-profile-20261122a.sql in the SQL editor.

# 1. Inventory (read-only: selects only, no crawl). Repeat with --after-id <next_cursor> to page on.
npx tsx scripts/inventory-company-profiles.ts --limit 500 --shortlist 10 --out ../canary/inventory-<DATE>.json

# 2. Owner selection: read ../canary/inventory-<DATE>.summary.md and pick 1 to 3 UUIDs by hand.
#    The shortlist is a suggestion; nothing reads it automatically.

# 3. Read-only canary plan (zero writes; fetches only the selected companies' official pages)
export COMPANY_PROFILE_ENV=production
npx tsx scripts/enrich-company-profiles.ts --production --target-project szakevhxhwpeskidvtfs \
  --max-companies <N> --company-ids <UUID_1>[,<UUID_2>[,<UUID_3>]] --plan-out ../canary/plan-<DATE>.json
#    Review ../canary/plan-<DATE>.summary.md and the JSON. Approve the exact IDs and the printed plan_digest, or stop.

# 4. Owner-approved canary write (only after step 3 is approved, before the plan expires)
npx tsx scripts/enrich-company-profiles.ts --production --target-project szakevhxhwpeskidvtfs \
  --max-companies <N> --company-ids <SAME_UUIDS> \
  --write --plan ../canary/plan-<DATE>.json --confirm-digest <PLAN_DIGEST> --journal ../canary/journal-<DATE>.json

# 4b. Resume after a stopped write, once the cause is fixed: same as step 4 with --resume instead of --write.

# 5. Conditional rollback: same as step 4 with --rollback instead of --write.
```

- **Step 4 fails closed** if the plan was edited or has expired, or if the target, code SHA, schema, current rows or any source page (final URL, status, sha256) changed. In that case, generate and review a new plan. Do not loosen the check.
- **The canary is not atomic.** A stopped write leaves earlier steps applied, and the journal records them.
- **Rollback** removes or restores only rows that still hold the canary's values. It does **not** restore rows someone else changed since; it reports those as `skipped_drifted`.

### 6. Verify, then stop

1. **Database (read-only):**
   ```sql
   SELECT 'facts', count(*) FROM public.company_profile_facts WHERE company_id = ANY('{<UUIDS>}'::uuid[])
   UNION ALL SELECT 'leadership', count(*) FROM public.company_profile_leadership WHERE company_id = ANY('{<UUIDS>}'::uuid[])
   UNION ALL SELECT 'news', count(*) FROM public.company_profile_news WHERE company_id = ANY('{<UUIDS>}'::uuid[]);
   ```
   The counts should match the plan's actions.
2. **Sources:** open each proposed source URL and confirm the value really is on the company's own page.
3. **Live site, after the reviewed code is deployed:** open an active job for each canaried company.
   - As **Pro**: the Company tab shows the facts, leaders and news with clickable sources and dates. Empty sections stay empty. The job location is labelled "Job location", not HQ.
   - As **free and guest**: no company details are shown, and the public job response carries no `companyProfile`.
4. **Stop.** A larger batch, a refresh schedule or a cron needs a separately reviewed design, explicit limits and new approval.

## 7. Status

**DONE (in this branch, offline):**
- Reconciled #700 and #704 into one branch.
- Read-only schema preflight.
- Read-only inventory and ranked shortlist with a resumable cursor.
- Plan review summary.
- Off-site redirect stop and future news-date rejection.
- "Job location" label.
- Tests on a disposable PGlite database with the real migration:
  - inventory: pagination and resume, stable ranking, missing and ambiguous domains, disabled or absent ATS boards, coverage categories, error isolation, redaction, zero writes
  - preflight: passes on the migrated schema, fails on missing or drifted ones
  - crawl outcomes: 429, robots, network failure, off-site redirect
  - invalid and future news dates
  - suggestions cannot authorize a canary
  - the batch path still refuses production
- All of #704's canary tests still pass.
- Viewport screenshots from synthetic local data.

**NOT DONE:** no production inventory, plan, write or verification. No merge, deploy, applied SQL, schedule or extraction expansion. Coverage in production is unknown; no completion percentage is claimed.

**OWNER ACTION:**
1. Review and merge #700, #704 and this branch, or this branch alone.
2. Run the preflight and share statement 1's result.
3. Deploy the reviewed SHA.
4. Run the inventory.
5. Pick 1 to 3 UUIDs.
6. Run the read-only plan and review it.
7. Approve the exact IDs and digest, or stop.
8. Run the canary.
9. Verify the database, the sources and the live Company tab as Pro, free and guest.
