# Python ingestion cohort owner verification

Use this sequence after reviewing the code. The workflow itself remains scheduled every four hours and shares the `ingest-pipeline` lock with the TypeScript ingester; `cancel-in-progress: false` keeps active runs alive. GitHub cron is best-effort, so a missed slot is not proof of a code failure.

1. Review the exact PR head SHA, both source cohorts, the workflow checks and the report schema. Confirm the PR is merged and deployed to the default branch before relying on its schedule. Do not dispatch from a feature branch.
2. Separately approve an owner-run manual workflow execution. The existing schedule and manual entry point retain write, production and expiry authority; each cohort has a separate source-failure veto and report. A failing cohort leaves the aggregate run red while the other cohort still executes.
3. Inspect both uploaded JSON reports. Check selected/completed/failed source IDs, fetched and deduped totals, persistence-confirmed inserted/updated/unchanged counts, expiry outcomes, guard reason, SHA, and timestamps. A dry-run projection is not a confirmed write; fetched jobs are not newly added jobs; a zero net active delta can be legitimate.
4. On the established CareerMonke test-account site, record timestamped before/after values from the public `/api/stats` endpoint alongside the run SHA and both reports. Missing guest-stat fields are unknown, not zero. Do not use the production database, service-role credentials, or a user's session token in a public checker.
5. Escalate missing repository secrets, workflow permissions, inactive workflow configuration, or scheduling restrictions to the repository owner. Do not add a token, external scheduler, automatic dispatch loop, or retry that bypasses the shared lock.
