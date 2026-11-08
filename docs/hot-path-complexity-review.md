# Hot-path complexity review (Backend sheet row: Big-O Hot-path Review)

Status: a code-reading review of one hot path, the job listing and match ranking in `src/lib/jobs/service.ts`. It
changes no code. Nothing here was measured, so no timing claim is made. The row stays PARTIAL: it covers one path,
and a full review of every route is not done.

Existing measurement tools (not complexity analysis): `scripts/benchmark-query.ts` times a 500-row and a 100-row
jobs query, `scripts/k6-smoke.js` and `scripts/loadtest/cm-load.js` send read-only load to public pages and
`/api/stats`, and `docs/slo.md` and `docs/capacity-headroom.md` hold the targets and reporting.

## Path 1: match-sorted job search (`getLiveJobs`, `sortBy: "match"` with a candidate)

Let P be the candidate pool (fixed at 250 rows by `.range(0, 249)`), and T the number of relevance terms (at most 10,
from `.slice(0, 10)` in `extractCandidateRelevanceTerms`).

| Step | Cost | Bounded by |
| --- | --- | --- |
| Database query for the pool (ilike filters, order by `posted_at`) | One round trip. Cost depends on the database plan and indexes, not visible here | `.range(0, 249)` |
| Score each pool row (`computeFitDiagnostics` in `src/lib/matcher/scoring.ts`) | P calls. The cost of one call was not analyzed here, so the total is P times that unmeasured cost | P is capped at 250 |
| Sort by score then recency | O(P log P) | P is capped at 250 |
| Cap jobs per company (`capJobsPerCompany` in `src/lib/jobs/capping.ts`) | O(P), one pass with a map | P is capped at 250 |
| Slice for the requested page | O(page size) | the page size |

Reading: the in-process work is bounded by the 250-row pool, so it does not grow with the size of the jobs table.
The part that can grow is the database query: `title ilike '%term%'` filters cannot use a normal b-tree index, and
the number of OR terms follows the candidate's terms, which are capped at 10.
Whether an index or a trigram index exists and is used is a database fact, not shown in this review (owner to
confirm with a query plan, see below).

## Path 2: full active pool (`getAllActiveJobs` / `loadAllActiveJobs`)

- Fetches a count, then up to 3 chunks of 1000 rows in parallel (`Math.min(..., 3)`), so memory and transfer are
  capped at about 3000 rows. Mapping each row is O(rows).
- If active jobs exceed 3000, the extra rows are not loaded. That is a coverage limit, not a time limit.

## Path 3: top ranked jobs (`getTopRankedJobsForCandidate`)

- Pro only (returns an empty list otherwise). It first posts to `/api/jobs/top10`. The fallback calls `getLiveJobs` with `pageSize` of at least 25, then scores and sorts
  the returned rows: O(n log n) for n at most the page size. Bounded by Path 1 plus a small sort.

## Things worth a closer look (not changed here)

1. Path 1 scores 250 rows on every match-sorted request. A cache for repeated identical candidates would cut that
   work, but it would be a behavior change and is a separate decision.
2. The OR of `ilike` terms is the likely database cost. Check with `EXPLAIN (ANALYZE)` on a copy or the owner's
   database before adding any index (owner step, no change made here).
3. `loadAllActiveJobs` makes 1 + up to 3 queries per call. Whether callers cache it is not covered here.

## What stays unproven

- Any real timing, query plan or index use. The benchmark and k6 tools measure speed but were not run for this doc.
- Other hot paths (AI routes, cron jobs, admin lists) were not reviewed.
- The numbers 250, 3000 and 1000 are copied from the current code and may change.

## Owner steps

1. Run `scripts/benchmark-query.ts` against a safe database and record the output privately.
2. Run `EXPLAIN (ANALYZE)` for the jobs filter with the owner's own query access, and decide on any index through
   the normal migration process.
3. Ask for the next path to review (AI routes or cron work) if wanted.
