# Offline ranking-quality evaluation (checklist #62, harness only)

Status: **harness implemented; real-world ranking quality is NOT yet measured.** The only dataset is synthetic
(`scripts/eval/ranking/synthetic-v1.json`, labels written by the harness author). It proves the harness runs the
production ranker and computes metrics correctly. It is not evidence that real users get good recommendations.

Run (offline: no database, network, ingestion or writes outside `--out`):

```
npx tsx scripts/eval-ranking.ts [--dataset scripts/eval/ranking/synthetic-v1.json] [--split eval] [--out out/ranking-eval]
```

The command writes `ranking-eval-<version>-<split>.json` (machine-readable) and `.md` (report) to `--out`, and prints
the report. Output is deterministic for a given dataset and checkout: there is no wall-clock field, and scoring uses
the dataset's `referenceTime`. Tests: `npx vitest run src/lib/eval`.

## What is evaluated

`src/lib/eval/rankingEval.ts::rankLikeRecommendedFeed` runs the same steps as `/api/jobs/recommended`:
`rankJobsByRecommendation(pool, answers, referenceTime)`, then the `matchScore > 0` filter for personalized answers,
then `capJobsPerCompany(…, 3, 30)`. Production weights, filters, eligibility and ordering are used unchanged.
SQL candidate selection, pagination and Pro hydration are out of scope: the dataset supplies each profile's candidate pool.

## Dataset format (`EvalDataset`)

| field | meaning |
|---|---|
| `version` | dataset version string, used in output file names and reports |
| `synthetic` | `true` for author-made fixtures; the report then states the numbers are not quality evidence |
| `referenceTime` | ISO instant the ranker scores at (recency is time-dependent) |
| `jobs[]` | `id` plus scorer inputs exactly as stored on `public.jobs` (`title`, `company`, `category`, `location`, `country_code`, `remote`, `remote_scope`, `remote_eligibility`, `job_type`, `posted_at`, salary fields, `description`, `skills`) |
| `profiles[].id` | stable profile/query id (never a real user id) |
| `profiles[].split` | `"eval"` (held-out) or `"tuning"`. The command evaluates one split at a time; never tune on `eval` |
| `profiles[].answers` | the ranker's input: `OnboardingAnswers`, including optional `resumeProfile` signals (`jobTitles`, `skills`, `preferredRoles`). Use paraphrased or synthetic signals, never a real private resume |
| `profiles[].candidates` | job ids the ranker ranks for this profile (the judged pool) |
| `profiles[].labels` | `jobId -> { relevance?: 0-3, eligibility?: "eligible" \| "ineligible" }`. A missing entry or field means **unjudged / unknown** |
| `profiles[].labelProvenance` | who labelled and how, e.g. `synthetic-author` or `human-judge:recruiter#2, 2026-12-01, guideline v1` |

The dataset is rejected (not guessed at) when it has duplicate job, profile or candidate ids, labels for
non-candidates, grades outside 0-3, unknown eligibility values, a missing provenance, or a bad `referenceTime`.

## Metrics (K = 10)

- **Effective grade**: the relevance grade, but 0 when the job is labelled `ineligible`.
- **NDCG@10**: gain `2^grade − 1`, discount `1 / log2(position + 1)`, with positions starting at 1. Computed on the
  *condensed list*: the ranking with unjudged jobs removed, then the first 10. The ideal ranking is every judged pool
  job sorted by effective grade. **Undefined** when the pool has no relevant label (ideal DCG 0); reported as `n/a`, not 0.
- **Precision@10**: jobs with effective grade ≥ 2 among the first `min(10, n)` condensed results, divided by `min(10, n)`.
  Short lists are not padded; the denominator is printed. Undefined when no returned job is judged.
- **Eligible recall**: pool jobs labelled `eligible` *and* graded ≥ 2 that the ranker returned anywhere, divided by all
  such pool jobs. The denominator is printed. It covers the judged pool only, never corpus recall. Undefined when the
  pool has no eligible relevant job.
- **Hard-filter violations**: returned jobs labelled `ineligible`, counted in the top 10 and anywhere.
- **Duplicates**: a repeated id counts once and is listed. **Ties**: adjacent equal scores in the top 10 are counted;
  the order shown is the ranker's own deterministic tie-break.
- **Unknown labels**: unjudged results in the top 10 are counted and excluded from NDCG and precision. They are
  never treated as irrelevant.
- **Macro**: the mean over profiles where a metric is defined, with included and undefined counts.

The harness sets no quality threshold and has no pass/fail on metric values.

## Next step: a human-judged held-out set

Data needed (none of it exists yet):

1. **Profiles.** 30 or more anonymized profiles covering target roles, levels (intern to lead), work models and
   countries, built from saved preferences plus paraphrased resume signals. No names, contact details or raw resume text.
2. **Candidate pools.** About 20-40 jobs per profile drawn from real `public.jobs` rows: the top of the current ranking,
   a sample of rows the gate filtered out, and random same-field rows, so recall is not judged only on what the ranker
   already chose.
3. **Labels.** Each (profile, job) pair graded independently by at least two judges, using the template below. Record
   disagreements and use adjudicated grades.
4. **Split.** Freeze an `eval` split before any ranking change is tuned. Any tuning uses a separate `tuning` split.

Judging template (one row per profile-job pair; the judge sees the profile summary and the job posting, never the
ranker's score or position):

| profile_id | job_id | relevance (0-3) | eligibility | judge | date | note |
|---|---|---|---|---|---|---|
| p-017 | job-uuid | 2 | eligible | recruiter#2 | 2026-12-01 | right role, one level above |

Relevance guideline: **3** = would apply, strong role and level fit; **2** = relevant, worth showing; **1** = adjacent
field or a stretch; **0** = not relevant. Eligibility: **ineligible** only when a stated hard preference rules the job out
(country or work-model restriction, seniority far off, salary below the stated minimum); otherwise **eligible**; leave it blank when unsure.
