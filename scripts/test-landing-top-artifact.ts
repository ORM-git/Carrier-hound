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
  console.log("       LANDING TOP FOLD & LOWER PAGE RUNTIME VERIFICATION SUITE                   ");
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
  const previewSrc = fs.readFileSync(path.join(ROOT, "src/components/landing/LandingJobsPreview.tsx"), "utf8");
  const cssSrc = fs.readFileSync(cssPath, "utf8");
  const lowerCssSrc = fs.readFileSync(path.join(ROOT, "src", "styles", "careermonke-landing-lower.css"), "utf8");
  // JSX wraps long copy across lines; compare copy on whitespace-normalised source.
  const flatSrc = pageSrc.replace(/\{" "\}/g, " ").replace(/\s+/g, " ");

  // 1. Exact 1:1 Headline and Hero Copy (new top fold, ssampe@f21504b)
  assert.ok(
    pageSrc.includes('<p className="kicker">Skip LinkedIn competition</p>') &&
      // approved hero: ssampe@3386250 ascending m/a/x/x inside a no-wrap "jobmaxxing", "with AI" kept together
      /<h1 aria-label="Start jobmaxxing with AI"> Start <span className="nw"> job <span className="mx"> <span className="m1" aria-hidden="true"> m <\/span> <span className="m2" aria-hidden="true"> a <\/span> <span className="m3" aria-hidden="true"> x <\/span> <span className="m4" aria-hidden="true"> x <\/span> <\/span> ing <\/span> with&nbsp;AI <\/h1>/.test(flatSrc),
    "page.tsx must contain exact kicker 'Skip LinkedIn competition' and headline 'Start jobmaxxing with AI' with the ascending maxx letters"
  );
  assert.ok(
    pageSrc.includes('className="pill daily-count-pending" aria-hidden="true"') && pageSrc.includes("Daily jobs count pending verification") && !pageSrc.includes("1,240 new jobs found today"),
    "Daily count stays hidden until verified automatic backend is available"
  );
  assert.ok(
    flatSrc.includes("Find verified employer jobs and tailor your resume to clear their ATS in seconds."),
    "page.tsx must contain lead copy about verified employer jobs"
  );
  assert.ok(
    pageSrc.includes("Sign up for free"),
    "page.tsx must contain 'Sign up for free'"
  );

  // 2. Working Navigation and CTAs wired to real routes
  assert.ok(pageSrc.includes('href="/signup" className="btn-dark"'), "Top nav Sign up for free must link to /signup");
  assert.ok(pageSrc.includes('href="/login" className="btn-ghost"'), "Top nav Sign in must link to /login");
  assert.ok(pageSrc.includes('href="/radar"'), "Lower page must link to /radar");
  assert.ok(pageSrc.includes('href="/jobs" className="btn-cta"'), "Top-fold View Jobs must link to /jobs");
  assert.ok(!pageSrc.includes('id="try-demo"'), "Old hero #try-demo button must not come back");

  assert.ok(pageSrc.includes("<LandingJobsPreview />"), "Home must adopt actual shared Jobs preview");
  assert.ok(previewSrc.includes('import JobCardContent from "@/components/jobs/JobCardContent"') && previewSrc.includes("<JobCardContent"), "Preview must adopt shared Jobs renderer");
  assert.equal((previewSrc.match(/href="\/jobs"/g) || []).length, 3, "Preview action types must all open Jobs");

  // 3. Top fold: full first card and a faded fixed 120px crop of the second above the CTA
  assert.ok(previewSrc.includes('data-testid="landing-job-card"'), "Preview must render real Jobs card structure");
  assert.ok(previewSrc.includes('index === 1 ? "peek"') && previewSrc.includes('aria-hidden={index === 1 || undefined}'), "Second card must stay faded and hidden from assistive technology");
  assert.ok(!pageSrc.includes('id="demo"'), "Old interactive demo must not come back");

  // 4. Old demo states stay removed
  for (const st of ["pick", "scan", "match", "applied"]) {
    assert.ok(!pageSrc.includes(`data-state="${st}"`), `Old demo state '${st}' must not come back`);
  }

  // 5. Brand Styling in CSS: top fold tokens (scoped .cm-top) and lower-page tokens (scoped .landing-wrapper)
  assert.ok(cssSrc.includes("--blue: #2563eb;"), "careermonke-landing.css must define top-fold blue #2563eb");
  assert.ok(cssSrc.includes("--navy: #0b1035;"), "careermonke-landing.css must define top-fold navy #0b1035");
  assert.ok(lowerCssSrc.includes("--blue:#2563EB"), "careermonke-landing-lower.css must define brand blue #2563EB");
  assert.ok(lowerCssSrc.includes("--navy:#090E34"), "careermonke-landing-lower.css must define brand navy #090E34");

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
    assert.ok(!pat.test(lowerCssSrc), `Lower landing CSS must not have global unscoped selector matching ${pat}`);
  }

  // 6. Runtime Interactive Verification (React Strict Mode mount -> cleanup -> remount simulation)
  console.log("  Testing runtime mount -> cleanup -> remount (React Strict Mode safe)...");
  const { JSDOM } = await import("jsdom");
  const { performance } = await import("node:perf_hooks");
  const { initCareerMonkeLanding } = await import("../src/components/landing/careermonke-landing-runtime");
  const { initCareerMonkeLandingLower } = await import("../src/components/landing/careermonke-landing-lower-runtime");

  // Extract the composite page markup (.cm-top fold + .landing-wrapper lower page) from pageSrc
  const wrapperMatch = pageSrc.match(/return \(\s*<>([\s\S]*?)<\/>\s*\);\s*\}/);
  assert.ok(wrapperMatch, "page.tsx must render the .cm-top fold and the .landing-wrapper lower page as siblings");
  const cleanMarkup = wrapperMatch[1]
    .replace("<LandingJobsPreview />", '<section class="landing-actual-preview"><article data-testid="landing-job-card"></article><div class="peek" aria-hidden="true"><article data-testid="landing-job-card"></article></div></section>')
    .replace('className="cm-top cm-jakarta-font"', 'class="cm-top cm-jakarta-font"')
    .replace(/\sref=\{lowerRef\}/, "")
    .replace(/className=/g, "class=")
    .replace(/tabIndex=\{(-?\d+)\}/g, 'tabindex="$1"')
    .replace(/style=\{\{[^}]*\}\}/g, "")
    .replace(/\{" "\}/g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(cleanMarkup.includes('<div class="cm-top cm-jakarta-font">'), "Top fold must be wrapped in .cm-top");
  assert.ok(cleanMarkup.includes('<div class="landing-wrapper">'), "Lower page must be wrapped in .landing-wrapper");

  const dom = new JSDOM(`<!DOCTYPE html><html><body>${cleanMarkup}</body></html>`, {
    url: "http://localhost:3000",
    pretendToBeVisual: true,
  });

  // Polyfill browser globals, counting every listener / frame / timer / observer so leaks are visible
  const live = { listeners: 0, frames: new Set<any>(), timers: new Set<any>(), observers: 0 };
  globalThis.window = dom.window as any;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  globalThis.performance = performance as any;
  (globalThis as any).innerHeight = 800;
  const ET = dom.window.EventTarget.prototype as any;
  const add = ET.addEventListener;
  const remove = ET.removeEventListener;
  ET.addEventListener = function (...a: any[]) { live.listeners++; return add.apply(this, a); };
  ET.removeEventListener = function (...a: any[]) { live.listeners--; return remove.apply(this, a); };
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  const realSetInterval = setInterval;
  const realClearInterval = clearInterval;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = realSetTimeout(() => { live.frames.delete(id); cb(performance.now()); }, 16);
    live.frames.add(id);
    return id;
  }) as any;
  globalThis.cancelAnimationFrame = ((id: any) => { live.frames.delete(id); realClearTimeout(id); }) as any;
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
    const id = realSetTimeout(() => { live.timers.delete(id); fn(); }, ms);
    live.timers.add(id);
    return id;
  };
  (globalThis as any).clearTimeout = (id: any) => { live.timers.delete(id); realClearTimeout(id); };
  (globalThis as any).setInterval = (fn: () => void, ms?: number) => { const id = realSetInterval(fn, ms); live.timers.add(id); return id; };
  (globalThis as any).clearInterval = (id: any) => { live.timers.delete(id); realClearInterval(id); };
  (dom.window as any).requestAnimationFrame = globalThis.requestAnimationFrame;
  (dom.window as any).cancelAnimationFrame = globalThis.cancelAnimationFrame;
  let reduceMotion = false;
  (dom.window as any).matchMedia = () => ({ matches: reduceMotion, addListener: () => {}, removeListener: () => {} });
  globalThis.matchMedia = (dom.window as any).matchMedia;
  class MockObserver {
    constructor(_cb?: unknown) {}
    observe() { live.observers++; }
    unobserve() {}
    disconnect() { live.observers = Math.max(0, live.observers - 1); }
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
  globalThis.IntersectionObserver = MockObserver as any;
  (dom.window as any).IntersectionObserver = MockObserver as any;
  globalThis.ResizeObserver = MockObserver as any;
  (dom.window as any).ResizeObserver = MockObserver as any;
  (dom.window.Element.prototype as any).scrollIntoView = () => {};

  const lowerRoot = document.querySelector<HTMLElement>(".landing-wrapper")!;
  // New shared preview deliberately uses the CSS 120px peek fallback; legacy observer must no-op.
  const stopAbsentLegacyCard = initCareerMonkeLanding();
  stopAbsentLegacyCard();
  assert.strictEqual(live.observers, 0, "Shared preview without first-card must not create the legacy observer");
  assert.ok(cssSrc.includes("var(--peek-h, 120px)"), "Shared preview keeps the approved CSS peek fallback");
  document.querySelector('[data-testid="landing-job-card"]')!.id = "first-card";
  const mount = () => {
    const stopTop = initCareerMonkeLanding();
    const stopLower = initCareerMonkeLandingLower(lowerRoot);
    assert.strictEqual(typeof stopTop, "function", "initCareerMonkeLanding must return a cleanup function");
    assert.strictEqual(typeof stopLower, "function", "initCareerMonkeLandingLower must return a cleanup function");
    return () => { stopTop(); stopLower(); };
  };
  const assertNothingLive = (when: string) => {
    assert.strictEqual(live.listeners, 0, `${when}: every listener must be removed (left ${live.listeners})`);
    assert.strictEqual(live.frames.size, 0, `${when}: every animation frame must be cancelled (left ${live.frames.size})`);
    assert.strictEqual(live.timers.size, 0, `${when}: every timer must be cleared (left ${live.timers.size})`);
    assert.strictEqual(live.observers, 0, `${when}: every observer must be disconnected (left ${live.observers})`);
  };

  // Mount 1 (full motion) -> Cleanup 1 (Unmount in Strict Mode)
  const cleanup1 = mount();
  assert.ok(live.listeners > 0 && live.frames.size > 0 && live.observers > 0, "Mount must start listeners, frames and observers");
  assert.ok(
    document.querySelector<HTMLElement>(".cm-top .peek")!.style.getPropertyValue("--peek-h"),
    "Top runtime must size the half-visible second card"
  );
  await new Promise((r) => realSetTimeout(r, 50));
  cleanup1();
  assertNothingLive("after Strict Mode unmount");

  // Mount 2 (Remount in Strict Mode)
  const cleanup2 = mount();

  // Sticky View Jobs bar: hidden above the comparison, shown once it is reached, hidden again on scroll back
  const bar = lowerRoot.querySelector<HTMLElement>(".sb")!;
  const cmpSection = lowerRoot.querySelector("#vs")!.closest("section")!;
  let cmpTop = 2000;
  (cmpSection as any).getBoundingClientRect = () => ({ top: cmpTop });
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.ok(!bar.classList.contains("on"), "Sticky bar must stay hidden above the comparison section");
  cmpTop = 300;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.ok(bar.classList.contains("on"), "Sticky bar must appear once the comparison section is reached");
  cmpTop = 2000;
  dom.window.dispatchEvent(new dom.window.Event("scroll"));
  assert.ok(!bar.classList.contains("on"), "Sticky bar must hide again when scrolling back above the comparison");

  // Final cleanup must execute cleanly, and Back (unmount) leaves nothing running
  cleanup2();
  assertNothingLive("after final unmount");

  // Reduced motion: no card timers are scheduled, and cleanup is still complete
  reduceMotion = true;
  const cleanup3 = mount();
  assert.strictEqual(live.timers.size, 0, "Reduced motion must not schedule card timers");
  cleanup3();
  assertNothingLive("after reduced-motion unmount");

  console.log("  [PASS-LOCAL] All top fold, lower page runtime and cleanup assertions passed cleanly.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
