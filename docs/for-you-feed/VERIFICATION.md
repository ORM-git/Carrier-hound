# For You feed polish

Base: f8a51e8b32ae7a4086f78fa8cf79c7c3af812977.

- For You replaces Recommended and has no count.
- Recommended sort trigger offers Top matched and Most recent. Match is the default; explicit Most recent is honored by first-page fetch, pagination and client ordering. URL history preserves the choice.
- Scroll loading now works on all screen widths. The existing per-page fresh downward input gate, single-flight loader, error pause, empty-page pause and accessible manual fallback remain.
- Removed the line between title/tags and metadata. Menu now sits immediately left of the heart on mobile, tablet and desktop.
- Score ring unchanged, pending the owner's reference image.

Verification:
- TypeScript passes.
- 100 focused tests across 14 files pass, including real-page sort/pagination integration.
- ESLint on changed runtime files: 0 errors, 10 existing warnings.
- 37 browser integration checks pass (see feed-integration.json).
- Native IntersectionObserver at 360, 390, 768, 1440: End then PageUp loads page 2, stays at 50 cards for 3 seconds idle; fresh End loads page 3. See scroll-intent.json.
- Inspected settled screenshots at all four widths, with no title/tag divider or menu overlap. Synthetic fixture content and scores, not production score accuracy evidence. No external requests or production writes.
- Full-suite runs exceeded the command time limit before completion; no full-suite pass claimed. CI remains the full-suite gate.

Reproduce: node scripts/mobile-715/build.cjs; npx tailwindcss -i src/app/globals.css -o reports/mobile-715/tailwind.css; node scripts/mobile-715/for-you-scroll.cjs; node scripts/mobile-715/feed-integration.cjs.

## Reference follow-up

Owner supplied the score-ring reference on Nov24 at 16:54. Feed rings retain the same size and position, with a thinner blue-gradient score arc and smaller percent sign. Mobile stroke 2.5px, desktop/tablet 3px. Each ring has a unique gradient ID; score values and scoring inputs unchanged.

Normal flow now has only sentinel and non-interactive loading status. Button appears only for error or paused empty/duplicate-page recovery. No remaining count on any screen. Native IO checks repeated at 360/390/768/1440: 50 idle then 75 on fresh End. After 75 cards, DOM asserts no Load More button and captures at 390/1440 show the last card, sentinel gap and footer with no button. Fresh-input gate unchanged.

100 focused tests pass again; typecheck passes. Updated ring screenshots inspected at all four widths. Only fixture pixels, not live score accuracy evidence.
