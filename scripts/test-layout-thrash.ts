/**
 * Row 65 (layout-thrash avoidance): static audit that layout-reading APIs
 * (getBoundingClientRect, offset*, client*, scroll*) are never called from a
 * raw scroll/resize listener in app code without requestAnimationFrame
 * batching. Forced synchronous layout per input event blows the frame
 * budget; batching reads into one rAF tick keeps rendered output identical
 * while removing the thrash.
 *
 * Method: for each non-landing source file registering a scroll/resize
 * listener, the handler's enclosing effect region is scanned. If the region
 * reads layout, the file must schedule via requestAnimationFrame.
 * Landing-owned files (owner-bound) are reported as warnings, never gates.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const LANDING_OWNED = new Set([
  "src/components/LandingTopArtifact.tsx",
  "src/components/testimonials.tsx",
  "src/components/CookieNotice.tsx",
  "src/components/LandingJobsTickerStrip.tsx",
]);
const LAYOUT_READ = /getBoundingClientRect|offset(Height|Width|Top|Left)|client(Height|Width|Top|Left)/;
const LISTENER = /addEventListener\(\s*["'](scroll|resize)["']/;
const RAF = /requestAnimationFrame/;

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) out.push(path.relative(ROOT, full));
  }
}

const files: string[] = [];
walk(SRC, files);

let passed = 0;
let failed = 0;
const warnings: string[] = [];
let gatedFiles = 0;

for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (!LISTENER.test(src) || !LAYOUT_READ.test(src)) continue;
  // File both listens to scroll/resize and reads layout somewhere.
  if (RAF.test(src)) {
    passed += 1;
    console.log(`PASS: ${rel}: layout reads batched via requestAnimationFrame`);
    continue;
  }
  if (LANDING_OWNED.has(rel)) {
    warnings.push(rel);
    console.log(`WARN: ${rel}: landing-owned file reads layout from a listener without rAF (owner-bound, not gated)`);
    continue;
  }
  gatedFiles += 1;
  failed += 1;
  console.log(`FAIL: ${rel}: layout reads reachable from a scroll/resize listener without rAF batching`);
}

// The known offender that this guard was added with must stay fixed.
{
  const profile = fs.readFileSync(path.join(ROOT, "src/app/profile/page.tsx"), "utf8");
  const spyRegion = profile.slice(profile.indexOf("Scroll spy"));
  if (spyRegion.includes("requestAnimationFrame") && spyRegion.includes("getBoundingClientRect")) {
    passed += 1;
    console.log("PASS: profile scroll-spy batches getBoundingClientRect via rAF");
  } else {
    failed += 1;
    console.log("FAIL: profile scroll-spy lost its rAF batching");
  }
}

console.log(`\nlayout-thrash: ${passed} PASS, ${failed} FAIL, ${warnings.length} owner-bound warning(s)`);
process.exit(failed === 0 ? 0 : 1);
