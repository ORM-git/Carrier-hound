# Changelog

Notable changes to CareerMonke. Dates are IST. Entries cite the merged pull
requests; older history lives in the git log.

## 2026-11-06

### Added
- PWA basics: web app manifest, `theme-color` meta, 192/512 icon links (#264)
- Conservative service worker + branded offline fallback page (#266)
- Branded `<noscript>` fallback (#265)
- Static branded `500.html` for host-level server errors (#269)
- Minimal SWR-style client cache on the dashboard (#276)
- `startTransition` around the debounced jobs search (#274)
- Husky pre-commit hooks with lint-staged (#267; scoped to eslint only in #275)
- Client-side abort of the radar telemetry fetch on unmount (#277)
- Static RSS feed for public guides at /feed.xml, linked from footer + guide pages (#278)
- BreadcrumbList JSON-LD on public pages; sitemap coverage extended to all public routes (#272)
- Vitest unit test setup with first library suites; `npm run test:all` now chains it (#281)
- Bundle size budget check (650 KB first-load / 400 KB chunk, from measured production values) (#285)
- First-touch UTM/referrer capture in the early-access signup payload (#287)
- Advisory axe + Lighthouse quality workflow (#288)

### Fixed / Infrastructure
- Cron failure visibility (#271), data retention (#270), SBOM + dependency review (#263), security/ops baseline docs (#268)

## 2026-11-05

- Error boundaries, Groq timeout + circuit breaker, Web Vitals collection and storage, dead-letter `failed_events`, security scan workflow (npm audit, gitleaks, dependabot, CODEOWNERS), ESLint + jsx-a11y baseline, PII scrub of dead-letter payloads, email retry + suppression list, dependabot groups, DB safety migration file, JSON-LD structured data + preconnect hints, one-click email unsubscribe, landing globe repositioned below Features with the 3,000,000 stat removed (#238-#262)
