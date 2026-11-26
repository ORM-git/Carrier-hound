# Video-filter facets: backend data and coverage plan (Item 4)

Status: **every facet below is BLOCKED on data.** No request param was wired in this PR. Live coverage is
UNKNOWN because the agent had no authorized database path. The owner runs `video_facets_coverage.READONLY.sql`,
then each facet is wired only if its column exists and its coverage is accepted. The UI must not show a facet as
working before that.

| Facet (reference video) | Column in repo schema | Live coverage | Status | What unblocks it |
|---|---|---|---|---|
| Multi job-function | `jobs.role_category` (SDE / AI_ML / CLOUD / DATA / OTHER) | UNKNOWN | BLOCKED | Coverage check 1–3. PR #796 already has a `jobFunction` param over `role_category` on the live routes. The snapshot route refuses it until `role_category` is a frozen column. |
| Min / max years of experience | `jobs.min_experience_years`, `jobs.max_experience_years` (migration `20261116b_ten_million_system_design_schema.sql`, **not** 20261001) | UNKNOWN | BLOCKED | Coverage check 1, and a parser/source that fills them |
| Skills overlap | `jobs.skills` | UNKNOWN | BLOCKED | Coverage check 1–2 (non-empty arrays per source) |
| Industry | none (proposed `companies.industry`) | none | BLOCKED | A source per company, then coverage |
| Company stage | none (proposed `companies.company_stage`) | none | BLOCKED | A source per company, then coverage |
| Agency / staffing | none (proposed `companies.is_staffing_agency`) | none | BLOCKED | A source per company, then coverage |
| Visa / clearance / citizenship | none (proposed `jobs.visa_sponsorship`, `security_clearance_required`, `citizenship_required`) | none | BLOCKED | Extraction from job text or source fields, then coverage |
| Radius | none (proposed `jobs.latitude/longitude`) | none | BLOCKED | Geocoding source for posting locations |
| Seniority track | none (`jobs.seniority` is a level, not a track) | n/a | BLOCKED | A product definition of the track |

## Status of the proposed columns

`video_facets_columns.NOT_APPLIED.sql` is a **review draft, not apply-ready**. It still needs a named data source per
column, a product decision on names, types and values, schema review, and a catalog check that no column already exists
with another type. Only then can the owner apply it. `video_facets_coverage.READONLY.sql` is the part meant to be run
now: it is read-only, every count uses the feed's scope (active, visible sources, no `jobspy`), and it stops with a
named error if a column it reads is missing or has another type.

## Existing exclusion flags (no change)

`excludeTitle`, `includeCompany` and `excludeCompany` are applied as hard filters by the server whenever they are
sent. Company filters answer 503 on the `jobs_public` path rather than broadening. Whether SAVED constraints are
sent at all is decided by `NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS` (default off) in the client
(`src/lib/jobs/service.ts`, owned by the frontend agent). Nothing backend-side needed wiring, and the flag was
not flipped.
