# Structured employment-type ingestion, bounded slice

Six TypeScript adapters now use the merged conservative employment-type mapper for a dedicated source field: Lever commitment, Join employmentType, Workable type, Breezy type name/id, SmartRecruiters employment label, and Remotive job_type. Supported source values populate full-time, part-time, contract or internship instead of collapsing to the generic job value. Canonical job/other remain generic. Ambiguous, compound, malformed and unsupported explicit values stay other. No full-time value is inferred from an ordinary title.

When the source field is absent or blank, the existing title-only internship detector is retained. An explicit source field takes priority over title words. The helper is not applied to descriptions, combined fields or multi-value arrays. Other adapters, Python ingestion and board ingestion remain unchanged.

No SQL, filters, API, profile or UI is changed. The mapper's six possible outputs are already present in the repository's ingestion constraint and NormalizedJob union; production schema application is not verified by this change. No historical rows are rewritten. Raw source values and mapping confidence are not persisted by this slice, and unsupported Temporary/Volunteer/Per Diem values are not claimed as populated. Checklist 17 remains Partial.

Run `npx tsx scripts/test-employment-type-ingestion.ts`. The registered offline script executes all six actual adapter entry points with HTTP intercepted, not production requests. These tests verify normalized output, not real database acceptance or corpus coverage.
