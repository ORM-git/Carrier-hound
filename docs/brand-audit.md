# CareerMonke APP brand audit + contract (Agent A, owner V4)

Base `main` @ `3140f3e0`. **App pages only.** The landing/front page is a hard no-touch boundary.
This PR changes no file reachable from `/` (esbuild import-graph audit), and before/after landing
captures at 390/1366/1440 have zero changed pixels and identical HTML apart from dev-only `?v=` cache-busters.

## Asset facts

The supplied wordmark is a 1932x1932 opaque image: Deep Blue `#0020B0` ink on off-white `#FEFEFE`, not transparent.
`public/brand/careermonke-wordmark-interim.png` is an exact pixel crop (1543x186, no resampling, recolouring or
background removal) and is labelled **interim**. It is only used on white or near-white surfaces. **Owner to supply:**
the original transparent SVG/PNG, plus an approved square/compact mark for collapsed rails, favicons and app icons.
Existing `/icon.png`, `/careermonke-logo.png` and landing assets are untouched.

## App audit (status: DONE-A · B · C · BLOCKED-ASSET · BLOCKED-OWNER · GAP)

| App route / state | Before | After / proposal | Status |
|---|---|---|---|
| Desktop rail, collapsed 72px (Jobs, Resume, Profile, Tracker, Radar, Settings, Pricing) | `/icon.png` monkey | No compact mark exists, so the monkey is removed and the brand link (`/jobs`, "CareerMonke Jobs") moves into the top bar; the expand control and every nav item stay | DONE-A · compact mark BLOCKED-ASSET |
| Desktop rail, expanded 240px | monkey + "CareerMonke" text | wordmark 166x20 + collapse button | DONE-A |
| Desktop top bar | page title only | wordmark 166x20 before the title while the rail is collapsed | DONE-A |
| Mobile drawer header | `careermonke-logo.png` | wordmark 183x22 | DONE-A |
| Mobile top bar (phone) | menu + page title | **not added**: the wordmark (≥133px) + title + guest Log in/Get started overflow at 360–390px; the brand is in the drawer. Owner choice needed (e.g. title vs wordmark) | BLOCKED-OWNER |
| Shell colours (primary buttons, avatar, active nav, hover, focus) | `#2563EB` family | Electric fill + ink text; Royal hover + white; Deep active text on `#E6F2FF`; Electric focus/indicator | DONE-A |
| Auth callback transition | 40px monkey tile | wordmark 265x32 on the white card | DONE-A |
| Onboarding Step 1/2, phone | "CareerMonke Copilot" persona: avatar, "Copilot Online" dot, AI badge, chat bubble | neutral instruction text; edit-mode label kept; every field/step unchanged | DONE-A |
| Onboarding Step 1/2, desktop | monkey tile + "CareerMonke" on a tinted panel | wordmark on a white chip; subtitle kept | DONE-A |
| Onboarding selection colours | emerald green chips/checks/toggles (selection emphasis) | to Electric per V4 (next pass; touches onboarding tests) | proposal, A pass 2 |
| App footer inside the shell (`Footer.tsx`) | `careermonke-logo.png` | `Footer` is the shared public footer (no-touch); needs an owner-approved app-only footer or opt-in | GAP / BLOCKED-OWNER |
| Jobs route error (`app/jobs/error.tsx`) | `BrandedErrorFallback` monkey tile | `BrandedErrorFallback` is reachable from the landing's root error boundary, so it can't change. B (jobs owner) can render `<BrandWordmark placement="loading" />` in a jobs-scoped wrapper, or A adds an app-only fallback on request | B / coordinate |
| Jobs route loading (`app/jobs/loading.tsx`) | public `GuideHeader` (monkey) | B's file; swap the header for an app header with `BrandWordmark` | B / coordinate |
| Jobs feed/detail actions (All Filters, Retry, Apply…) | `#2563EB` | consume tokens below | B |
| Profile Strength, Resume analysis badge | green emphasis | consume tokens; keep true success green | C |
| Favicon / app icon / manifest / OG / structured data | monkey (shared with landing) | can't change without touching the landing; needs a route-scoped icon and an approved compact asset | BLOCKED-ASSET + BLOCKED-OWNER |
| Razorpay checkout image (`lib/billing/razorpay.ts`) | `/icon.png` | out of scope in V4 (billing unchanged); needs the compact asset | GAP |
| Root `error.tsx` / `global-error.tsx` / `not-found.tsx` | monkey | shared with the landing, so left unchanged | landing boundary |

## Token contract (owner V4). Import from `@/components/brand/AppBrand`; never use it in landing/public/global files.

| Name (`APP_BRAND.*` / CSS var on app wrappers) | Value | Use | Measured |
|---|---|---|---|
| `primary` / `--cm-app-primary` | Electric `#0082FF` | primary action fill, active/progress highlight | — |
| `onPrimary` / `--cm-app-on-primary` | ink `#0F172A` | text/icons on Electric | 4.79:1 (white is only 3.73:1, fails) |
| `primaryHover` / `--cm-app-primary-hover` | Royal `#0039F5` | hover/pressed fill | — |
| `onPrimaryHover` / `--cm-app-on-primary-hover` | white | text on Royal | 7.23:1 (ink only 2.47:1) |
| `strong` / `--cm-app-strong` | Deep `#0020B0` | strong text, active nav text, brand emphasis | 11.45:1 on white |
| `accent` / `--cm-app-accent` | Electric `#0082FF` | focus ring (with white offset), indicators, borders: non-text only | 3.73:1 vs white |
| `selected` / `--cm-app-selected` | `#E6F2FF` | subtle selected fill | Deep on it 10.10:1 |
| `border` / `--cm-app-border` | `#A6D3FF` | decorative brand border | — |

- Vars are set on `LoggedInAppShell` only (`style={APP_BRAND_VARS}`). `jobs/page.tsx` renders the rail/top bar without
  the shell, so B spreads `APP_BRAND_VARS` on its own page wrapper or uses `APP_BRAND.*` literal values.
- Keep true success/warning/error colours and employer logo colours.
- Logo: `<BrandWordmark placement="header|rail|drawer|footer|loading" />`, fixed heights 20/20/22/24/32px, width from
  the ratio, alt "CareerMonke". Wide white slots only, never square or icon slots.
