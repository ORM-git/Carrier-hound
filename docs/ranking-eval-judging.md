# Human relevance judging guide (checklist #62)

Status: **judging pending. Human-label coverage is 0 of 31 pairs. Ranking quality is not measured.**
This package makes human judging possible. It does not complete it, and it is not production acceptance.

| file | what it is |
|---|---|
| `scripts/eval/ranking/human-judging-v1.json` | dataset `human-judging-v1`: 7 synthetic profiles, 31 synthetic jobs, empty `labels` |
| `scripts/eval/ranking/human-judging-v1-worksheet.csv` | the worksheet: one row per profile-job pair (31 rows). Open it in Excel, Google Sheets or LibreOffice |

Every profile and company is fictional. No real resume, user or customer data is used. Do not add any.

## How to judge (no engineering setup needed)

1. Make your own copy of the worksheet. Do not discuss rows with other judges until everyone has finished.
2. For each row, read `candidate_summary` and the job columns (`job_title` to `job_description`). Judge only what
   is written there. Do not look up the ranker's score or order: the worksheet does not show it, on purpose.
3. Fill in the five empty columns:

| column | allowed values |
|---|---|
| `relevance` | `relevant`, `not relevant`, `unknown` |
| `eligibility` | `eligible`, `ineligible`, `unknown` |
| `reason` | one short sentence, required for every row |
| `judge` | your role and a number, e.g. `recruiter#1`. No names or emails |
| `date` | the day you judged, `YYYY-MM-DD` |

4. Never edit the `snapshot` column or the job text. `snapshot` is `<dataset version>/<job id>@<hash of the job>`.
   It proves which job version you judged. If a job looks wrong, write that in `reason` and mark `unknown`.

### Definitions

- **relevant**: you would show this job to this person. The role is the one they want, or very close, and the
  level is roughly right.
- **not relevant**: a different field or role, or a level far from theirs, even if the job is a good job.
- **unknown**: you cannot tell from the text given. Use it freely. `unknown` is never counted as `not relevant`.
- **ineligible**: a hard requirement in the summary rules the job out, whatever its relevance: the job is limited to a
  country or region the person is not in, the work model conflicts (they want remote only, the job is on-site), the
  job type conflicts (they want full-time only, it is a contract), or the stated pay is clearly below their stated
  minimum.
- **eligible**: no stated requirement rules it out.
- **unknown** (eligibility): the job does not say enough, e.g. salary or remote country not listed.

Relevance and eligibility are separate questions. A perfect-fit job in the wrong country is `relevant` and `ineligible`.

### Borderline examples (from this worksheet)

| pair | suggested reading | why |
|---|---|---|
| senior frontend, remote, India × h03 "Senior Frontend Engineer, Remote - US, US authorization required" | relevant, ineligible | right role and level, but remote is US-only |
| senior frontend, remote, India × h04 "Senior Full Stack Engineer, Bengaluru, hybrid" | your call; reason required | adjacent role; hybrid conflicts with "remote only" |
| senior frontend × h05 "Principal UI Architect, 12+ years" | usually not relevant | same field, level far above |
| entry data analyst, full-time × h09 "Data Analyst, six-month contract" | relevant, ineligible | right role, job type conflicts |
| product lead, min CAD 160,000 × h17 "Senior PM, CAD 120,000-140,000" | relevance your call; ineligible | top of range is below the minimum |
| product lead, min CAD 160,000 × h18 "Director of Product, salary not listed" | relevant; eligibility unknown | missing salary is not a failure |
| remote intern, no country × h21 "intern, US work authorization required" | relevant; eligibility unknown | the person's country is not stated |
| marketing, Singapore, hybrid × h25 "Remote - APAC" | your call; reason required | Singapore is in APAC, but the job is remote not hybrid |

These are guidance, not answers. The examples are not labels and are never loaded into the dataset.

## From finished worksheets to labels (engineering step, later)

Only rows from a human judge, with `judge` and `date` filled in and an unchanged `snapshot`, may become labels.
Copy them into `profiles[].labels` of a **new dataset version** (e.g. `human-judging-v1-labelled-<date>`), not into
`human-judging-v1`, and set `labelProvenance` to who judged, when and with which guide version, e.g.
`human-judge:recruiter#1,recruiter#2; 2026-12-03; judging guide v1; disagreements adjudicated by recruiter#3`.

Mapping to the harness format (`docs/ranking-eval.md`):

| worksheet | label |
|---|---|
| `relevant` | `relevance: 2` |
| `not relevant` | `relevance: 0` |
| `unknown` or blank | no `relevance` field (unjudged) |
| `eligible` / `ineligible` | `eligibility: "eligible"` / `"ineligible"` |
| `unknown` or blank | no `eligibility` field |

With binary relevance, NDCG@10 uses gain 0 or 3 and P@10 counts `relevant` jobs. With two or more judges, use the
adjudicated value. If judges disagree and nobody adjudicates, leave the pair unjudged and report the disagreement count.

Rules that do not change:

- **Labels suggested by a model** (any LLM or heuristic) are never human labels. If anyone makes them, keep them in a
  separate file named `*-model-suggested.*`. Never copy them into `labels`, never use a `human-judge` provenance for
  them, and never count them in human-label coverage.
- No label without verifiable provenance. When provenance cannot be checked, the pair stays unjudged.
- Report coverage as judged pairs out of 31 and always print the unknown counts. There is no quality threshold.
- These profiles are synthetic. Even fully judged, they test the ranker on hand-made cases, not on real traffic.
