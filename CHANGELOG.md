# Changelog

All notable changes to CareerMonke. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
dates are IST release days. This project does not yet use semantic
versioning or git tags (starting with `v1.0.0` at public launch).

## [Unreleased]

### Added
- CI: dependency review on pull requests (fails on high severity) and
  weekly CycloneDX SBOM artifact (#263).
- Docs: security disclosure policy (SECURITY.md + security.txt),
  secrets rotation runbook, ops runbooks, incident log, first
  postmortem, initial SLOs, this changelog.

## 2026-11-05 (audit remediation day)

### Added
- Real-user Core Web Vitals collection and storage (#240, #248).
- Dead-letter queue (`failed_events`) with admin replay path and PII
  scrubbing (#241, #244).
- Email retry with exponential backoff + suppression list (#247);
  signed one-click unsubscribe with dedicated `UNSUBSCRIBE_SECRET` and
  confirmation flow (#260).
- ESLint with jsx-a11y and max-warnings baseline (#243).
- Security CI: npm-audit baseline, Gitleaks, Dependabot groups,
  CODEOWNERS (#242, #245, #249, #250).
- DB safety migration (schema_migrations, statement/lock timeouts,
  pg_stat_statements) - **pending owner apply** (#254).
- JSON-LD structured data + preconnect hints (#255, unicode-escape fix
  #259).

### Fixed
- Groq timeout + circuit breaker; main CI green again (#239).
- Error boundaries (#238); landing: globe repositioned, 3M stat
  removed (#261); Razorpay footer compliance (#262).

## 2026-10-19 → 2026-11-04 (billing, gating, hardening)

### Added
- Razorpay billing backend: plans, add-ons, atomic quota RPCs, global AI
  budget, webhook fulfilment with order-mode isolation (#233-#237
  series; billing disabled pre-launch).
- Early-access approval gate + admin review console.
- Cloudflare Pages as primary host (carrier-hound.pages.dev).

### Security
- Removed audit-email bypass and fake Pro activation; locked
  job_descriptions and scraper tables; RLS audit pass.
- Rotated exposed keys (Groq; Supabase JWT rotation still pending).

## 2026-10-16 (first merge train)

- PRs #15-#39 merged: performance (jobs LCP), a11y contrast, rate
  limits, /worldwide DB counts, digest cron on Node 22, RLS lockdown,
  mobile perf 82 median.
