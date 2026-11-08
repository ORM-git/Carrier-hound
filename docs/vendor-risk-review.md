# Vendor risk register (internal)

Code-based review, 2026-11-06. This records dependencies and recovery work,
not a completed legal/security assessment of any vendor. No dashboard,
contract, current certification, data residency or subprocessor claims have
been verified by this review. Do not use this as customer privacy copy.

| Dependency evidenced in the repository | Data / operational exposure | Existing control or recovery path | Remaining verification |
| --- | --- | --- | --- |
| Supabase (`src/lib/admin/auth.ts`, `src/lib/api/sharedRateLimit.ts`) | Auth, database, service-role access and shared rate-limit store | Server-side service role; strict shared-store failure behavior for sensitive routes; account delete/export handlers | Owner: project access review, backup restore drill, region/contract and retention settings |
| Groq (`src/lib/ai/serviceHandler.ts`) | Resume/job inputs sent to the model; model quota and upstream failures affect AI features | Circuit breaker and fallback paths; `docs/security/secrets-rotation-runbook.md` | Owner: current data-use terms, retention and account/key access review |
| Google mail / Apps Script (`src/lib/early-access/gmail.ts`) | Digest recipients and outgoing mail; quotas and mailbox credentials | Suppression and failed-event paths; cron runbooks | Owner: account access, quotas and current mail-processing terms |
| Razorpay (`src/lib/billing/checkout.ts`) | Payment credentials and webhook handling if billing is enabled | Billing stays disabled; webhook validation/idempotency exists | Before enabling: merchant approval, key access, webhook configuration and payment terms |
| GitHub Actions (`.github/workflows/`) | Source, deployment/cron secrets and scheduled jobs | CI/security scans; secrets rotation runbook | Owner: org access, branch protection, dependency graph and Actions billing/settings |
| Cloudflare / Netlify (`docs/runbooks.md`) | Deployments, host environment secrets and availability | Primary/backup host recovery notes in runbooks | Owner: current DNS, deployment access, backup deploy readiness and quotas |
| Sentry (`SENTRY_DSN` references in application code) | Error telemetry may contain request context | Treat telemetry as restricted operational data; scrub before sending | Owner: retention, access and scrubbing settings in the project |

See also: [security/key-management-and-vendor-terms.md](security/key-management-and-vendor-terms.md) for the key storage summary and the vendor terms and DPA tracking template.

## Review cadence and change gate

Review on a new vendor, a change in the data it receives, a material outage,
or before enabling billing. Revisit this register at release review.

For each review, record date, reviewer, vendor/account scope, evidence link,
data shared, access holders, current terms, region/retention settings,
recovery test and unresolved actions. Mark unverified fields as unverified,
not compliant by default. Keep evidence in the private operational record;
never commit secrets or private account exports.

A vendor outage starts with `docs/runbooks.md`; a compromise starts with the
security incident procedure. An owner account review is still required to
close the remaining-verification column.
