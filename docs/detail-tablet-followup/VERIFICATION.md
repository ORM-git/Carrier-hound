# Job detail tablet follow-up

Base: main `148a5ef118ea83dc5561e8c5520ff2579d5bf038`, after #722. Only two production display changes.

## Tablet header

The signed-in-style real-component fixture reproduced overlap at 768px between Original Job Post and the Hide/Save controls. It did not reproduce overlap at 360/390/1440. The header now wraps utility and primary actions within the existing design only from md to below lg. No labels or actions are removed.

`tablet-detail.cjs` checks pairwise action rectangles and center hit targets, page overflow, and captures pixels at 360/390/768/1440. At 768px there is no overlap after the fix. All action and header rectangles at the other three widths are exactly equal to the pre-fix baseline. All four header screenshots were directly inspected.

## Escaped description text

This is fixable in the display layer. The previous markup stripper retained escaped whitespace such as `&amp;nbsp;`. A small job-description-only formatter decodes common named and numeric entities with at most three passes, then applies the existing executable-markup stripper. The result is interpolated as React text, never inserted as HTML. It preserves line breaks and leaves unknown named entities unchanged. Stored job records, ingestion and database contents are untouched.

Tests cover single/double/triple escaping, numeric whitespace, punctuation, Unicode, invalid numeric values, decoded executable markup and inert React output. Browser fixture description begins with the double-escaped whitespace case and renders readable text at all four widths. Description screenshots at 360 and 768 were directly inspected.

## Checks

- Full unit suite, serial shards: 353 + 411 + 403 + 428 = 1,595 tests / 164 files, all pass.
- Focused job/detail/description suites: 89/89 pass.
- Typecheck passes.
- Lint: 0 errors / 252 existing warnings.
- Security XSS/CSP/upload script: 71 checks pass. Job-detail polish and redesign source guards pass.
- Browser regression at four widths passes, including no collision, hit-target centers, no horizontal overflow and unchanged control geometry at 360/390/1440.
- No full build claimed locally. Exact-head CI and independent review remain required.

All screenshots use synthetic data and controlled auth/service boundaries. External requests are blocked. Synthetic score 83 proves layout only, not score accuracy. No production auth, account writes, ingestion, schema changes or payments were performed. This follow-up does not merge or deploy itself.
