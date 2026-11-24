# Mobile 23-point verification ledger

PR #722 supersedes #715. No merge by this author. Independent review and actual-head CI remain required.

All screenshots are isolated fixtures with synthetic data and outbound requests blocked. Synthetic score values establish layout and event behavior only. Real handler score evidence is separate. No production auth, upload, account writes or payment acceptance was attempted.

## Current checks

- Latest local typecheck passed, lint 0 errors / 252 pre-existing warnings.
- Full unit suite rerun across four shards: 311 + 394 + 383 + 398 = 1,486 tests, 157 files. One earlier 2-worker inventory-preflight timeout passed on serial shard retry without a timeout change. Two additional saved-preference-revision route tests passed separately after shards 2-4, the complete recommended route suite is 40/40.
- Local full build was killed twice by the execution memory limit. This is not a build pass. Actual-head GitHub CI remains required. Older92ce CI build passed but test:all failed12 exact-copy scripts. All12 reproduced on this PR, all12 passed on clean main8a9df323. Updated exact brand expectations to Career Monke, auth backdrop to the opaque surface, and spelling-only landing exception with all41negative controls preserved; all12 now pass locally.
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

## Remaining gates

1. Independent review of the completed isolated matrices and the open-detail revision fix.
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
