# Human relevance judging guide (checklist #62)

Status: **judging pending. Human-label coverage is 0 of 31 pairs. Ranking quality is not measured.**
This package makes human judging possible. It does not complete it, and it is not production acceptance.

| file | what it is |
|---|---|
| `scripts/eval/ranking/human-judging-v1.json` | dataset `human-judging-v1`: 7 synthetic profiles, 31 synthetic jobs, empty `labels` |
| `scripts/eval/ranking/human-judging-v1-worksheet.csv` | the worksheet: one row per profile-job pair (31 rows). Open it in Excel, Google Sheets or LibreOffice |

Every profile and company is fictional. No real resume, user or customer data is used. Do not add any.

## Synthetic, not production evidence

Both datasets in this repo are synthetic: `synthetic-v1` (author-labelled, proves the harness works) and
`human-judging-v1` (this package, unlabelled). Even after humans judge every row here, the numbers describe the
ranker on 7 hand-made profiles. They are not evidence of recommendation quality for real users or real traffic, and
no quality threshold has been agreed. Production acceptance needs the real-data set described in
`docs/ranking-eval.md`.

## How to judge (no engineering setup needed)

1. Make your own copy of the worksheet. Do not discuss rows with other judges until everyone has finished.
2. For each row, read the candidate columns and the job columns. They show **every input the ranker gets** for that
   pair. Judge only what is written there. The ranker's score and order are not shown, on purpose; do not look them up.
3. `not stated` means the candidate gave no value for that input. `not listed` means the job gave none.
   `n/a (not remote)` means the job is not remote, so a remote restriction does not apply. None of these mean "no" or "bad".
4. Fill in the five empty columns at the end:

| column | allowed values |
|---|---|
| `relevance` | `relevant`, `not relevant`, `unknown` |
| `eligibility` | `eligible`, `ineligible`, `unknown` |
| `reason` | one short sentence, required for every row |
| `judge` | your role and a number, e.g. `recruiter#1`. No names or emails |
| `date` | the day you judged, `YYYY-MM-DD` |

5. Do not edit any other column. If something looks wrong, say so in `reason` and mark `unknown`.

### Columns you read

| group | columns |
|---|---|
| case | `snapshot`, `dataset_version`, `reference_time` (the instant the ranker scores at; job ages are relative to it) |
| candidate | `candidate_id`, `candidate_summary`, `candidate_target_roles`, `candidate_experience_level`, `candidate_work_model`, `candidate_locations`, `candidate_country`, `candidate_employment_types`, `candidate_categories`, `candidate_min_salary` |
| candidate resume (synthetic signals) | `resume_job_titles`, `resume_skills`, `resume_preferred_roles`, `resume_years_experience` |
| job | `job_id`, `job_title`, `company`, `job_category`, `job_location`, `job_country`, `job_remote`, `job_work_model`, `job_remote_restriction` (`worldwide`, `country_restricted`, `region_restricted`), `job_type`, `job_posted_at`, `job_salary`, `job_skills`, `job_description` |

