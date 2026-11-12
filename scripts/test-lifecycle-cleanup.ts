/**
 * CareerMonke Lifecycle & Memory-Leak Hygiene Offline Guard Suite
 *
 * Statically parses non-landing, non-test TypeScript/TSX modules under `src/`
 * using the TypeScript compiler AST and pairs resource registrations:
 *   - `addEventListener(...)` (unless `{ once: true }`) -> `removeEventListener(...)`
 *   - Observer creation / `.observe(...)` (IntersectionObserver / ResizeObserver / MutationObserver) -> `.disconnect(...)` or `.unobserve(...)`
 *   - `setInterval(...)` -> `clearInterval(...)`
 *   - `requestAnimationFrame(...)` -> `cancelAnimationFrame(...)`
 *   - `onAuthStateChange(...)` / `subscribeCandidateProfile(...)` -> `.unsubscribe(...)` or `unsubscribe(...)`
 *
 * Intentional app-lifetime listeners and documented exceptions must be listed
 * explicitly in `LIFECYCLE_ALLOWLIST` with a one-line justification comment and
 * documented in `docs/lifecycle-audit.md`.
 *
 * Run with: npx tsx scripts/test-lifecycle-cleanup.ts
 * Negative control check: npx tsx scripts/test-lifecycle-cleanup.ts --negative-control
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

export type ResourceKind =
  | "eventListener"
  | "observer"
  | "interval"
  | "animationFrame"
  | "subscription";

export interface LifecycleAllowlistEntry {
  file: string;
  kind: ResourceKind;
  reason: string;
}

export interface ResourceUsage {
  kind: ResourceKind;
  line: number;
  snippet: string;
}

export interface FileLifecycleReport {
  file: string;
  acquisitions: ResourceUsage[];
  cleanups: Set<ResourceKind>;
}

export interface LifecycleViolation {
  file: string;
  kind: ResourceKind;
  line: number;
  snippet: string;
  message: string;
}

/**
 * Documented allowlist for intentional app-lifetime listeners or verified
 * single-shot framework-scoped patterns in non-landing `src/`.
 * Every entry MUST explain why explicit remove/cancel pairing is omitted.
 */
export const LIFECYCLE_ALLOWLIST: LifecycleAllowlistEntry[] = [
  // Module-singleton cache invalidation listeners live for the full browser session
  {
    file: "src/lib/billing/subscription.ts",
    kind: "eventListener",
    reason: "Intentional app-lifetime singleton cache invalidators registered once at module init",
  },
  // OrbitControls instance is disposed on unmount via controls.dispose() (PR #441)
  // Note: window/document listeners in JobRadarGlobe still require & have removeEventListener,
  // verified directly in docs/lifecycle-audit.md and scripts/test-globe-cleanup.ts.
  // One-shot post-navigation window.scrollTo rAF (non-looping, no handle retained)
  {
    file: "src/app/jobs/page.tsx",
    kind: "animationFrame",
    reason: "One-shot post-close/popstate window.scrollTo restore rather than a recurring animation loop",
  },
  // One-shot menu-open focus rAF with optional-chained ref guard (non-looping)
  {
    file: "src/components/jobs/JobCardMenu.tsx",
    kind: "animationFrame",
    reason: "One-shot menu-open focus transfer guarded by itemRefs.current[0]?.focus()",
  },
];

const LANDING_EXCLUDED_FILES = new Set<string>([
  "src/app/page.tsx",
  "src/components/LandingGlobeFeatureSection.tsx",
  "src/components/LandingJobsTickerStrip.tsx",
  "src/components/LandingTopArtifact.tsx",
  "src/components/landing/careermonke-landing-runtime.ts",
]);

function walkSrcFiles(dir: string, repoRoot: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walkSrcFiles(full, repoRoot, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
      const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
      if (!LANDING_EXCLUDED_FILES.has(rel) && !rel.startsWith("src/components/landing/")) {
        out.push(rel);
      }
    }
  }
  return out;
}

