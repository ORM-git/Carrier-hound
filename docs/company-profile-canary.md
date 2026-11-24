# Company-profile production canary

A separately reviewable path for enriching **at most 3 explicitly chosen companies** in production.
It is off unless every production flag below is given. The local/staging batch path
(`--max-rows`, `--after-id`, `isAllowedCompanyProfileWriteTarget`) is unchanged and still refuses production.

> **Status:** the owner reports the `20261122a_company_profile_data` tables exist in production and are empty.
> That is owner-reported, not verified: confirm it with the read-only preflight in
> [company-profile-rollout.md](company-profile-rollout.md) before any plan. No profile data is populated, and this
> canary has **not been executed**. Nothing here authorizes running it. Candidate selection is in that rollout pack.

## Who decides what

- **The owner** picks the company UUIDs, reviews the plan, and approves the write. The tool never chooses companies.
- **The plan digest** is an interlock that proves the reviewed file is the one being written. It is **not** consent;
  do not run `--write` until the owner has approved that exact digest.

## Gates (all required, checked before any database call)

| Gate | Requirement |
|---|---|
| Mode | `--production` (the batch path's `--write` alone never reaches this code) |
| Target | `--target-project szakevhxhwpeskidvtfs` exactly, `COMPANY_PROFILE_ENV=production`, and the loaded Supabase URL must be exactly `https://szakevhxhwpeskidvtfs.supabase.co`. The target is never inferred from credentials; naming production `staging` fails both guards. |
| Selection | `--company-ids <uuid[,uuid…]>` plus `--max-companies N` (1–3). Absent, malformed, duplicate or over-cap IDs are refused, as are `--after-id`, `--max-rows`, `--all`, positional args and any unknown flag. Only those exact IDs and their **enabled** ATS boards are queried. |
| Code | In a git checkout: a clean HEAD (tracked files), optionally confirmed with `--code-sha`. Outside git: `--code-sha <40-hex>` is required. The write refuses a plan made by another SHA. |

## 1. Dry-run plan (default; zero writes)

The plan uses the same crawl as the batch path: `safeFetchCompanyPage` (DNS-pinned, validated redirects),
robots.txt, ATS-evidence linkage, first-party verification, freshness, provenance and the existing
retry/throttle backoff. The store is wrapped read-only.

The plan file contains:

- **Binding:** `target_project`, `company_ids`, `max_companies`, `code_sha`, `schema_version`, `created_at`, `expires_at` (24h by default, `--ttl-hours` up to 72).
- **Sources:** every official URL fetched, with its final URL, status, fetch time, byte count and sha256.
- **Per company:** ATS boards, freshness, outcome (`verified`, `cache_hit`, `no_ats_evidence`, `robots_disallowed`, `off_domain_redirect`, `not_ats_linked`, `not_verified` or `fetch_failed` with a redacted error), proposed facts/leadership/news, and **all current rows** in the four profile tables.
- A readable `<plan>.summary.md` is written beside the JSON plan (sources, proposed rows with provenance, zero-yield reasons, actions by table).
- **Actions:** numbered `insert` / `update` steps with the exact before-image and after-row.
- `plan_digest`: sha256 of the canonical plan.

It contains no keys, no service URL and no env values; the CLI refuses to write a plan that contains a credential.
See `scripts/fixtures/company-profile/canary-plan.json` for a synthetic example; a test rebuilds it byte-for-byte.

## 2. Write (owner-approved only)

`--write --plan <file> --confirm-digest <digest> --journal <file>` revalidates before any change and **fails closed** on:
a modified plan (digest mismatch), a wrong `--confirm-digest`, an expired plan, a different target, schema version,
code SHA, company IDs or cap, an action outside the allowlist, missing schema columns, **any** change to the
companies' current profile rows (stale baseline), or any official source whose final URL, status or sha256 changed (source drift).
Pages with per-request content (nonces, timestamps) will always drift, so those companies cannot be canaried.

Then it writes **only the reviewed rows** from the plan. It does not re-extract. Each step is one conditional statement:
an insert, or an update `WHERE` every column still equals the reviewed before-image.
Leadership and news rows keep their sourced fields; only `retrieved_at` moves forward, the same rule as the observation RPCs.
Refresh state is written last per company and marks success only after that company's data rows.
Companies with no actions (a cache hit, no evidence, or not verified) get no writes at all, not even an attempt-state row.

### Not atomic

No transaction spans the steps; the canary adds no RPC or migration. It is safe to stop at any point because of the journal:

- Before each change, the step's before-image and after-row are appended to `--journal` and fsynced (write-ahead).
- On failure, the step is marked `failed` with a redacted error and the run stops with a non-zero exit. Earlier steps stay applied.
- `--resume` (same plan, digest and journal) skips steps whose row already equals the after-row. That includes a write
  that landed but whose response was lost. It applies the rest with the same compare-and-set and stops on any drift.
  Resume still enforces expiry, target, SHA, schema and source checks.

A transactional apply would need a new SQL function and migration. That is **not** included and needs separate approval.

## 3. Rollback

`--rollback --plan <file> --confirm-digest <digest> --journal <file>` walks the journal in reverse:

- **canary-inserted row** → deleted only if it still equals what the canary wrote (`removed`)
- **updated row** → restored to its before-image only if it still equals what the canary wrote (`restored`)
- **row changed by someone else since** → left alone and reported as `skipped_drifted`
- **step never applied** → `not_applied`; reruns report `already_absent` / `already_restored`

Rollback works after the plan expires and from a different code SHA, but still needs the digest, the target gates
and a journal that matches the reviewed plan step for step. Results are appended to the journal. A resume after a rollback is refused.

## Owner-run commands (placeholders; do not run without approval)

Run from a clean checkout of the reviewed commit, with production credentials supplied by the owner in the shell environment, not in a file.

```sh
export COMPANY_PROFILE_ENV=production
# SUPABASE_URL=https://szakevhxhwpeskidvtfs.supabase.co and SUPABASE_SERVICE_ROLE_KEY provided by the owner

# 1. Dry-run: writes nothing, produces the plan for review
npx tsx scripts/enrich-company-profiles.ts --production --target-project szakevhxhwpeskidvtfs \
  --max-companies 2 --company-ids <COMPANY_UUID_1>,<COMPANY_UUID_2> \
  --plan-out ../canary/plan-<DATE>.json

# 2. Only after the owner approves the plan and its digest
npx tsx scripts/enrich-company-profiles.ts --production --target-project szakevhxhwpeskidvtfs \
  --max-companies 2 --company-ids <COMPANY_UUID_1>,<COMPANY_UUID_2> \
  --write --plan ../canary/plan-<DATE>.json --confirm-digest <PLAN_DIGEST> --journal ../canary/journal-<DATE>.json

# 2b. After a stopped write, once the cause is fixed
#     (same command as step 2 with --resume instead of --write)

# 3. Undo (same arguments, --rollback instead of --write)
npx tsx scripts/enrich-company-profiles.ts --production --target-project szakevhxhwpeskidvtfs \
  --max-companies 2 --company-ids <COMPANY_UUID_1>,<COMPANY_UUID_2> \
  --rollback --plan ../canary/plan-<DATE>.json --confirm-digest <PLAN_DIGEST> --journal ../canary/journal-<DATE>.json
```

Outside a git checkout, add `--code-sha <REVIEWED_COMMIT_SHA>` to every command.
Keep plan and journal files outside the repository and retain the journal: it is the rollback manifest.

## Step D: Wikidata as a second source (owner decisions 2026-11-24)

Every production plan now also asks Wikidata (CC0) about each allowlisted company. This uses the same plan, digest, source-drift, journal, write and rollback contract as above.

- **Why:** the official-site parser proves identity only when the homepage links the company's ATS board. For OpenAI, Stripe, Anthropic, Cloudflare and Datadog it stopped at `not_ats_linked`; MongoDB's fetch timed out. Six plans, zero rows.
- **Identity:** a name-search candidate counts only if its official website (P856) is **the homepage** of the stored domain: same host, and a root path. Exactly one candidate may match; otherwise the outcome is `no_match` or `ambiguous` and nothing is used. Product entities on the same host (for example `openai.com/sora`, `www.anthropic.com/claude`) never count.
- **What is stored:** only what a statement states, with `source_url = https://www.wikidata.org/wiki/Q…`, `source_kind = 'wikidata'` and `retrieved_at`:
  - overview (the English description), website, founded year (P571, year precision or finer), headquarters (P159), employee band (P1128, the statement with the latest P585 date, which becomes `observed_at`)
  - X (P2002) and LinkedIn (P4264)
  - `funding_stage`, only when a listing (P414) has a ticker, for example "Public (NASDAQ: X)". No listing is **not** stored as "private".
  - Leaders: the current CEO (P169 without an end time) and founders (P112) that are instances of human (Q5).
  - Two different values with no preferred rank is ambiguity, and is dropped. Deprecated statements are ignored.
- **Official sources win:** Wikidata fills only fact keys that no official row or observation covers, and never creates a conflict with an official value.
- **Requests:** at most 4 + one per founder per company (at most 6 founders), 1 second apart, through the DNS-pinned transport, locked to `https://www.wikidata.org/w/api.php`. The descriptive User-Agent is `CareerMonkeBot/1.0 (https://careermonke.com; company-profile enrichment)`. No retry on 403/429; a failure is a redacted `fetch_failed` with zero actions. Wikidata's robots.txt blocks crawlers from `/w/`; the owner approved Action API use under Wikidata's data-access policy.
- **Not included:** Google News RSS (`news.google.com/robots.txt` disallows `/rss`) and DOL H-1B data (dol.gov returns 403 to automated requests; the owner chose to skip it).
- **Schema precondition:** migration `20261124a_company_profile_wikidata.sql` (owner-run) widens the facts allowlists. Until it is applied, the database refuses the first Wikidata row; the write stops there and journals it.
- **Read-only pre-canary report:** this needs no database and no credentials. Names and domains come from an inventory file:
  `npx tsx scripts/report-company-wikidata.ts --inventory ../canary/inventory-<DATE>.json --company-ids <UUID>[,…] --out ../canary/wikidata-report-<DATE>.json`
- **Company tab:** Wikidata values show "Wikidata" as their source, and `funding_stage` shows as "Funding". Industry tags are derived deterministically from the description, or from at least 3 job titles, and are labelled as derived. Empty sections stay hidden.

## Verification (offline)

`src/lib/company-profile/__tests__/enrichment.test.ts` runs on mocked official pages and a disposable in-memory Postgres
(PGlite, with the real migration). It covers:

- the old production refusal and the exact production identity
- allowlist and cap failures
- the code-SHA rules
- zero-write dry-run
- tamper, expiry, wrong project, SHA, IDs, cap and schema version
- an action outside the allowlist
- source drift, stale baseline and missing schema
- duplicate observations
- mid-canary failure and resume, including a lost response
- conditional and partial rollback
- redaction

No live company page or database is contacted.
