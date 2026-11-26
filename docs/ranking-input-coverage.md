# Ranking input coverage (checklist #59)

`computeRankingInputCoverage(job, candidate, preferences, now)` in `src/lib/matcher/scoring.ts`
takes the same inputs as `computeRecommendedRankingScore` and reports, per factor, whether the
score used real data. Both functions read factor values from one internal function, so the
report always describes the score that was actually computed. The numeric score is unchanged.

**This measures input coverage only.** It says how much of the formula had real data. It says
nothing about whether the recommendation is accurate or relevant. Accuracy is measurable only
through the judged evaluation harness (#62, `docs/ranking-eval.md`).

| Factor (weight) | `used-real-data` | Otherwise |
|---|---|---|
| fitScore (0.45) | confirmed resume (`confirmedAt`) and fit diagnostics returned a number | `used-neutral-fallback` (50) |
| locationRemoteFit (0.2) | worldwide-remote job, or a stated country / remote preference | `used-neutral-fallback` (50) |
| recency (0.2) | `postedAt` parses to a valid date | `used-neutral-fallback` (50); missing and unparseable are treated the same |
| salaryListed (0.15) | salary text present (100) | `binary-absent` (0): a real negative signal, not a fallback |

`coverageRatio` = sum of the weights of factors with `used-real-data` / total weight, rounded to
4 dp. Salary counts by its 0/100 state, so absent salary adds nothing to coverage.

`inputConfidence` is derived from `coverageRatio` using `RANKING_INPUT_CONFIDENCE_BANDS`:
`high` >= 0.8, `medium` >= 0.45, else `low`. The bands describe **data completeness, not
calibrated probability**. They are not measured or validated against outcomes. Calibrated
thresholds (#61) need human-judged labels first.

Status: not wired into any API payload, feed, cache or UI. A later task does that.