The structured columns and the free text can both carry restrictions (e.g. `country_restricted` plus "US work
authorization required"). Use both.

### Snapshot

`snapshot` is `<dataset version>/<candidate id>/<job id>@<hash>`. The hash covers the dataset version, the reference
time, the candidate's id, summary and every answer, and every job field. It never covers the five judging columns.
Change any of those inputs and the snapshot changes, so a judgment made on an old snapshot cannot be applied to the
new case by mistake.

### Definitions

- **relevant**: you would show this job to this person. The role is the one they want, or very close, and the
  level is roughly right.
- **not relevant**: a different field or role, or a level far from theirs, even if the job is a good job.
  This is a negative judgment you are confident in.
- **unknown**: you cannot tell from what is shown. Use it freely. `unknown` is **not** a negative: it is stored as
  unjudged and is never counted as `not relevant` or `ineligible`.
- **ineligible**: a stated requirement rules the job out, whatever its relevance: the job is limited to a country or
  region the person is not in, the work model conflicts (they want remote only, the job is on-site), the job type
  conflicts (they want full-time only, it is a contract), or the stated pay is clearly below their stated minimum.
- **eligible**: no stated requirement rules it out.
- **unknown** (eligibility): a needed input is `not stated` or `not listed`, e.g. the job's salary is missing, or the
  candidate's country is not stated while the job is country-restricted.

Relevance and eligibility are separate questions. A perfect-fit job in the wrong country is `relevant` and `ineligible`.

### Borderline examples

These show how the definitions apply. They are **examples written by the package author, not labels**: they are not
in the worksheet, not in the dataset, and never count toward coverage. Judge each row yourself; you may disagree.

| pair | one reasonable reading | why |
|---|---|---|
| senior frontend, remote, India × h03 "Senior Frontend Engineer", `country_restricted` US | relevant, ineligible | right role and level, but remote is US-only |
| senior frontend, remote, India × h04 "Senior Full Stack Engineer", Bengaluru, hybrid | your call; reason required | adjacent role; hybrid conflicts with "remote only" |
| senior frontend × h05 "Principal UI Architect, 12+ years" | usually not relevant | same field, level far above |
| entry data analyst, full-time only × h09 "Data Analyst", contract | relevant, ineligible | right role, job type conflicts |
| product lead, min 160000 CAD × h17 "Senior PM", 120000-140000 CAD | relevance your call; ineligible | top of range is below the minimum |
| product lead, min 160000 CAD × h18 "Director of Product", salary `not listed` | relevant; eligibility unknown | missing salary is unknown, not a failure |
| remote intern, country `not stated` × h21 intern, `country_restricted` US | relevant; eligibility unknown | the candidate's country is not stated |
| marketing, Singapore, hybrid × h25 `region_restricted` "Remote - APAC" | your call; reason required | Singapore is in APAC, but the job is remote, not hybrid |

## From finished worksheets to labels (engineering step, later)

Only rows from a human judge, with `judge` and `date` filled in and a `snapshot` equal to the current one, may become
labels. Copy them into `profiles[].labels` of a **new dataset version** (e.g. `human-judging-v1-labelled-<date>`), not
into `human-judging-v1`, and set `labelProvenance` to who judged, when and with which guide version, e.g.
`human-judge:recruiter#1,recruiter#2; 2026-12-03; judging guide v1; disagreements adjudicated by recruiter#3`.

Mapping to the harness format (`docs/ranking-eval.md`):

| worksheet | label |
|---|---|
| `relevant` | `relevance: 2` |
| `not relevant` | `relevance: 0` |
| `unknown` or blank | no `relevance` field (unjudged) |
| `eligible` / `ineligible` | `eligibility: "eligible"` / `"ineligible"` |
| `unknown` or blank | no `eligibility` field (unjudged) |

With binary relevance, NDCG@10 uses gain 0 or 3 and P@10 counts `relevant` jobs. With two or more judges, use the
adjudicated value. If judges disagree and nobody adjudicates, leave the pair unjudged and report the disagreement count.

Rules that do not change:

- **Labels suggested by a model** (any LLM or heuristic) are never human labels. If anyone makes them, keep them in a
  separate file named `*-model-suggested.*`. Never copy them into `labels`, never use a `human-judge` provenance for
  them, and never count them in human-label coverage.
- No label without verifiable provenance. When provenance cannot be checked, the pair stays unjudged.
- Report coverage as judged pairs out of 31 and always print the unknown counts. There is no quality threshold.

## Changing the dataset (engineers)

The worksheet is generated from the dataset. After any dataset edit, regenerate it and rerun the tests:

```
REGENERATE_JUDGING_WORKSHEET=1 npx vitest run src/lib/eval
npx vitest run src/lib/eval
```

Regenerating writes blank judging columns, so do it before handing out worksheets, never over judged copies.
The tests in `src/lib/eval/__tests__/rankingEval.test.ts` fail when any worksheet field differs from the dataset,
when a snapshot is stale, or when a dataset field has no worksheet column.
