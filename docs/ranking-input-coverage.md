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
| locationRemoteFit (0.2) | the value rests on observed job data: worldwide-remote eligibility or the remote flag; a country match where the code is a valid, known country; the remote branch (job `remote` true and candidate wants remote/any); or a mismatch between two valid, known countries | `used-neutral-fallback` (50) when the candidate states no country preference; `used-unusable-input` when the value came from missing or invalid country input (see below) |
| recency (0.2) | `postedAt` parses to a valid date | `used-neutral-fallback` (50); missing and unparseable are treated the same |
| salaryListed (0.15) | salary text present (100) | `binary-absent` (0): a real negative signal, not a fallback |

### Status is about evidence, not the number

A factor's status says whether the inputs behind its value were usable. It is never inferred from the value.
The location factor shows why. With a stated country preference, `computeLocationRemoteFit` returns 30 both
for a real mismatch (job `US`, candidate `IN`) and for a job with no country, or with country text that is not
a valid code (`"India"`, `"XX"`). Only the first is observed job data. The second is a default the formula applies
when the input is missing, so it is reported as `used-unusable-input`. That default is not the neutral 50: the
value stays 30 and still counts in the score exactly as before. It is just not counted as coverage.

A country code is valid when it is two letters that the platform's region list (`Intl.DisplayNames`) recognises.
An invalid code also makes a "match" unusable (preferred `XX`, job `XX`: value 100, status `used-unusable-input`).

Statuses:

| status | counts as coverage | meaning |
|---|---|---|
| `used-real-data` | yes | value rests on observed, usable inputs |
| `used-neutral-fallback` | no | neutral 50 because the input is absent |
| `used-unusable-input` | no | value came from a branch whose inputs are missing or invalid; still used in the score |
| `binary-absent` | no | salary's real 0 |

The report never changes the score. The numeric scorer's signature, weights, branches and arithmetic are
unchanged.

`coverageRatio` = sum of the weights of factors with `used-real-data` / total weight, rounded to
4 dp. Salary counts by its 0/100 state, so absent salary adds nothing to coverage.

`inputConfidence` is derived from `coverageRatio` using `RANKING_INPUT_CONFIDENCE_BANDS`:
`high` >= 0.8, `medium` >= 0.45, else `low`. The bands describe **data completeness, not
calibrated probability**. They are not measured or validated against outcomes. Calibrated
thresholds (#61) need human-judged labels first.

Status: not wired into any API payload, feed, cache or UI. A later task does that.
