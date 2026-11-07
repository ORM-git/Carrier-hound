# Capacity headroom (INTERNAL)

Which provider tier limits CareerMonke is approaching, measured on a
weekly cadence, before growth turns a limit into an incident.
Owner to confirm the current Supabase plan tier and Groq plan; the numbers
below are the providers' published limits, fetched 2026-11-06.

## Documented limits (sources)

**Supabase** (https://supabase.com/docs/guides/platform/manage-your-usage/disk-size
and .../manage-your-usage/egress):

- Disk: Pro and Team include 8 GB; over-usage $0.125/GB/month. Free plan is
  limited by database size instead of provisioned disk.
- Egress: Free 5 GB/month; Pro/Team 250 GB/month (uncached and cached
  counted separately).

**Groq** (https://console.groq.com/docs/rate-limits):

- Rate limits are per model: RPM (requests/minute), RPD (requests/day),
  TPM (tokens/minute), TPD (tokens/day).
- Groq returns the active limits in every API response via the
  `x-ratelimit-limit-*` / `x-ratelimit-remaining-*` headers, so the report
  script reads Groq's own numbers rather than hardcoding any.

**Cloudflare Pages** (production hosting): static asset serving has no
published request ceiling relevant at current scale; not tracked here.

## What is measured automatically

`.github/workflows/capacity-report-cron.yml` runs
`scripts/report-capacity-headroom.ts` weekly (Monday 05:00 UTC; the
cadence is a chosen default, adjust as traffic grows) and on
`workflow_dispatch`. It reports:

- Supabase exact row counts for the large/hot tables (`jobs`, `companies`,
  `web_vitals`, `early_access_emails`, `subscriptions`, `payment_orders`,
  `failed_events`, `ingest_runs`) plus 7-day growth for `jobs` and
  `web_vitals`.
- Groq daily request usage as a fraction of the header-reported RPD limit.

The warning threshold (80% of a limit) is a chosen default, not a
provider number; it exists so the cron goes red before a limit is hit,
not at it.

## Owner steps (dashboard-bound, monthly)

These metrics have no API and must be read in the vendor dashboards
(same cadence as the config-drift dashboard review in
docs/config-drift.md):

- Supabase dashboard -> project usage: disk size vs 8 GB included, egress
  vs plan allowance.
- Groq console -> current plan and per-model limits for the models in
  `src/lib/ai/groq.ts`.

## Growth model

No forecasting is invented here. The 7-day growth numbers from the report,
reviewed weekly, are the growth signal; when a table's weekly growth
exceeds what the current tier can absorb within a quarter (chosen-default
planning horizon), that is the trigger to budget an upgrade.