function hasOnceTrueOption(arg: ts.Expression | undefined): boolean {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "once" &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

export function inspectLifecycleInSource(filePath: string, sourceText: string): FileLifecycleReport {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

  const acquisitions: ResourceUsage[] = [];
  const cleanups = new Set<ResourceKind>();

  const recordAcquisition = (kind: ResourceKind, node: ts.Node) => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 90);
    acquisitions.push({ kind, line: pos.line + 1, snippet });
  };

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        if (methodName === "addEventListener") {
          if (!hasOnceTrueOption(node.arguments[2])) {
            recordAcquisition("eventListener", node);
          }
        } else if (methodName === "removeEventListener") {
          cleanups.add("eventListener");
        } else if (methodName === "observe") {
          recordAcquisition("observer", node);
        } else if (methodName === "disconnect" || methodName === "unobserve") {
          cleanups.add("observer");
        } else if (methodName === "onAuthStateChange") {
          recordAcquisition("subscription", node);
        } else if (methodName === "unsubscribe") {
          cleanups.add("subscription");
        } else if (methodName === "dispose") {
          // OrbitControls.dispose() tears down OrbitControls-internal EventDispatcher listeners
          if (callee.expression.getText(sourceFile) === "controls") {
            cleanups.add("eventListener");
          }
        }
      } else if (ts.isIdentifier(callee)) {
        const fnName = callee.text;
        if (fnName === "setInterval") {
          recordAcquisition("interval", node);
        } else if (fnName === "clearInterval") {
          cleanups.add("interval");
        } else if (fnName === "requestAnimationFrame") {
          recordAcquisition("animationFrame", node);
        } else if (fnName === "cancelAnimationFrame") {
          cleanups.add("animationFrame");
        } else if (fnName === "subscribeCandidateProfile") {
          recordAcquisition("subscription", node);
        } else if (fnName === "unsubscribe") {
          cleanups.add("subscription");
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const ctor = node.expression.text;
      if (
        ctor === "IntersectionObserver" ||
        ctor === "ResizeObserver" ||
        ctor === "MutationObserver"
      ) {
        recordAcquisition("observer", node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // If a file calls `window.clearInterval` / `window.cancelAnimationFrame` via property access, record those too
  function visitWindowPrefixedCleanups(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      if (m === "clearInterval") cleanups.add("interval");
      if (m === "cancelAnimationFrame") cleanups.add("animationFrame");
      if (m === "setInterval") recordAcquisition("interval", node);
      if (m === "requestAnimationFrame") recordAcquisition("animationFrame", node);
    }
    ts.forEachChild(node, visitWindowPrefixedCleanups);
  }
  visitWindowPrefixedCleanups(sourceFile);

  return { file: filePath, acquisitions, cleanups };
}

export function validateLifecycleReports(reports: FileLifecycleReport[]): LifecycleViolation[] {
  const allowSet = new Set(LIFECYCLE_ALLOWLIST.map((a) => `${a.file}::${a.kind}`));
  const violations: LifecycleViolation[] = [];

  for (const report of reports) {
    const missingByKind = new Set<ResourceKind>();
    for (const acq of report.acquisitions) {
      if (report.cleanups.has(acq.kind)) continue;
      if (allowSet.has(`${report.file}::${acq.kind}`)) continue;
      if (missingByKind.has(acq.kind)) continue;
      missingByKind.add(acq.kind);
      violations.push({
        file: report.file,
        kind: acq.kind,
        line: acq.line,
        snippet: acq.snippet,
        message: `${report.file}:${acq.line} acquires '${acq.kind}' without matching cleanup in the same file (${acq.snippet})`,
      });
    }
  }

  return violations;
}

function runNegativeControlSubprocess(): never {
  const syntheticFiles: Array<{ file: string; code: string }> = [
    {
      file: "src/components/LeakyListenerWidget.tsx",
      code: `
      "use client";
      import { useEffect } from "react";
      export function LeakyListenerWidget() {
        useEffect(() => {
          window.addEventListener("resize", () => {});
        }, []);
        return null;
      }
      `,
    },
    {
      file: "src/components/LeakyObserverWidget.tsx",
      code: `
      "use client";
      import { useEffect, useRef } from "react";
      export function LeakyObserverWidget() {
        const ref = useRef<HTMLDivElement | null>(null);
        useEffect(() => {
          const io = new IntersectionObserver(() => {});
          if (ref.current) io.observe(ref.current);
        }, []);
        return <div ref={ref} />;
      }
      `,
    },
    {
      file: "src/components/LeakyIntervalWidget.tsx",
      code: `
      "use client";
      import { useEffect } from "react";
      export function LeakyIntervalWidget() {
        useEffect(() => {
          setInterval(() => {}, 1000);
        }, []);
        return null;
      }
      `,
    },
  ];

  const reports = syntheticFiles.map((s) => inspectLifecycleInSource(s.file, s.code));
  const violations = validateLifecycleReports(reports);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`NEGATIVE-CONTROL CAUGHT: ${v.message}`);
    }
    process.exit(1);
  }
  console.error("NEGATIVE-CONTROL ERROR: Expected violations were not detected!");
  process.exit(0);
}

