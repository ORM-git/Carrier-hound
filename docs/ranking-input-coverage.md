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

## Proposed calibration analysis (#59 / #61): PROPOSAL, nothing here is shipped

Status: measurement plan only. The bands above stay internal. No confidence label, tier presentation or
threshold ships from this section. Every number below is a **proposal** for the owner to accept, change or reject.

### Blocker found first: two different scorers

- `inputConfidence` describes `computeRecommendedRankingScore`, the browser-side "match" sort
  (`src/app/jobs/page.tsx` via `compareByRecommendedRanking`). Its fit factor needs a confirmed resume `CandidateProfile`.
- The judged harness (#62, `src/lib/eval/rankingEval.ts`, package in #782) measures the server ranker
  `rankJobsByRecommendation`, which takes `OnboardingAnswers`.

Grouping one scorer's judged relevance by the other scorer's coverage would measure nothing. So, before any grouping:

1. **Pick the scorer under test.** Either (a) add `CandidateProfile` + preferences to the judged profiles and
   evaluate `computeRecommendedRankingScore`, or (b) define coverage for `rankJobsByRecommendation`'s own inputs.
   This is an owner/ranking-lane decision. No code is written for either yet.

### Proposed method (after step 1 and after #782 judging is complete)

2. For every judged (profile, job) pair, compute `coverageRatio` with the chosen scorer's coverage report.
   Use the pair's own inputs at the dataset's `referenceTime`.
3. Group the pairs. **Proposal:** group by each reachable `coverageRatio` value (every subset sum of the weights 0.45, 0.2, 0.2, 0.15),
   not by the current bands, so the bands are tested rather than assumed.
4. For each group, report: pair count, number of profiles, mean effective grade, precision of the ranker's top-k
   inside the group (`RELEVANT_MIN_GRADE` = 2, as in `rankingMetrics.ts`), and score-vs-grade agreement
   (does a higher score mean a higher grade within the group).
5. Report each group's numbers with their count. Mark a group "insufficient" instead of quoting a number when it
   is too small. **Proposal only:** the minimum group size is left to the owner. This doc does not set one.
6. A label is justified only where adjacent groups differ by more than their measured spread. Any band boundary
   would sit at such a measured break, never at an assumed split. (The 40/25/20/10/5 split in the ledger is an
   illustration, not an input.)

### Constraints that already apply

- Numeric score is paid-only (owner, 24 Nov). Any future confidence presentation is Pro-only by the same rule,
  and is still held until the owner authorizes it.
- The synthetic `human-judging-v1` package (#782) has no labels yet ("judging pending"). Until humans fill it,
  this analysis measures nothing and must not be quoted.
