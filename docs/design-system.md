# CareerMonke Design System Catalog

Component catalog for the design system. The tokens themselves live in
`src/styles/tokens.css` (single source of truth, imported once in
`src/app/layout.tsx`, mapped into Tailwind in `tailwind.config.ts`).

## Token conventions

- Colors are stored as space-separated RGB channels (`--cm-brand-600: 37 99 235`)
  so Tailwind opacity modifiers work: `bg-brand-600/80`.
- Non-color Tailwind keys are prefixed `tk-` (`rounded-tk-md`, `shadow-tk-sm`,
  `text-tk-h1`, `z-tk-header`, `duration-tk-fast`) so they never collide with
  Tailwind defaults or legacy page classes.
- 8px spacing rhythm: `p-tk-2` = 16px, `gap-tk-3` = 24px.
- Light theme first. Text/background pairs are verified to meet WCAG AA
  (>= 4.5:1) by `scripts/test-design-tokens.ts`.
- Brand blue scale: base `#2563EB` (brand-600), hover `#1D4ED8` (brand-700),
  pressed `#1E40AF` (brand-800), tint `#EFF6FF` / `#DBEAFE`, borders
  `#BFDBFE` / `#93C5FD`.
- Focus ring: 2px `#93C5FD` with 1px offset (`--cm-focus-ring`).

## Primitive merging

Use `cnTokens` from `src/components/ui/cn-tokens.ts` (not the stock `cn`) when
combining `tk-*` classes - stock tailwind-merge does not know the custom token
groups and silently drops them.

## Primitives (`src/components/ui/`)

| Component | Purpose |
| --- | --- |
| `button.tsx` | `Button` with variants primary / secondary / outline / ghost / destructive, sizes sm/md/lg (all min 44px touch target), `buttonClasses` for Link/a styled as buttons |
| `card.tsx` | Card surfaces |
| `badge.tsx` | Status/category badges |
| `avatar.tsx` | User avatars |
| `skeleton.tsx` | Loading skeletons (pair with `role="status"` announcements) |
| `progress-bar.tsx` | Progress indication |
| `auth-ui.tsx` | Auth form building blocks |
| `typewriter-text.tsx` | Typewriter text effect |
| `testimonial-card.tsx`, `testimonials-columns-1.tsx`, `marquee-01-utils` | Landing testimonials |
| `wireframe-dotted-globe.tsx` | Globe visual |

## Legacy shared components (`src/components/`)

`Buttons.tsx` (PrimaryButton / WhiteHeroButton / GhostButton /
OutlineSmallButton) predates `ui/button.tsx` - prefer `ui/button.tsx` for new
work. Other shared pieces: `Chip`, `Modal`, `UserMenu`, `CompanyLogo`
(self-hosted logo -> unavatar.io -> letter-tile fallback chain),
`CookieNotice`, `BackToTop`, `FaqItems`.

## Accessibility requirements (enforced)

- Every `<img>`/`<Image>` needs `alt`; every `<input>` needs an accessible
  label (aria-label / aria-labelledby / id+htmlFor / wrapping `<label>`);
  icon-only `<button>` needs aria-label; onClick on div/span needs a role.
  Enforced by `scripts/audit-static-a11y.ts`, which runs as a hard gate in
  `npm run test:all` and CI.
- Interactive elements keep 44px minimum touch targets.