function main() {
  if (process.argv.includes("--negative-control")) {
    runNegativeControlSubprocess();
  }

  const repoRoot = path.resolve(__dirname, "..");
  const files = walkSrcFiles(path.join(repoRoot, "src"), repoRoot).sort();
  const reports = files.map((rel) =>
    inspectLifecycleInSource(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"))
  );

  let passed = 0;
  let failed = 0;
  function check(name: string, fn: () => void) {
    try {
      fn();
      passed++;
      console.log(`PASS ${name}`);
    } catch (err: any) {
      failed++;
      console.error(`FAIL ${name}: ${err?.message || err}`);
    }
  }

  check("scanned non-landing src/ files pairing listeners/observers/intervals/RAFs/subscriptions with cleanups", () => {
    assert.ok(files.length >= 20, `Expected >=20 files scanned, got ${files.length}`);
    const violations = validateLifecycleReports(reports);
    assert.strictEqual(
      violations.length,
      0,
      `Found ${violations.length} lifecycle cleanup violation(s):\n${violations.map((v) => ` - ${v.message}`).join("\n")}`
    );
  });

  check("every LIFECYCLE_ALLOWLIST entry still matches an active acquisition without cleanup in src/", () => {
    const byFile = new Map(reports.map((r) => [r.file, r]));
    for (const entry of LIFECYCLE_ALLOWLIST) {
      assert.ok(entry.reason.trim().length > 0, `Allowlist entry ${entry.file} missing reason`);
      const report = byFile.get(entry.file);
      assert.ok(report, `Allowlisted file ${entry.file} no longer exists`);
      const hasAcq = report.acquisitions.some((a) => a.kind === entry.kind);
      assert.ok(hasAcq, `Stale allowlist entry ${entry.file} (${entry.kind}): acquisition no longer present`);
    }
  });

  check("fixed cleanups remain present in GlobeLiveStats, PageViewTracker, Typewriter variants, and auth callback", () => {
    const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert.ok(read("src/components/GlobeLiveStats.tsx").includes("cancelAnimationFrame("));
    const pvt = read("src/components/analytics/PageViewTracker.tsx");
    assert.ok(pvt.includes("cancelIdleCallback") && pvt.includes("clearTimeout("));
    assert.ok(read("src/components/ui/auth-ui.tsx").includes("pauseTimeout"));
    assert.ok(read("src/components/ui/typewriter-text.tsx").includes("pauseTimeout"));
    const cb = read("src/app/auth/callback/page.tsx");
    assert.ok(cb.includes("hashTimeoutId") && cb.includes("fallbackTimeoutId") && cb.includes("clearTimeout("));
  });

  check("docs/lifecycle-audit.md exists and documents PR #441, PR #447, allowlist entries, and audited files", () => {
    const docPath = path.join(repoRoot, "docs", "lifecycle-audit.md");
    assert.ok(fs.existsSync(docPath), "Missing docs/lifecycle-audit.md");
    const doc = fs.readFileSync(docPath, "utf8");
    for (const token of [
      "JobRadarGlobe.tsx",
      "forceContextLoss",
      "markersGroupRef",
      "disposablesRef",
      "controls.dispose",
      "renderer.dispose",
      "isCancelled",
      "GlobalErrorReporter.tsx",
      "#441",
      "#447",
    ]) {
      assert.ok(doc.includes(token), `docs/lifecycle-audit.md missing required token '${token}'`);
    }
    for (const entry of LIFECYCLE_ALLOWLIST) {
      assert.ok(doc.includes(entry.file), `docs/lifecycle-audit.md missing allowlist entry '${entry.file}'`);
    }
  });

  check("negative-control subprocess fails (exit 1) on uncleaned listener, observer, and interval", () => {
    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), __filename, "--negative-control"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.strictEqual(res.status, 1, `Expected exit 1 from negative control, got ${res.status}\n${res.stdout}\n${res.stderr}`);
    assert.ok(res.stderr.includes("LeakyListenerWidget.tsx"), "Negative control did not catch LeakyListenerWidget");
    assert.ok(res.stderr.includes("LeakyObserverWidget.tsx"), "Negative control did not catch LeakyObserverWidget");
    assert.ok(res.stderr.includes("LeakyIntervalWidget.tsx"), "Negative control did not catch LeakyIntervalWidget");
  });

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
