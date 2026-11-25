# Daily jobs pill: test evidence (PR #769)

Output of `npx vitest run` on the files named below. Fixtures only: no live data.

## New refresh-edge tests on the ORIGINAL hook (743d6d14), before the repair

```
   × Daily jobs pill: refresh failures never leave an old number visible > 42 then 503 on the 5-minute refresh hides the pill 457ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: refresh failures never leave an old number visible > 42 then 429 on the 5-minute refresh hides the pill 324ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: refresh failures never leave an old number visible > 42 then malformed on the 5-minute refresh hides the pill 268ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: refresh failures never leave an old number visible > 42 then prior UTC day on the 5-minute refresh hides the pill 167ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: refresh failures never leave an old number visible > 42 then network error on the 5-minute refresh hides the pill 146ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: refresh failures never leave an old number visible > a hung refresh after success times out: the pill hides, the request is aborted and a retry follows 190ms
     → expected false to be true // Object.is equality
   × Daily jobs pill: Retry-After is honored in full and nothing bypasses it > Retry-After seconds = 600s: no request before the deadline, even on tab return 97ms
     → expected 3 to be 1 // Object.is equality
   × Daily jobs pill: Retry-After is honored in full and nothing bypasses it > Retry-After HTTP-date = 600s: no request before the deadline, even on tab return 103ms
     → expected 3 to be 1 // Object.is equality
   × Daily jobs pill: Retry-After is honored in full and nothing bypasses it > a UTC-midnight revalidation does not bypass an active rate-limit deadline 193ms
     → expected 3 to be 1 // Object.is equality
   × Daily jobs pill: Retry-After is honored in full and nothing bypasses it > repeated invalid data backs off and stops automatic retries (no endless 60s loop) 476ms
     → expected 361 to be less than or equal to 8
   × Daily jobs pill: a count from another UTC day is never shown > tab return after a throttled background (clock past midnight, no timers fired) hides yesterday's number before any response 77ms
     → expected false to be true // Object.is equality
      Tests  11 failed | 1 passed (12)
```

## Same tests after the repair

```
 ✓ src/components/landing/__tests__/DailyJobsPillRefresh.test.tsx (12 tests) 2897ms
   ✓ Daily jobs pill: refresh failures never leave an old number visible > 42 then 503 on the 5-minute refresh hides the pill 640ms
   ✓ Daily jobs pill: Retry-After is honored in full and nothing bypasses it > repeated invalid data backs off and stops automatic retries (no endless 60s loop) 449ms
      Tests  12 passed (12)
```

## Original route tests with only the source mock swapped for the real PostgREST predicate evaluator

The original 'jobspy' fixture set `source`, not `source_type`. VISIBLE_SOURCE_FILTER keys on `source_type`, so the hand-written mock had hidden a fixture mismatch:

```
   × GET /api/stats query bounds and metric truth > excludes inactive, unapproved source or non-active status jobs 28ms
     → expected 1 to be +0 // Object.is equality
      Tests  1 failed | 10 passed (11)
```
