# Log Retention & Central Logs (INTERNAL)

> Backend row BE#3. Where logs live, how long they are kept, and what is
> centralized. Last reviewed: 2026-11-06 (against `main`).

## Platform logs (default retention, dashboard-only today)

- **Cloudflare Pages (production)**: per repo config
  (`carrier-hound.pages.dev`, `@cloudflare/next-on-pages`), production
  serves from Cloudflare Pages (owner to confirm); its function/access
  logs carry all production API and SSR output. `console.*` in app code lands here in production. Retention
  is the Cloudflare plan default and lives in the dashboard only - no
  central copy.
- **Netlify (preview/legacy functions)**: preview deploys and legacy
  function logs only; not production traffic.
- **Owner steps** (account/dashboard bound, not codeable):
  1. Enable a Cloudflare log drain / Logpush to the chosen central sink.
  2. Set dashboard retention to the plan maximum that fits the DPDP
     schedule in `docs/retention-policy.md`.

## Centralized in-product logs (DB-backed, retention enforced)

These are the canonical operational logs; windows and enforcement are the
DPDP schedule in `docs/retention-policy.md` (weekly `retention_purge` via
`.github/workflows/retention-cron.yml`):

| Log | Store | Window |
| --- | --- | --- |
| Cron execution | `cron_run_logs` | 90 days |
| Admin actions | `admin_audit_log` | 365 days |
| Failed/dead-letter events | `failed_events` | 90 days after last attempt |
| Outbound mail | `gmail_send_log` | 180 days |
| Page-view analytics | `page_views` | 90 days |
| Inbound webhook idempotency | `webhook_events` | 90 days |
| Funnel analytics events | `funnel_events` | 90 days |
| Record change history | change-history triggers (20261106c) | per `docs/retention-policy.md` |

## Centralized error tracking

- **Sentry** (`@sentry/nextjs`, `src/lib/monitoring/sentryErrorReporter.ts`)
  is the central error log for client + edge + server errors. Event
  retention is provider-side - confirm with vendor docs.

## Logging rules

- No PII in `console.*` output: log IDs and counts, not emails, names, or
  resume content (DPDP storage-limitation baseline).
- Audit/history writes are fail-open (WARNING, never block the request).
- Structured JSON logging format is a separate row (BE#27); this document
  covers retention and centralization only.
