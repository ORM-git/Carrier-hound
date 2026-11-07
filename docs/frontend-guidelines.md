# Frontend Guidelines

How frontend work is done in this repo. Read this before adding a page or
component. The design token and component catalog lives in
`docs/design-system.md`.

## Stack

- Next.js 14 App Router, static export (`output: "export"`, `images.unoptimized`
  is required by the export, so `next/image` optimization is unavailable).
- React 18 client components; pages are whole-page `'use client'` except
  `/worldwide` (async server component).
- Tailwind CSS + design tokens (`src/styles/tokens.css`).
- Supabase for auth/data; first-party SWR-style cache in `src/lib/cache/swr.ts`
  (`swrFetch`: TTL + in-flight dedupe) used on /dashboard.

## Rules that are enforced by tests/CI

- **No visual change without an explicit owner decision.** Logic, data, state,
  error-handling, performance and accessibility-attribute work only.
- **Accessibility**: every image has `alt`, every input has an accessible
  label, icon-only buttons have `aria-label`, onClick on div/span has a role.
  Gated by `scripts/audit-static-a11y.ts` (runs in `npm run test:all` and CI).
- **Token contrast**: text/background pairs must meet WCAG AA; gated by
  `scripts/test-design-tokens.ts`.
- **Bundle budget**: `npm run check:budget` (scripts/check-bundle-budget.mjs)
  gates chunk size in CI.
- **Type safety**: `npm run type-check` (tsc --noEmit) must stay clean.

## Conventions

- Use design tokens (`tk-*` classes, brand scale) instead of ad-hoc values;
  use `cnTokens` (not stock `cn`) when merging token classes.
- Prefer `src/components/ui/` primitives over new one-off styles;
  `src/components/Buttons.tsx` is legacy.
- Interactive elements keep 44px minimum touch targets.
- Dates render from the user's locale/timezone; never hardcode formatted
  date strings.
- Data fetching: reuse `swrFetch` for client GETs that tolerate short
  staleness; abort superseded requests and guard against last-write-wins
  races on mutation handlers (see jobs page patterns).
- Remote third-party origins used on first load must be reflected in
  `getConnectionHints()` (`src/lib/seo/structuredData.ts`) - audit trail in
  `docs/performance/preload-audit.md`.

## Verification before opening a PR

Run locally: `npm run type-check`, `npm run lint`, `npx vitest run`, and the
full offline suite (`npx tsx scripts/suite-runner.ts`). State plainly in the
PR what could not be verified locally.
