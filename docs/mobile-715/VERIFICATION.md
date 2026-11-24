# Mobile 23-point verification ledger

PR #722 supersedes #715. No merge by this author. Independent review and actual-head CI remain required.

All screenshots are isolated fixtures with synthetic data and outbound requests blocked. Synthetic score values establish layout and event behavior only. Real handler score evidence is separate. No production auth, upload, account writes or payment acceptance was attempted.

## Current checks

- November 24 port verification: typecheck passes; lint 0 errors / 252 existing warnings.
- Full unit suite: 353 + 411 + 403 + 419 = 1,586 tests, 163 files, all pass. Privacy integration covers the extra main-branch company heading. All 20 callback-safety tests from main pass without behavioral callback edits.
- All 265 script-suite entries were attempted in bounded batches: 242 pass, 20 DB-capable checks safely blocked without an authorized DB target, three remain unverified locally. URL-history and 400% reflow need the absent build export; onboarding-persistence is killed at the PGlite memory ceiling. These are not passes. Python identity contract passes 5/5 after installing the missing local pytest dependency. Settings-lock and signup-navigation source assertions were updated to the intended behavior with negative controls retained.
- Latest local full build exits 137 during optimization. Earlier head f433fcc2 built successfully in CI, but that does not establish the new head. Actual-head CI, including full script suite and build, remains required.
- `scripts/mobile-715/build.cjs` bundles the real UI with controlled service/auth/storage/checkout responses. Rebuild Tailwind before capture when adding classes.
- `feed-integration.cjs`: actual Jobs page and controlled observer, 360/390/430 plus 1280 desktop negative control. Two transitions, within/across-page duplicates, slow single flight, error pause, manual retry, termination, Saved/Applied/filter/unmount cancellation, browser Back scroll restoration, preference-change event lifecycle. Results in `feed-integration.json`.
- `accessibility-layout.cjs`: both onboarding steps at 360/390/430 with 200% font/line-height and 430px-height keyboard-equivalent viewports. Checks no horizontal overflow, last control above fixed footer, CTA fully inside viewport and at least 44px. This does not simulate a real OS keyboard.
- `field-logo-integration.cjs`: guest/free card+detail locked-logo DOM and protected-host request exclusion, Pro-logo request, long salary local/original and core fields, expired warning/Closed and unknown/notfound at all three widths.
- `pricing-keyboard.cjs`: native browser radio keyboard selection across all tiers, correct visible card, consent unchecked, no checkout.

| # | Status | Evidence and limits |
|---|---|---|
| 1 | PASS fixture | Free signup/signin copy and visible landing sign-in, 360/390/430. |
| 2 | PASS fixture | Two-word Career Monke brand and auth metadata, including footer. |
| 3 | OWNER LIVE CHECK | Real password form handlers with mocked SDK and safe routing pass. Only owner performs live signup/reset/session/rate-limit acceptance in an authorized environment. |
| 4 | PASS fixture | Job role wording. |
| 5 | PASS fixture/tests | Inline expandable/collapsible role categories, selection retained. |
| 6 | PASS fixture | Blue onboarding at three widths. |
| 7 | PASS isolated / OWNER LIVE CHECK | Five-role 360 scrolled last authorization clears footer; 200% and short-viewport matrix passes. Actual production flag-ON onboarding remains owner-only. |
| 8 | PASS isolated | 19-case actual API/PGlite/preferences/settings roundtrip suite covers all four canonical sets, rejection and failed-save preservation. No real DB write. |
| 9 | PASS fixture | First-person authorization text. |
| 10 | PASS isolated | Single visible phone bottom action. Empty/one/both/pending plus invalid/failed input and Back preservation covered by real component handlers; page duplicate-save guard tested. |
| 11 | PASS fixture/tests | Removed example paragraph, PDF-export directive, and validation error example URLs. Format/size/private guidance remains. |
| 12 | PASS isolated | Populated/empty/error/end and retry pixels, delayed response and Saved/Applied isolation tested. Loading, Saved-empty, Applied-one, filter-zero and filter-short matrices now captured at all three widths with no horizontal overflow. First unfiltered/applied card at y136; filtered state adds its active-filter row. |
| 13 | PASS fixture/tests | Neutral hide menu/control, no standalone mobile ban icon. |
| 14 | PASS isolated | Guest/free actual card+detail logo branch has no protected logo identity or request. Pro logo path requested; component 8-case image error/no-domain fallback suite passes. |
| 15 | PASS fixture/tests | Compact shared Recommended/Saved/Applied row and filters. |
| 16 | PASS fixture/tests | Duplicate bottom strip removed; six-icon app navigation stays on detail. |
| 17 | PASS fixture/tests | Compact title/metadata/score/description sequence without duplicate metadata. |
| 18 | PASS isolated | Same saved-profile server scorer on recommended/search/Pro, Free/Pro feed/detail/reload agreement. Actual route tests prove revised saved preferences change score and keep agreement. Browser controlled score lifecycle now proves event refresh before AND while detail is open, then Back to the matching refreshed card. Older f710 event-while-open defect was found by reviewer and fixed; obsolete selection/revision refresh results are ignored. Screenshot 83 is synthetic, never model accuracy evidence. |
| 19 | PASS fixture/tests | 52px feed score ring. |
| 20 | PASS isolated | Core card/detail field rendering, long local/original salary wrapping, company/similar/report areas, expired/unknown states pass three widths. Populated tracker notes, experience and source-linked company overview are rendered and checked at all three widths. Synthetic source-labelled fixture only, not factual enrichment. No invented company enrichment. |
| 21 | PASS isolated | Actual feed observer lifecycle and manual retry described above. Stable 31 unique cards after two appended pages; no stale append after filter/tab/unmount, Back restores exact scroll. Desktop negative control no autoload. |
| 22 | PASS fixture/tests | No mobile remaining-count text below feed; original request wins over contrary brief. |
| 23 | PASS isolated | Monthly default, three-tier click and native radio keyboard selection. All checkout handlers separately mocked for explicit CTA, correct plan, duplicate lock, cancellation/error recovery and unchecked consent. No real checkout. |

