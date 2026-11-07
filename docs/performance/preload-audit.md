# Preload of Critical Assets - Audit (2026-11-08)

Question: which critical assets need manual `<link rel="preload">` hints beyond
what the framework already emits?

Note on build modes: `output: "export"` is conditional in `next.config.mjs` -
omitted on Cloudflare Pages builds (`@cloudflare/next-on-pages`), kept on
Netlify and default local builds. `images.unoptimized: true` applies in both
modes, so `next/image` optimization is unavailable either way.

## What is already preloaded without manual hints

| Asset | Mechanism |
| --- | --- |
| Inter font files | `next/font/google` self-hosts at build time and emits preload links automatically |
| Route JS/CSS bundles | Next.js emits modulepreload/preload for the current route's chunks and CSS automatically |
| Founder photo (`/owner.jpg`) | `next/image` with `priority` on the landing bio card emits a preload |

## Above-the-fold images that are NOT preloaded (finding)

`LandingTopArtifact.tsx` (rendered by the landing page) contains two plain
`<img>` elements - not `next/image`, no `priority` - so the framework emits
no preload for them:

| Asset | Rendered size | File size | In artifact |
| --- | --- | --- | --- |
| `/icon.png` | 40x40 | 221,331 bytes | brand link icon (line ~675) |
| `/mascot.png` | 84x84 | 221,331 bytes | mascot "buddy" (line ~710, aria-hidden decorative) |

Both files are identical in size (221,331 bytes) and vastly oversized for
40px/84px display slots - a correctly sized WebP/AVIF at these dimensions is
roughly 2-10KB.

**Merit call: do NOT preload them at the current file size.** Preloading
~442KB of decorative imagery would compete with the font, CSS and JS that
actually gate first paint and would likely hurt LCP, not help it. The correct
fix is to right-size/convert the two assets - but they live on the landing
page, which is under an owner change freeze, and image replacement is a
visual-surface decision. **Finding for the owner: `/icon.png` and
`/mascot.png` are 221KB each for 40px/84px slots (~20-100x oversized);
recommend replacing with resized WebP/AVIF when landing changes are
unfrozen.**

## Other candidates considered and rejected

| Asset | Why no preload |
| --- | --- |
| `/careermonke-comparison-boxes.gif` (LandingComparisonSection) | Below the fold; preloading it would compete with true first-paint assets |
| `/careermonke-visuals.js` | Loaded via `<Script strategy="afterInteractive">` - intentionally deferred, not critical |
| `/careermonke.png` | Referenced only as the OG image URL; never rendered by the page itself |
| Company logos (unavatar.io / Supabase) | Cross-origin third-party content; covered by preconnect/dns-prefetch hints (FE row 23) instead, which is the correct primitive for many small cross-origin images |

## Conclusion

Framework preloads cover the font, route bundles and priority images. The two
landing artifact images are NOT preloaded and NOT worth preloading at 221KB
each; they need right-sizing first (owner decision, landing freeze). FE sheet
row 98 stays PARTIAL until the oversized landing assets are addressed or the
owner decides otherwise.

Revisit when: the landing freeze lifts, the two artifact images are
right-sized, or a hero image/video, critical JSON payload, or third-party
font is added above the fold on any entry page.
