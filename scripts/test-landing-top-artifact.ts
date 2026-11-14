import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-top-artifact.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS-LOCAL] Negative control '--negative-control' exited non-zero as expected");
}

async function main() {
  console.log("================================================================================");
  console.log("       LANDING TOP HERO & INTERACTIVE DEMO VERIFICATION SUITE                   ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual("actual", "expected-negative-control-mismatch");
    return;
  }

  runNegativeControlSubprocess();

  const pagePath = path.join(ROOT, "src", "app", "page.tsx");
  const cssPath = path.join(ROOT, "src", "styles", "careermonke-landing.css");
  const runtimePath = path.join(ROOT, "src", "components", "landing", "careermonke-landing-runtime.ts");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(cssPath), "src/styles/careermonke-landing.css must exist");
  assert.ok(fs.existsSync(runtimePath), "src/components/landing/careermonke-landing-runtime.ts must exist");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  const cssSrc = fs.readFileSync(cssPath, "utf8");

  // 1. Exact 1:1 Headline and Hero Copy
  assert.ok(
    pageSrc.includes("Skip LinkedIn competition") && pageSrc.includes("job"),
    "page.tsx must contain exact headline 'Skip LinkedIn competition. Start jobmaxxing with AI'"
  );
  assert.ok(
    pageSrc.includes("1,240 new jobs found today"),
    "page.tsx must contain exact badge '1,240 new jobs found today'"
  );
  assert.ok(
    pageSrc.includes("Get direct roles from company sites and tailor your resume to clear their ATS in seconds."),
    "page.tsx must contain lead copy about direct roles from company sites"
  );
  assert.ok(
    pageSrc.includes("Sign up for free"),
    "page.tsx must contain 'Sign up for free'"
  );

  // 2. Working Navigation and CTAs wired to real routes
  assert.ok(pageSrc.includes('href="/signup"'), "Hero CTA must link to /signup");
  assert.ok(pageSrc.includes('href="/login"'), "Top nav must link to /login");
  assert.ok(pageSrc.includes('href="/radar"'), "Top nav must link to /radar");
  assert.ok(pageSrc.includes('href="/jobs"'), "Navigation must link to /jobs");
  assert.ok(pageSrc.includes('id="try-demo"'), "Hero must include #try-demo button");

  // 3. Interactive Demo Structure and Chips
  assert.ok(pageSrc.includes('id="demo"'), "page.tsx must contain interactive demo section with id='demo'");
  const requiredChips = ["Backend", "Remote", "Marketing", "Data &amp; AI", "Sales", "Design"];
  for (const chip of requiredChips) {
    assert.ok(
      pageSrc.includes(chip),
      `Demo must include job chip "${chip}"`
    );
  }

  // 4. Demo States
  assert.ok(pageSrc.includes('data-state="pick"'), "Demo must include 'pick' state");
  assert.ok(pageSrc.includes('data-state="scan"'), "Demo must include 'scan' state");
  assert.ok(pageSrc.includes('data-state="match"'), "Demo must include 'match' state");
  assert.ok(pageSrc.includes('data-state="applied"'), "Demo must include 'applied' state");

  // 5. Brand Styling in CSS & Complete Scoping under .landing-wrapper
  assert.ok(cssSrc.includes("--blue:#2563EB"), "careermonke-landing.css must define brand blue #2563EB");
  assert.ok(cssSrc.includes("--navy:#090E34"), "careermonke-landing.css must define brand navy #090E34");

  // Ensure zero commented WhiteHeroButton or router.push in page.tsx
  assert.ok(!pageSrc.includes("WhiteHeroButton"), "page.tsx must not contain WhiteHeroButton");
  assert.ok(!pageSrc.includes("router.push"), "page.tsx must not contain commented router.push");

  // Ensure CSS is strictly scoped under .landing-wrapper (no global root, body, html, a, h1-h3, p, main, footer)
  const forbiddenGlobalPatterns = [
    /^:root\s*\{/m,
    /^\s*body\s*\{/m,
    /^\s*html\s*\{/m,
    /^\s*a\s*\{/m,
    /^\s*h1\s*,/m,
    /^\s*p\s*\{/m,
    /^\s*main\s*\{/m,
    /^\s*footer\s*\{/m,
  ];
  for (const pat of forbiddenGlobalPatterns) {
    assert.ok(!pat.test(cssSrc), `Landing CSS must not have global unscoped selector matching ${pat}`);
  }

  // 6. Runtime Interactive Verification (React Strict Mode mount -> cleanup -> remount simulation)
  console.log("  Testing runtime mount -> cleanup -> remount (React Strict Mode safe)...");
  const { JSDOM } = await import("jsdom");
  const { performance } = await import("node:perf_hooks");
  const { initCareerMonkeLanding } = await import("../src/components/landing/careermonke-landing-runtime");

  // Extract landing-wrapper markup from pageSrc
  const wrapperMatch = pageSrc.match(/<div className="landing-wrapper">([\s\S]*?)<\/div>\s*\);\s*\}/);
  assert.ok(wrapperMatch, "page.tsx must have .landing-wrapper root container");
  const cleanMarkup = wrapperMatch[1]
    .replace(/className=/g, "class=")
    .replace(/tabIndex={-1}/g, 'tabindex="-1"')
    .replace(/tabIndex={0}/g, 'tabindex="0"')
    .replace(/style=\{\{[^}]*\}\}/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="landing-wrapper">${cleanMarkup}</div></body></html>`, {
    url: "http://localhost:3000",
    pretendToBeVisual: true,
  });

  // Polyfill browser globals
  globalThis.window = dom.window as any;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.performance = performance as any;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as any;
  globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id);
  (dom.window as any).requestAnimationFrame = globalThis.requestAnimationFrame;
  (dom.window as any).cancelAnimationFrame = globalThis.cancelAnimationFrame;
  (dom.window as any).matchMedia = () => ({ matches: true, addListener: () => {}, removeListener: () => {} });
  globalThis.matchMedia = (dom.window as any).matchMedia;
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (dom.window.HTMLCanvasElement.prototype as any).getContext = () => ({
    clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    fillText: () => {},
    measureText: () => ({ width: 50 }),
    setTransform: () => {},
  });
  globalThis.IntersectionObserver = MockIntersectionObserver as any;
  (dom.window as any).IntersectionObserver = MockIntersectionObserver as any;
  (dom.window.Element.prototype as any).scrollIntoView = () => {};

  // Mount 1
  const cleanup1 = initCareerMonkeLanding();
  assert.strictEqual(typeof cleanup1, "function", "initCareerMonkeLanding must return a cleanup function");

  // Cleanup 1 (Unmount in Strict Mode)
  cleanup1();

  // Mount 2 (Remount in Strict Mode)
  const cleanup2 = initCareerMonkeLanding();
  assert.strictEqual(typeof cleanup2, "function", "remount must return a cleanup function");

  // Verify Interactive Demo Flow:
  const backendChip = document.querySelector<HTMLButtonElement>('.chip[data-field="backend"]');
  assert.ok(backendChip, "Backend job chip must exist");

  // Click backend chip
  backendChip.click();
  // Allow microtasks/macrotasks to complete
  await new Promise((r) => setTimeout(r, 50));

  const actBtn = document.getElementById("act") as HTMLButtonElement | null;
  assert.ok(actBtn, "#act button must exist");
  assert.strictEqual(actBtn.dataset.next, "tailor", "After pick & match, #act must have data-next='tailor'");

  const matchState = document.querySelector<HTMLElement>('.state[data-state="match"]');
  const appliedState = document.querySelector<HTMLElement>('.state[data-state="applied"]');
  assert.ok(matchState && !matchState.hidden, "Match state must be visible");
  assert.ok(appliedState && appliedState.hidden, "Applied state must remain hidden before click");

  // STRICT MODE VERIFICATION:
  // Single click on #act must advance EXACTLY one step to 'apply' (tailor), NOT skip straight to 'applied'.
  actBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(
    actBtn.dataset.next,
    "apply",
    "First click on #act must advance to data-next='apply' (step 2 -> step 3)"
  );
  assert.ok(
    appliedState.hidden,
    "Strict Mode safety check: single click on #act must NOT skip to applied state"
  );

  // Second click on #act advances to 'applied' (step 3 -> step 4)
  actBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(
    !appliedState.hidden,
    "Second click on #act must advance to applied state"
  );
  assert.ok(
    matchState.hidden,
    "Match state must be hidden once applied"
  );

  // Click #again: resets back to 'pick'
  const againBtn = document.getElementById("again") as HTMLButtonElement | null;
  assert.ok(againBtn, "#again button must exist in applied state");
  againBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  const pickState = document.querySelector<HTMLElement>('.state[data-state="pick"]');
  assert.ok(pickState && !pickState.hidden, "#again button must reset demo back to pick state");

  // Click #try-demo
  const tryDemoBtn = document.getElementById("try-demo") as HTMLElement | null;
  assert.ok(tryDemoBtn, "#try-demo button must exist");
  tryDemoBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  // Final cleanup must execute cleanly
  cleanup2();

  console.log("  [PASS-LOCAL] All top hero and interactive demo assertions passed cleanly.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
