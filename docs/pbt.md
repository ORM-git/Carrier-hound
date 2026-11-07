# Property-based testing (INTERNAL)

Backend sheet rank 19: "no fast-check; the sanitizers would benefit most."

## What exists now

- `scripts/test-pbt-sanitizers.ts` - a zero-dependency property-based
  test over the display sanitizers in `src/lib/security/xss.ts`
  (`stripControlChars`, `escapeHtml`, `stripHtmlAndExecutableMarkup`,
  `sanitizeExternalUrl`, `sanitizeInternalPath`,
  `sanitizeDownloadFilename`). A deterministic seeded RNG
  (mulberry32, seed 0xc0ffee - chosen default) generates 500 random +
  500 fragment-injected inputs per property (chosen default, labeled in
  the file) and asserts the safety invariants: no surviving control
  chars, no raw angle brackets after escaping, no script/style/iframe /
  event-handler / `javascript:` residue, allowed URL protocols only,
  clean internal paths, metachar-free bounded filenames.
- Registered at the end of SUITES in `scripts/suite-runner.ts`, so it
  runs in CI like every other offline suite.

## Why not fast-check yet

`package-lock.json` cannot be updated through the web commit flow (the
lockfile diff is too large to paste), so new npm dependencies are an
owner-side step. The harness encodes the same properties fast-check
would; swapping the generator for fast-check later is mechanical.

## Owner steps

1. Optional: `npm install --save-dev fast-check` locally, commit the
   updated `package.json` + `package-lock.json`, and port the generators.
2. No other action - the suite runs as-is.
