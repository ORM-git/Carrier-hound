# Preload of Critical Assets - Audit (2026-11-08)

Question: which critical assets need manual `<link rel="preload">` hints beyond
what the framework already emits?

## What is already preloaded without manual hints

| Asset | Mechanism |
| --- | --- |
| Inter font files | `next/font/google` self-hosts at build time and emits preload links automatically |
| Route JS/CSS bundles | Next.js emits modulepreload/preload for the current route's chunks and CSS automatically |
| Founder photo (`/owner.jpg`) | `next/image` with `priority` on the landing bio card emits a preload |

## Candidates considered and rejected

| Asset | Why no preload |
| --- | --- |
| `/careermonke-comparison-boxes.gif` (LandingComparisonSection) | Below the fold; preloading it would compete with true first-paint assets |
| `/careermonke-visuals.js` | Loaded via `<Script strategy="afterInteractive">` - intentionally deferred, not critical |
| `/careermonke.png` | Referenced only as the OG image URL; never rendered by the page itself |
| Company logos (unavatar.io / Supabase) | Cross-origin third-party content; covered by preconnect/dns-prefetch hints (FE row 23) instead, which is the correct primitive for many small cross-origin images |
| Hero / top artifact | CSS/DOM artifact rendered by LandingTopArtifact, no image asset to preload |

## Conclusion

Every critical first-paint asset is already preloaded by the framework
(font, route bundles, priority images). No manual preload hint is warranted;
adding one for the rejected candidates would measurably hurt LCP by competing
for early bandwidth. This audit is the evidence for FE sheet row 98
(Preload of critical assets).

Revisit when: a hero image/video, a critical JSON payload, or a third-party
font is added above the fold on any entry page.