## Correction: nine gaps ported from PR #715

The earlier isolated-PASS labels did not establish these edge cases. Comparison against #715 exposed nine real gaps, now adapted to #722/main rather than replacing whole files:

1. Signed-in signup uses a single onboarding-aware redirect, including query destinations and cancellation on unmount.
2. Settings enforces canonical work authorization, locks pending saves, preserves failed edits and stored employment types.
3. Settings uses Email & password wording. Callback changes are only sign-in error and brand copy; main #720 deadline/session/error protections remain intact.
4. Unsaved LinkedIn draft survives Back; Enter cannot duplicate a pending save. Mobile CV heading and long-error wrapping are fixed.
5. Onboarding phone touch targets, country wrapping, adaptive job-type layout and focus clearance are fixed. Fixed footers honor cookie-notice height and existing text-relative bottom clearance.
6. Filter remove and Clear all controls have 44px touch targets.
7. Locked employer is omitted from report/share text and the other-open-jobs heading, in addition to logos and ordinary text.
8. Duplicate-only pages pause automatic loading. Page/cursor/end refs guard late observers; existing unmount cancellation and score refresh remain intact.
9. Mobile detail without a confirmed resume shows a real-match upload prompt, never a fabricated score.

`accessibility-layout.cjs` now passes 24 cases: two steps, three widths, 200% text, short viewport, 96px cookie offset and short viewport plus cookie offset. Cookie checks use a controlled CSS-height contract, not a real consent workflow. The 360px short+cookie pixels and 200% text pixels were directly inspected. CTA and final control remain above the cookie notice/footer. The other three browser matrices pass after porting. No production account or DB writes, auth acceptance, uploads or payments were performed.

## Review follow-up: synchronization and non-overlapping touch targets

Reviewer reproduced the stale-page test resolving its deferred request before the real search debounce had changed the query. The test now waits for the filtered page-1 request, the old page's aborted signal and the three filtered cards before resolving that old response. Its final exact three-card assertion is unchanged; stale appends are still rejected.

Reviewer also found overlapping pseudo-element touch extensions across chip rows. Role-remove and active-filter remove/Clear all now use real in-flow 44px rectangular targets, not invisible extensions. Each target stays inside its chip/row; filter desktop sizing at lg+ is unchanged. This necessarily makes phone/tablet chip rows taller without changing their content or styling scheme. `touch-targets.cjs` renders the real components at 360/390/768, checks all four inset corners plus the center of every remove/Clear all target against `elementFromPoint`, verifies 44px dimensions and no horizontal overflow, and captures all six views. All 51 targets / 255 hit checks pass; all six screenshots were directly inspected. The 24-case onboarding 200%-text/short-viewport/cookie-offset matrix passes again.

Two combined 2-worker runs of the new auth/jobs/settings/pricing/onboarding suites plus filter regression and callback safety pass 202/202 each after both fixes (a previous synchronization-only combined run passed 156/156). Typecheck passes; lint remains 0 errors / 252 existing warnings. The earlier build/PGlite limitations remain, and new-head CI plus reviewer GO are still required.

## Remaining gates

1. Independent review of the completed isolated matrices, open-detail revision fix and nine-gap port delta.
2. Actual-head full CI, including build, must pass. Earlier-head check status cannot close this gate.
3. Owner-only live auth and production flag-ON onboarding acceptance remain explicitly separate, not replaced by mocks.
4. Independent reviewer GO and the designated merge workflow. Do not merge from this task.

## CI failure attribution from 92ce0626

Each script below passed on clean main8a9df323 and failed on this PR before its expectation update. No pre-existing failure was asserted.

| Script | Cause and scoped fix |
|---|---|
| test-public-shell | Two-word header brand, exact expectation updated. |
| test-loggedin-shell | Two-word rail brand, checks actual accessible label rather than comment text. |
| test-billing-autorenew | Two-word brand in unchanged499/month consent, exact wording updated. No provider/price change. |
| test-auth-presentation | Opaque surface intentionally hides background text. Exact opaque color and unchanged70/71stacking enforced. |
| test-tracker-resume-rebuild | Two-word brand in unchanged upgrade gate title. Gating assertions retained. |
| test-hide-empty-titles-heading | Two-word brand metadata suffix. |
| test-policy-pages | Two-word brand only, all policy/corporate/cancellation checks retained. |
| test-landing-job-hub-stats | Two-word brand in accessible stats name. Numbers untouched. |
| test-landing-comparison-section | Two-word brand in heading only; exact five cells and old-claim exclusions retained. |
| test-error-boundaries | Two-word visible fallback brand. |
| test-landing-parity | Two-word brand in founder metadata/bio only, all placement/size/layout/copy checks retained. |
| landing-ssampe-parity | Exact brand-spelling exception only. Pinned source hashes and class/link/order/assets constraints retained. All41negative controls still reject changed copy/layout/assets/runtime. |

The older Lighthouse advisory score67 remains below77 floor. It was not hidden or made a pass by these fixes. Final head CI and independent performance review remain required.
