# Display-only job description sections

Base: f8a51e8b32ae7a4086f78fa8cf79c7c3af812977, separate from feed PR #726.

Current data path:
- JobDetailView has optional source-list UI, but LiveJob does not declare those list fields.
- Pro APIs select description and skills. job_descriptions reads fetch description_text only, not the schema's structured section columns.
- Python fetchers put ATS source content through enrichment.strip_html into description. That parser already preserves block boundaries and bullet markers, making headed-list detection possible without ingestion edits.

Change:
- Display-only fallback detects exact recognized headings followed by bullet/numbered lists, including encoded HTML list structure.
- A paragraph or unknown heading stops extraction. No keyword-based guessing from prose. No new text is generated.
- Explicit source lists win over derived lists; duplicate strings are removed. All description text remains available in the existing Job description card.
- Existing Responsibilities / Qualifications (Required, Preferred) / Benefits cards stay in the left column at the bottom of Overview, immediately above Company details. Company tab anchors to that same Company card, not a different pane.
- No schema, ingestion, API, permissions, or production writes. No new tab or detached content area.

Verification:
- 113 tests across 18 files pass, including parser/security cases, explicit-list precedence, fallback, original description retention and section order.
- TypeScript passes. ESLint changed runtime files: 0 errors, 6 existing warnings.
- Browser fixture at 360/390/768/1440: extracted sections in correct order above Company, no horizontal overflow; screenshots inspected. Fixture text only. Coverage across actual stored descriptions is not measured, so unstructured/flattened text intentionally stays in the description.
- Reproduce: node scripts/mobile-715/build.cjs; npx tailwindcss -i src/app/globals.css -o reports/mobile-715/tailwind.css; node scripts/mobile-715/description-sections.cjs.

Full-suite CI/reviewer gate required. No merge by this author.
