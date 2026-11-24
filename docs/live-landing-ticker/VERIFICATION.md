# Live landing ticker

Base main: `148a5ef118ea83dc5561e8c5520ff2579d5bf038`. Separate from the job-detail follow-up PR.

## Cause

Production homepage used a hardcoded sample strip: Lumen Labs, Northwind and fixed relative times. The existing live ticker component/API was not wired to that strip. Neither current landing runtime fetched the endpoint.

Read-only production checks on November 24 at 16:07 IST:
- https://careermonke.com/api/ticker returned HTTP 200, 20 active jobs, newest posted at 12:45 IST today. Cache policy is 60 seconds with a 300-second stale-while-revalidate window. This does not support a claim that the ingest cron stopped.
- Only 2 of those 20 rows carried stored logo URLs, both for Databricks. The distinct stored PNG returned HTTP 200. That is not universal logo coverage.
- https://careermonke.com/api/jobs/search?page=1&pageSize=25 returned 25 masked public jobs with no logos, as intended for guest/free access. Paid-feed logo coverage was not measured from this endpoint.

## Fix

Only the strip's sample children change. Its `.ls`, `.ls-track`, `.ls-set`, `.ls-card`, `.ls-logo`, `.ls-txt`, `.ls-meta`, `.ls-title` layout and existing stylesheet are retained. Placement stays between stats and comparison. No surrounding landing copy/style changes.

A client component fetches the validated public endpoint on mount, every five minutes while visible, and when the tab becomes visible. Reads are single-flight, timed out after ten seconds, and aborted on unmount. Failed/short/malformed data clears rows rather than retaining stale data or inventing fallback jobs. The outer strip retains its space when no data is available.

Only HTTPS Supabase company-logo bucket URLs can render. Initials remain during loading and on missing/broken/blocked images. No logo discovery or repair is enabled. Real rows and current relative times replace the fixed sample entries. Duplicate animation groups stay out of keyboard navigation and are hidden from assistive technology.

## Verification

- Full unit suite: 353 + 404 + 410 + 424 = 1,591 tests / 164 files, all pass.
- Five new component cases cover initial fetch, exact class skeleton/duplicate accessibility, refresh replacing old data, outage clearing rows, missing/broken/unsafe logos, hidden-tab/visibility behavior, timer/listener cleanup and abort.
- Typecheck passes. Lint: 0 errors / 252 existing warnings.
- Both landing parity scripts pass. All 41 prior negative controls remain, plus two new controls reject missing ticker/wrapper redesign, 43 total. Ticker API paging and strip checks and landing stats checks pass.
- Browser fixture at 360/390/768/1440 verifies 84/104px strip height, unchanged class layout, moving animation, loaded image and broken/missing-image initials, duplicate count and no page overflow. Mobile 360 and desktop 1440 pixels were directly inspected. Synthetic job data and a synthetic white test PNG only, never proof of actual company logo content.
- No full local build claimed. New exact-head CI and independent review remain required.

No production account or DB writes, ingestion, schema changes, repair loop, backfill, cron changes, payments or deployment were performed.
