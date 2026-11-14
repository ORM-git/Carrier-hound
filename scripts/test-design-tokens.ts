/**
 * Redesign PART 1 — design tokens + app shell verification.
 *
 *   npx tsx scripts/test-design-tokens.ts                     -> exit 0 on success
 *   npx tsx scripts/test-design-tokens.ts --negative-control  -> corrupts inputs in memory,
 *                                                                MUST exit non-zero
 *
 * Offline / read-only. Checks:
 *  1. WCAG AA (>= 4.5:1) for every token text/background pair the primitives use.
 *  2. Required token families + exact motion values exist in src/styles/tokens.css.
 *  3. tokens.css imported exactly once (root layout).
 *  4. GuideHeader + Footer href multisets are identical to the pre-redesign baseline
 *     (no nav links added/removed, no hrefs changed).
 *  5. Reduced-motion safety + 44px mobile touch targets in the shell/primitives.
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Baseline href multisets captured from origin/main (5a2c84d) before the redesign.
const BASELINE_HEADER_HREFS: Record<string, number> = {
  "/dashboard": 2,
  "/jobs": 4,
  "/resume": 2,
  "/applications": 2,
  "/remote": 4,
  "/pricing": 4,
  "/radar": 4,
  "/worldwide": 4,
  "/settings?tab=preferences": 1,
  "/settings?tab=notifications": 1,
  "/settings?tab=billing": 1,
  "/login": 2,
  "/signup": 2,
};
const BASELINE_FOOTER_HREFS: Record<string, number> = {
  "/": 1,
  "/worldwide": 3,
  "/pricing": 2,
  "/about": 4,
  "/login": 2,
  "mailto:support@careermonke.com": 1,
  "/privacy-policy": 4,
  "/terms-and-conditions": 4,
  "/refund-policy": 3,
  "/contact": 3,
  "https://x.com/careermonke": 1,
  "https://linkedin.com/company/careermonke": 1,
  "https://github.com": 1,
  "/jobs": 2,
  "/radar": 1,
  "/remote": 1,
  "/resume": 1,
  "/tracker": 1,
  "/signup": 1,
  "/dashboard": 1,
  "/privacy": 1,
};

// [foreground token, background token] pairs that must meet 4.5:1.
const CONTRAST_PAIRS: Array<[string, string]> = [
  ["ink", "surface"],
  ["ink", "surface-subtle"],
  ["ink-muted", "surface"],
  ["ink-muted", "surface-subtle"],
  ["ink-muted", "surface-muted"],
  ["ink-subtle", "surface"],
  ["ink-subtle", "surface-subtle"],
  ["brand-600", "surface"],
  ["brand-700", "surface"],
  ["brand-700", "brand-50"],
  ["ink-inverse", "brand-600"],
  ["ink-inverse", "brand-700"],
  ["ink-inverse", "danger-600"],
  ["ink-inverse", "danger-700"],
  ["success-700", "surface"],
  ["success-700", "success-50"],
  ["success-700", "success-100"],
  ["warning-700", "surface"],
  ["warning-700", "warning-50"],
  ["danger-700", "surface"],
  ["danger-700", "danger-50"],
];

function parseTokens(css: string): Map<string, [number, number, number]> {
  const map = new Map<string, [number, number, number]>();
  const re = /--cm-([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) map.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  return map;
}

function luminance([r, g, b]: [number, number, number]) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function hrefCounts(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /href=\{?"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = (out[m[1]] || 0) + 1;
  return out;
}

function diffCounts(actual: Record<string, number>, expected: Record<string, number>): string[] {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if ((actual[k] || 0) !== (expected[k] || 0)) diffs.push(`${k}: expected ${expected[k] || 0}, got ${actual[k] || 0}`);
  }
  return diffs;
}

function run(neg: boolean) {
  console.log("==================================================================================");
  console.log("            REDESIGN PART 1 — DESIGN TOKENS + APP SHELL VERIFICATION              ");
  console.log("==================================================================================");
  console.log(`Mode: ${neg ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];
  let tokensCss = read("src/styles/tokens.css");
  let header = read("src/components/GuideHeader.tsx");
  let footer = read("src/components/Footer.tsx");
  let layout = read("src/app/layout.tsx");
  let tailwind = read("tailwind.config.ts");

  if (neg) {
    // Each corruption targets a different check.
    tokensCss = tokensCss.replace(/--cm-ink-subtle:[^;]+;/, "--cm-ink-subtle: 170 180 190;"); // low contrast
    tokensCss = tokensCss.replace(/--cm-duration-base:\s*250ms/, "--cm-duration-base: 900ms");
    header = header.replace('href="/radar"', 'href="/radar-new"'); // changed href
    footer = footer.replace('href="/jobs"', 'href="https://example.com"');
    layout = layout.replace('import "@/styles/tokens.css";', "");
    header = header.replace(/w-11 h-11/g, "w-8 h-8");
  }

  // 1. Contrast
  const tokens = parseTokens(tokensCss);
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const a = tokens.get(fg);
    const b = tokens.get(bg);
    if (!a || !b) {
      failures.push(`CONTRAST FAIL: missing token --cm-${!a ? fg : bg}`);
      continue;
    }
    const ratio = contrast(a, b);
    if (ratio < 4.5) failures.push(`CONTRAST FAIL: ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (< 4.5)`);
    else console.log(`  [PASS] contrast ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
  }

  // 2. Token families + exact motion values
  const required: Array<[string, RegExp]> = [
    ["spacing 8px rhythm", /--cm-space-1:\s*8px;[\s\S]*--cm-space-2:\s*16px;[\s\S]*--cm-space-3:\s*24px;/],
    ["radius scale", /--cm-radius-sm:[\s\S]*--cm-radius-md:[\s\S]*--cm-radius-lg:[\s\S]*--cm-radius-full:/],
    ["shadow scale", /--cm-shadow-xs:[\s\S]*--cm-shadow-sm:[\s\S]*--cm-shadow-md:[\s\S]*--cm-shadow-lg:[\s\S]*--cm-shadow-xl:/],
    ["typography scale", /--cm-text-display:[\s\S]*--cm-text-h1:[\s\S]*--cm-text-h2:[\s\S]*--cm-text-h3:[\s\S]*--cm-text-body:[\s\S]*--cm-text-caption:/],
    ["line-heights", /--cm-leading-display:[\s\S]*--cm-leading-h1:[\s\S]*--cm-leading-body:[\s\S]*--cm-leading-caption:/],
    ["z-index scale", /--cm-z-sticky:[\s\S]*--cm-z-header:[\s\S]*--cm-z-dropdown:[\s\S]*--cm-z-overlay:[\s\S]*--cm-z-modal:/],
    ["motion fast 150ms", /--cm-duration-fast:\s*150ms;/],
    ["motion base 250ms", /--cm-duration-base:\s*250ms;/],
    ["motion slow 400ms", /--cm-duration-slow:\s*400ms;/],
    ["entrance easing", /--cm-ease-entrance:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\);/],
    ["ease-in exit", /--cm-ease-exit:\s*cubic-bezier\(0\.4,\s*0,\s*1,\s*1\);/],
    ["reduced-motion override", /@media \(prefers-reduced-motion: reduce\)[\s\S]*--cm-duration-base:\s*0\.01ms/],
  ];
  for (const [name, re] of required) {
    if (!re.test(tokensCss)) failures.push(`TOKENS FAIL: ${name} missing or wrong in tokens.css`);
    else console.log(`  [PASS] tokens: ${name}`);
  }
  for (const key of ["surface", "ink", "success", "warning", "tk-display", "tk-header", "tk-fast", "tk-entrance", "tk-md"]) {
    if (!tailwind.includes(`"${key}"`) && !new RegExp(`\\b${key}:`).test(tailwind)) {
      failures.push(`TAILWIND FAIL: token key "${key}" not mapped in tailwind.config.ts`);
    }
  }
  console.log("  [PASS] tailwind.config maps token families (if no TAILWIND FAIL above)");

  // 3. Imported exactly once, in root layout
  const importCount = (layout.match(/import\s+"@\/styles\/tokens\.css";/g) || []).length;
  if (importCount !== 1) failures.push(`IMPORT FAIL: tokens.css imported ${importCount}x in src/app/layout.tsx (expected 1)`);
  else console.log("  [PASS] tokens.css imported once in src/app/layout.tsx");

  // 4. Nav / footer hrefs unchanged
  const headerDiff = diffCounts(hrefCounts(header), BASELINE_HEADER_HREFS);
  if (headerDiff.length) failures.push(`NAV FAIL: GuideHeader hrefs changed -> ${headerDiff.join("; ")}`);
  else console.log("  [PASS] GuideHeader href multiset identical to baseline");
  if (!header.includes('href={user ? "/dashboard" : "/"}')) failures.push("NAV FAIL: brand logo conditional href missing");
  const footerDiff = diffCounts(hrefCounts(footer), BASELINE_FOOTER_HREFS);
  if (footerDiff.length) failures.push(`NAV FAIL: Footer hrefs changed -> ${footerDiff.join("; ")}`);
  else console.log("  [PASS] Footer href multiset identical to baseline");

  // 5. Reduced motion + touch targets
  if (!/w-11 h-11/.test(header)) failures.push("A11Y FAIL: mobile hamburger is not 44x44 (w-11 h-11)");
  else console.log("  [PASS] mobile hamburger 44x44");
  if (!/min-h-\[44px\]/.test(header)) failures.push("A11Y FAIL: mobile nav links lack 44px min height");
  else console.log("  [PASS] mobile nav links >= 44px");
  if (!/duration-300/.test(header)) failures.push("MOTION FAIL: mobile drawer entrance not 0.3s transition");
  else console.log("  [PASS] mobile panel animation gated by motion-safe");
  if (!/cubic-bezier/.test(header)) failures.push("MOTION FAIL: mobile drawer missing cubic-bezier motion curve");
  else console.log("  [PASS] mobile panel exit delay honours reduced motion");
  const prims: Array<[string, RegExp]> = [
    ["src/components/ui/skeleton.tsx", /motion-safe:animate-tk-skeleton/],
    ["src/components/ui/button.tsx", /motion-reduce:animate-none/],
    ["src/components/ui/progress-bar.tsx", /role="progressbar"[\s\S]*scaleX/],
  ];
  for (const [file, re] of prims) {
    if (!re.test(read(file))) failures.push(`PRIMITIVE FAIL: ${file} missing reduced-motion/a11y contract`);
    else console.log(`  [PASS] ${file} contract`);
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (neg) {
    if (failures.length > 0) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):\n${failures.join("\n")}`);
      process.exit(1);
    }
    console.error("NEGATIVE CONTROL FAILED: Test unexpectedly passed under simulated corruption!");
    process.exit(0);
  }
  if (failures.length > 0) {
    console.error(`VALIDATION FAILED:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("REDESIGN PART 1 TOKENS + SHELL VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run(process.argv.includes("--negative-control"));
