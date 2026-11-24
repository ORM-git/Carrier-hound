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

## Oval refinement

Owner clarified oval rather than circular on Nov24 at 17:04. Ring width/placement retained, height is 62% of width; the thin blue gradient and small percent sign remain. Native ellipse uses normalized pathLength=100, so partial arc length follows the actual score without an approximate circumference. Typecheck and ring tests pass; native scroll/no-button checks repeated at all four widths. Settled 390/1440 screenshots inspected.

## Jobright reference correction

The 17:08 correction supersedes the ellipse interpretation. Direct inspection of the supplied screenshot shows a capsule with straight horizontal sides and semicircular ends. Replaced the ellipse with a closed capsule path, ratio 104:58 from the screenshot, a pale neutral track, thin left-to-right blue gradient, white interior, and a smaller baseline percent sign. Progress starts just before the top-left tangent and follows normalized pathLength=100. Mobile 56x31 with 1.75px stroke; desktop 70x39 with 2.25px stroke. Actual score inputs unchanged.

Attached side-by-side comparisons normalize the original and fixture crops for inspection. Fixture-only 38% matches the source screenshot for the comparison, not a production score. Full viewport evidence is 390 and 1440 CSS px. Reference color intentionally changed from green to blue as requested. Screenshot font rasterization is not pixel-identical across source and fixture devices.

Typecheck and 2 ring tests pass. Native fresh-input/no-normal-button checks repeat at 360/390/768/1440. No merge performed.
