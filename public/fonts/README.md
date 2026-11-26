# Locally bundled existing site fonts

These are unchanged WOFF2 font files served by Google Fonts for the site's existing requests. Both families are licensed under SIL Open Font License 1.1. Each family's OFL.txt retains its copyright and license notice.

- Inter: https://fonts.google.com/specimen/Inter
- Plus Jakarta Sans: https://fonts.google.com/specimen/Plus+Jakarta+Sans
- Inter license source: https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt
- Plus Jakarta Sans license source: https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/OFL.txt

`sources.json` records every original asset URL and SHA-256. Files were fetched 2026-11-26. The accompanying CSS retains the original normal styles, requested weights, unicode ranges and swap display. The existing Google loader emitted every unicode face but preloaded only the requested subsets. This version keeps that behavior: Inter latin, and Plus Jakarta Sans latin and latin-ext.

Inter's Arial fallback overrides are the values returned by the existing Next 14.2.35 Google loader for Inter: ascent 90.49%, descent 22.56%, line gap 0%, size adjust 107.06%. Plus Jakarta Sans keeps adjustFontFallback=false, so missing glyphs continue down the existing CSS system-font fallback list. No font files were modified, subsetted or renamed internally.

This removes build-time Google font requests. The installed loader assumes each URL ends in a font extension; Google's extensionless font URL form can violate that assumption. No loader/package/workflow bypass is used.
