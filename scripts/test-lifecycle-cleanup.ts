/**
 * CareerMonke Lifecycle & Memory-Leak Hygiene Offline Guard Suite
 *
 * Statically parses non-landing, non-test TypeScript/TSX modules under `src/`
 * using the TypeScript compiler AST and pairs EACH individual acquisition
 * inside its enclosing lifecycle/function scope with a matching cleanup:
 *
 *   - `addEventListener(...)` (unless `{ once: true }`) ->
 *     `removeEventListener(...)` in the SAME lifecycle scope with the SAME
 *     target expression, event expression, and callback expression
 *     (heuristic exception: `controls.dispose()` in the same scope pairs with
 *     `controls.addEventListener(...)` for Three.js `OrbitControls`).
 *   - `new IntersectionObserver|ResizeObserver|MutationObserver` / `<obs>.observe(...)` ->
 *     `<obs>.disconnect()` or `<obs>.unobserve(...)` on the SAME observer
 *     binding inside the SAME lifecycle scope (heuristic: `unobserve` accepted
 *     for explicit target removal alongside `disconnect`).
 *   - `setInterval(...)` -> `clearInterval(<sameBinding>)` in the SAME scope
 *     (or in a component `useEffect` cleanup when assigned to `<ref>.current`).
 *   - `setTimeout(...)` -> `clearTimeout(<sameBinding>)` in the SAME scope
 *     (or in a component `useEffect` cleanup when assigned to `<ref>.current`).
 *     Explicitly excluded as a documented heuristic: pure `resolve`-only sleep
 *     promises `new Promise((resolve) => setTimeout(resolve, ms))` that capture
 *     no component callbacks. Uncancelled `Promise.race` timeouts and short
 *     imperative UX feedback/focus timeouts must appear in `LIFECYCLE_ALLOWLIST`
 *     with `snippetMatch` specificity.
 *   - `requestAnimationFrame(...)` -> `cancelAnimationFrame(<sameBinding>)` in
 *     the SAME scope (or in a component `useEffect` cleanup when assigned to
 *     `<ref>.current`).
 *   - `onAuthStateChange(...)` / `subscribeCandidateProfile(...)` ->
 *     `<sameBinding>.unsubscribe()` / `<sameBinding>()` in the SAME scope (with
 *     one-hop local alias tracking inside the scope).
 *
 * Intentional exceptions must be listed in `LIFECYCLE_ALLOWLIST` (scoped by
 * `snippetMatch` when other resources in the file still require cleanup) and
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
  | "timeout"
  | "animationFrame"
  | "subscription";

export interface LifecycleAllowlistEntry {
  file: string;
  kind: ResourceKind;
  /** Optional substring match on the acquisition snippet so other acquisitions of the same kind in the file remain checked. */
  snippetMatch?: string;
  reason: string;
}

export interface LifecycleAcquisition {
  kind: ResourceKind;
  scopeId: string;
  componentScopeId: string;
  /** Event listener matching */
  target?: string;
  event?: string;
  callback?: string;
  /** Observer / timer / RAF / subscription matching */
  binding: string | null;
  aliases: string[];
  line: number;
  snippet: string;
}

export interface LifecycleCleanup {
  kind: ResourceKind;
  scopeId: string;
  isEffectScope: boolean;
  componentScopeId: string;
  /** Event listener matching */
  target?: string;
  event?: string;
  callback?: string;
  viaDispose?: boolean;
  /** Observer / timer / RAF / subscription matching */
  binding: string | null;
}

export interface FileLifecycleReport {
  file: string;
  acquisitions: LifecycleAcquisition[];
  cleanups: LifecycleCleanup[];
}

export interface LifecycleViolation {
  file: string;
  kind: ResourceKind;
  line: number;
  snippet: string;
  message: string;
}

/**
 * Documented heuristics enforced vs relied upon by this static scanner.
 * Mirrored in `docs/lifecycle-audit.md` ("Scanner Scope & Documented Heuristics").
 */
export const SCANNER_HEURISTICS: readonly string[] = [
  "Cross-effect useRef cleanup heuristic: timer/rAF handles assigned to `<ref>.current` match `clearTimeout`/`clearInterval`/`cancelAnimationFrame` of the exact same `<ref>.current` inside a `useEffect`/`useLayoutEffect` in the same enclosing component/hook function.",
  "OrbitControls.dispose() heuristic: `controls.addEventListener(...)` inside a `useEffect` pairs with `controls.dispose()` in the same effect scope.",
  "Pure Promise sleep heuristic: `new Promise((resolve) => setTimeout(resolve, ms))` where `setTimeout` directly passes the Promise resolver identifier is ignored as a stateless sleep helper.",
  "Synchronous Promise executor scope heuristic: callbacks passed to `new Promise((resolve) => ...)` execute synchronously inside the enclosing function, so `timer = setTimeout(...)` inside a Promise executor is scoped to that enclosing function (pairing with `clearTimeout(timer)` in `try`/`finally`).",
  "AST text-equality + one-hop scope alias heuristic: expressions are compared by whitespace-normalized AST text, with one-hop local alias propagation within the same lifecycle scope (`authListener = data.subscription`).",
];

/**
 * Documented allowlist for intentional app-lifetime listeners, `Promise.race`
 * timeouts, and short imperative UX feedback timeouts in non-landing `src/`.
 * Every entry MUST explain why explicit pairing/cancellation is omitted.
 */
export const LIFECYCLE_ALLOWLIST: LifecycleAllowlistEntry[] = [
  {
    file: "src/lib/billing/subscription.ts",
    kind: "eventListener",
    snippetMatch: "window.addEventListener",
    reason: "Intentional app-lifetime singleton cache invalidators registered once at module init",
  },
  {
    file: "src/app/jobs/page.tsx",
    kind: "animationFrame",
    snippetMatch: "window.scrollTo",
    reason: "One-shot post-close/popstate window.scrollTo restore rather than a recurring animation loop",
  },
  {
    file: "src/components/jobs/JobCardMenu.tsx",
    kind: "animationFrame",
    snippetMatch: "itemRefs.current[0]?.focus()",
    reason: "One-shot menu-open focus transfer guarded by optional-chained ref check",
  },
  // Promise.race timeout guards in src/lib/ (short 4-5s bounded race losers)
  {
    file: "src/lib/auth/session.ts",
    kind: "timeout",
    snippetMatch: "Auth timeout",
    reason: "Bounded 5s Promise.race auth lookup fallback outside React UI state",
  },
  {
    file: "src/lib/billing/subscription.ts",
    kind: "timeout",
    snippetMatch: "Subscription query timeout",
    reason: "Bounded Promise.race timeout guard around cached entitlement lookup",
  },
  {
    file: "src/lib/cron/digestStorage.ts",
    kind: "timeout",
    snippetMatch: "Digest query timeout",
    reason: "Bounded 4s Promise.race cron query guard in server storage helper",
  },
  {
    file: "src/lib/resume/storage.ts",
    kind: "timeout",
    snippetMatch: "Profile query timeout",
    reason: "Bounded 4s Promise.race profile fetch guard",
  },
  {
    file: "src/lib/tracker/storage.ts",
    kind: "timeout",
    snippetMatch: "Applications query timeout",
    reason: "Bounded 4s Promise.race tracker applications fetch guard",
  },
  // Transient imperative UX feedback / post-submit redirect / post-unmount focus-restore timeouts
  {
    file: "src/app/onboarding/page.tsx",
    kind: "timeout",
    snippetMatch: "router.push(next)",
    reason: "One-shot 400ms post-submit redirect feedback after save completes",
  },
  {
    file: "src/components/interview-pack/AskThemSection.tsx",
    kind: "timeout",
    snippetMatch: "setCopiedId(null)",
    reason: "Transient 2s copy-button badge reset inside click handler",
  },
  {
    file: "src/components/interview-pack/YourAnswersSection.tsx",
    kind: "timeout",
    snippetMatch: "setCopiedId(null)",
    reason: "Transient 2s copy-button badge reset inside click handler",
  },
  {
    file: "src/components/jobs/JobDetailView.tsx",
    kind: "timeout",
    snippetMatch: "2500",
    reason: "Transient 2.5s copy-link feedback reset inside click handler",
  },
  {
    file: "src/components/profile/ProfileDrawers.tsx",
    kind: "timeout",
    snippetMatch: "previousActive.focus()",
    reason: "10ms post-unmount focus restore inside useEffect cleanup after body scroll unlock",
  },
  {
    file: "src/components/resume/CoverLetterModal.tsx",
    kind: "timeout",
    snippetMatch: "setCopied(false)",
    reason: "Transient 2s copy-button badge reset inside click handler (separate from effect cleanup)",
  },
  {
    file: "src/components/resume/ResumeUploadAndConfirm.tsx",
    kind: "timeout",
    snippetMatch: "setIsSaved(false)",
    reason: "Transient 4s save-badge reset inside submit handler",
  },
  {
    file: "src/components/resume/TailorResumeModal.tsx",
    kind: "timeout",
    snippetMatch: "setCopied(false)",
    reason: "Transient 2s copy-button badge reset inside click handler (separate from effect cleanup)",
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

function norm(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node
    .getText(sourceFile)
    .replace(/\s+/g, " ")
    .replace(/\?\./g, ".")
    .trim();
}

function isEffectCall(callExpr: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const callee = norm(callExpr.expression, sourceFile);
  return (
    callee === "useEffect" ||
    callee === "React.useEffect" ||
    callee === "useLayoutEffect" ||
    callee === "React.useLayoutEffect"
  );
}

function getScopeInfo(node: ts.Node, sourceFile: ts.SourceFile): {
  scopeId: string;
  isEffectScope: boolean;
  componentScopeId: string;
} {
  let curr: ts.Node | undefined = node.parent;
  let effectScopeNode: ts.Node | null = null;
  const functionAncestors: ts.Node[] = [];

  while (curr) {
    if (
      ts.isFunctionDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isArrowFunction(curr) ||
      ts.isMethodDeclaration(curr)
    ) {
      // Documented heuristic: `new Promise((resolve) => ...)` executes synchronously inside
      // the enclosing function, so timers assigned inside its executor pair with outer `finally` cleanups.
      const isPromiseExecutor =
        curr.parent &&
        ts.isNewExpression(curr.parent) &&
        ts.isIdentifier(curr.parent.expression) &&
        curr.parent.expression.text === "Promise" &&
        curr.parent.arguments?.[0] === curr;

      if (!isPromiseExecutor) {
        functionAncestors.push(curr);
      }
      if (
        curr.parent &&
        ts.isCallExpression(curr.parent) &&
        curr.parent.arguments[0] === curr &&
        isEffectCall(curr.parent, sourceFile)
      ) {
        if (!effectScopeNode) {
          effectScopeNode = curr;
        }
      }
    }
    curr = curr.parent;
  }

  const componentScopeNode =
    functionAncestors.length > 0 ? functionAncestors[functionAncestors.length - 1] : null;
  const componentScopeId = componentScopeNode
    ? `fn@${componentScopeNode.getStart(sourceFile)}`
    : "module";

  if (effectScopeNode) {
    return {
      scopeId: `effect@${effectScopeNode.getStart(sourceFile)}`,
      isEffectScope: true,
      componentScopeId,
    };
  }

  if (functionAncestors.length > 0) {
    const immediateFn = functionAncestors[0];
    return {
      scopeId: `fn@${immediateFn.getStart(sourceFile)}`,
      isEffectScope: false,
      componentScopeId,
    };
  }

  return { scopeId: "module", isEffectScope: false, componentScopeId: "module" };
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

/**
 * Returns true if `setTimeout(resolve, ms)` is directly passing the Promise executor's
 * `resolve` parameter with zero closures/callbacks captured.
 */
function isPurePromiseSleepSetTimeout(callNode: ts.CallExpression): boolean {
  const firstArg = callNode.arguments[0];
  if (!firstArg || !ts.isIdentifier(firstArg)) return false;
  let curr: ts.Node | undefined = callNode.parent;
  while (curr) {
    if (
      (ts.isArrowFunction(curr) || ts.isFunctionExpression(curr)) &&
      curr.parent &&
      ts.isNewExpression(curr.parent) &&
      ts.isIdentifier(curr.parent.expression) &&
      curr.parent.expression.text === "Promise"
    ) {
      const resolveParam = curr.parameters[0]?.name;
      return Boolean(resolveParam && ts.isIdentifier(resolveParam) && resolveParam.text === firstArg.text);
    }
    curr = curr.parent;
  }
  return false;
}

function extractBindingNamesFromPattern(pattern: ts.BindingName): string[] {
  const names: string[] = [];
  function walkPattern(p: ts.BindingName) {
    if (ts.isIdentifier(p)) {
      names.push(p.text);
    } else if (ts.isObjectBindingPattern(p)) {
      for (const el of p.elements) walkPattern(el.name);
    } else if (ts.isArrayBindingPattern(p)) {
      for (const el of p.elements) {
        if (ts.isBindingElement(el)) walkPattern(el.name);
      }
    }
  }
  walkPattern(pattern);
  return names;
}

function extractAssignedBinding(expr: ts.Node, sourceFile: ts.SourceFile): { primary: string | null; all: string[] } {
  const parent = expr.parent;
  if (!parent) return { primary: null, all: [] };

  if (ts.isVariableDeclaration(parent) && parent.initializer === expr) {
    const names = extractBindingNamesFromPattern(parent.name);
    return { primary: names[0] ?? null, all: names };
  }

  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === expr) {
    const lhs = norm(parent.left, sourceFile);
    return { primary: lhs, all: [lhs] };
  }

  return { primary: null, all: [] };
}

function collectScopeAliases(sourceFile: ts.SourceFile): Map<string, Map<string, Set<string>>> {
  // scopeId -> sourceName -> Set<aliasName>
  const scopeAliases = new Map<string, Map<string, Set<string>>>();

  function addAlias(scopeId: string, source: string, alias: string) {
    let bySource = scopeAliases.get(scopeId);
    if (!bySource) {
      bySource = new Map();
      scopeAliases.set(scopeId, bySource);
    }
    let set = bySource.get(source);
    if (!set) {
      set = new Set();
      bySource.set(source, set);
    }
    set.add(alias);
  }

  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { scopeId } = getScopeInfo(node, sourceFile);
      const lhs = norm(node.left, sourceFile);
      const rhsText = norm(node.right, sourceFile);
      const rootIdent = rhsText.split(".")[0];
      if (rootIdent && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rootIdent)) {
        addAlias(scopeId, rootIdent, lhs);
      }
      addAlias(scopeId, rhsText, lhs);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return scopeAliases;
}

function getTimerCalleeName(callee: ts.Expression, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = norm(callee.expression, sourceFile);
    if (obj === "window" || obj === "globalThis") {
      return callee.name.text;
    }
  }
  return null;
}

export function inspectLifecycleInSource(filePath: string, sourceText: string): FileLifecycleReport {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const scopeAliases = collectScopeAliases(sourceFile);

  const acquisitions: LifecycleAcquisition[] = [];
  const cleanups: LifecycleCleanup[] = [];

  const getLineAndSnippet = (node: ts.Node) => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 110);
    return { line: pos.line + 1, snippet };
  };

  function resolveAliases(scopeId: string, baseNames: string[]): string[] {
    const out = new Set<string>(baseNames);
    const bySource = scopeAliases.get(scopeId);
    if (bySource) {
      for (const name of baseNames) {
        const mapped = bySource.get(name);
        if (mapped) {
          for (const m of mapped) out.add(m);
        }
        const prefixed = bySource.get(`${name}.subscription`);
        if (prefixed) {
          for (const m of prefixed) out.add(m);
        }
      }
    }
    return [...out];
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const timerName = getTimerCalleeName(callee, sourceFile);
      const { scopeId, isEffectScope, componentScopeId } = getScopeInfo(node, sourceFile);

      if (timerName === "setInterval") {
        const { line, snippet } = getLineAndSnippet(node);
        const { primary, all } = extractAssignedBinding(node, sourceFile);
        acquisitions.push({
          kind: "interval",
          scopeId,
          componentScopeId,
          binding: primary,
          aliases: primary ? resolveAliases(scopeId, all) : [],
          line,
          snippet,
        });
      } else if (timerName === "clearInterval") {
        const arg = node.arguments[0];
        cleanups.push({
          kind: "interval",
          scopeId,
          isEffectScope,
          componentScopeId,
          binding: arg ? norm(arg, sourceFile) : null,
        });
      } else if (timerName === "setTimeout") {
        if (!isPurePromiseSleepSetTimeout(node)) {
          const { line, snippet } = getLineAndSnippet(node);
          const { primary, all } = extractAssignedBinding(node, sourceFile);
          acquisitions.push({
            kind: "timeout",
            scopeId,
            componentScopeId,
            binding: primary,
            aliases: primary ? resolveAliases(scopeId, all) : [],
            line,
            snippet,
          });
        }
      } else if (timerName === "clearTimeout") {
        const arg = node.arguments[0];
        cleanups.push({
          kind: "timeout",
          scopeId,
          isEffectScope,
          componentScopeId,
          binding: arg ? norm(arg, sourceFile) : null,
        });
      } else if (timerName === "requestAnimationFrame") {
        const { line, snippet } = getLineAndSnippet(node);
        const { primary, all } = extractAssignedBinding(node, sourceFile);
        acquisitions.push({
          kind: "animationFrame",
          scopeId,
          componentScopeId,
          binding: primary,
          aliases: primary ? resolveAliases(scopeId, all) : [],
          line,
          snippet,
        });
      } else if (timerName === "cancelAnimationFrame") {
        const arg = node.arguments[0];
        cleanups.push({
          kind: "animationFrame",
          scopeId,
          isEffectScope,
          componentScopeId,
          binding: arg ? norm(arg, sourceFile) : null,
        });
      } else if (timerName === "subscribeCandidateProfile") {
        const { line, snippet } = getLineAndSnippet(node);
        const { primary, all } = extractAssignedBinding(node, sourceFile);
        acquisitions.push({
          kind: "subscription",
          scopeId,
          componentScopeId,
          binding: primary,
          aliases: primary ? resolveAliases(scopeId, all) : [],
          line,
          snippet,
        });
      } else if (ts.isIdentifier(callee) && callee.text === "unsubscribe") {
        cleanups.push({
          kind: "subscription",
          scopeId,
          isEffectScope,
          componentScopeId,
          binding: "unsubscribe",
        });
      } else if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        const targetText = norm(callee.expression, sourceFile);

        if (methodName === "addEventListener") {
          if (!hasOnceTrueOption(node.arguments[2])) {
            const { line, snippet } = getLineAndSnippet(node);
            const eventArg = node.arguments[0] ? norm(node.arguments[0], sourceFile) : "";
            const cbArg = node.arguments[1] ? norm(node.arguments[1], sourceFile) : "";
            acquisitions.push({
              kind: "eventListener",
              scopeId,
              componentScopeId,
              target: targetText,
              event: eventArg,
              callback: cbArg,
              binding: null,
              aliases: [],
              line,
              snippet,
            });
          }
        } else if (methodName === "removeEventListener") {
          const eventArg = node.arguments[0] ? norm(node.arguments[0], sourceFile) : "";
          const cbArg = node.arguments[1] ? norm(node.arguments[1], sourceFile) : "";
          cleanups.push({
            kind: "eventListener",
            scopeId,
            isEffectScope,
            componentScopeId,
            target: targetText,
            event: eventArg,
            callback: cbArg,
            binding: null,
          });
        } else if (methodName === "dispose") {
          // Documented heuristic: OrbitControls.dispose() removes controls.addEventListener(...) listeners
          if (targetText === "controls") {
            cleanups.push({
              kind: "eventListener",
              scopeId,
              isEffectScope,
              componentScopeId,
              target: targetText,
              viaDispose: true,
              binding: null,
            });
          }
        } else if (methodName === "observe") {
          const { line, snippet } = getLineAndSnippet(node);
          acquisitions.push({
            kind: "observer",
            scopeId,
            componentScopeId,
            binding: targetText,
            aliases: resolveAliases(scopeId, [targetText]),
            line,
            snippet,
          });
        } else if (methodName === "disconnect" || methodName === "unobserve") {
          cleanups.push({
            kind: "observer",
            scopeId,
            isEffectScope,
            componentScopeId,
            binding: targetText,
          });
        } else if (methodName === "onAuthStateChange") {
          const { line, snippet } = getLineAndSnippet(node);
          const { primary, all } = extractAssignedBinding(node, sourceFile);
          const expanded = all.flatMap((n) => [n, `${n}.subscription`]);
          acquisitions.push({
            kind: "subscription",
            scopeId,
            componentScopeId,
            binding: primary,
            aliases: resolveAliases(scopeId, expanded),
            line,
            snippet,
          });
        } else if (methodName === "unsubscribe") {
          cleanups.push({
            kind: "subscription",
            scopeId,
            isEffectScope,
            componentScopeId,
            binding: targetText,
          });
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const ctor = node.expression.text;
      if (ctor === "IntersectionObserver" || ctor === "ResizeObserver" || ctor === "MutationObserver") {
        const { scopeId, componentScopeId } = getScopeInfo(node, sourceFile);
        const { line, snippet } = getLineAndSnippet(node);
        const { primary, all } = extractAssignedBinding(node, sourceFile);
        acquisitions.push({
          kind: "observer",
          scopeId,
          componentScopeId,
          binding: primary,
          aliases: primary ? resolveAliases(scopeId, all) : [],
          line,
          snippet,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { file: filePath, acquisitions, cleanups };
}

function isAllowlisted(acq: LifecycleAcquisition, file: string): boolean {
  return LIFECYCLE_ALLOWLIST.some((entry) => {
    if (entry.file !== file || entry.kind !== acq.kind) return false;
    if (entry.snippetMatch && !acq.snippet.includes(entry.snippetMatch)) return false;
    return true;
  });
}

function isAcquisitionCleaned(acq: LifecycleAcquisition, cleanups: LifecycleCleanup[]): boolean {
  if (acq.kind === "eventListener") {
    return cleanups.some((c) => {
      if (c.kind !== "eventListener" || c.scopeId !== acq.scopeId) return false;
      if (c.viaDispose) {
        return c.target === acq.target;
      }
      return c.target === acq.target && c.event === acq.event && c.callback === acq.callback;
    });
  }

  if (acq.kind === "observer") {
    if (!acq.binding) return false;
    const validBindings = new Set(acq.aliases.length > 0 ? acq.aliases : [acq.binding]);
    return cleanups.some(
      (c) => c.kind === "observer" && c.scopeId === acq.scopeId && c.binding !== null && validBindings.has(c.binding)
    );
  }

  if (acq.kind === "subscription") {
    if (!acq.binding) return false;
    const validBindings = new Set(acq.aliases.length > 0 ? acq.aliases : [acq.binding]);
    return cleanups.some(
      (c) => c.kind === "subscription" && c.scopeId === acq.scopeId && c.binding !== null && validBindings.has(c.binding)
    );
  }

  // interval, timeout, animationFrame: exact timer binding match
  if (!acq.binding) return false;
  const validBindings = new Set(acq.aliases.length > 0 ? acq.aliases : [acq.binding]);
  const isRefBinding = acq.binding.endsWith(".current");

  return cleanups.some((c) => {
    if (c.kind !== acq.kind || !c.binding || !validBindings.has(c.binding)) return false;
    if (c.scopeId === acq.scopeId) return true;
    // Documented Heuristic #1: `<ref>.current` timer/rAF assigned in component handler & cleared in useEffect of same component
    return isRefBinding && c.isEffectScope && c.componentScopeId === acq.componentScopeId;
  });
}

export function validateLifecycleReports(reports: FileLifecycleReport[]): LifecycleViolation[] {
  const violations: LifecycleViolation[] = [];

  for (const report of reports) {
    for (const acq of report.acquisitions) {
      if (isAllowlisted(acq, report.file)) continue;
      if (isAcquisitionCleaned(acq, report.cleanups)) continue;

      violations.push({
        file: report.file,
        kind: acq.kind,
        line: acq.line,
        snippet: acq.snippet,
        message: `${report.file}:${acq.line} unpaired '${acq.kind}' in scope ${acq.scopeId} (${acq.snippet})`,
      });
    }
  }

  return violations;
}

const NEGATIVE_CONTROL_FIXTURES: Array<{ file: string; expectedKind: ResourceKind; code: string }> = [
  {
    file: "src/components/MixedListenerWidget.tsx",
    expectedKind: "eventListener",
    code: `
      "use client";
      import { useEffect } from "react";
      export function MixedListenerWidget() {
        useEffect(() => {
          const onScroll = () => {};
          const onResize = () => {};
          window.addEventListener("scroll", onScroll);
          window.addEventListener("resize", onResize);
          return () => {
            window.removeEventListener("scroll", onScroll);
          };
        }, []);
        return null;
      }
    `,
  },
  {
    file: "src/components/TargetMismatchListenerWidget.tsx",
    expectedKind: "eventListener",
    code: `
      "use client";
      import { useEffect } from "react";
      export function TargetMismatchListenerWidget() {
        useEffect(() => {
          const onKey = () => {};
          window.addEventListener("keydown", onKey);
          return () => {
            document.removeEventListener("keydown", onKey);
          };
        }, []);
        return null;
      }
    `,
  },
  {
    file: "src/components/CallbackMismatchListenerWidget.tsx",
    expectedKind: "eventListener",
    code: `
      "use client";
      import { useEffect } from "react";
      export function CallbackMismatchListenerWidget() {
        useEffect(() => {
          const onKey = () => {};
          const other = () => {};
          window.addEventListener("keydown", onKey);
          return () => {
            window.removeEventListener("keydown", other);
          };
        }, []);
        return null;
      }
    `,
  },
  {
    file: "src/components/MixedObserverWidget.tsx",
    expectedKind: "observer",
    code: `
      "use client";
      import { useEffect, useRef } from "react";
      export function MixedObserverWidget() {
        const ref = useRef<HTMLDivElement | null>(null);
        useEffect(() => {
          const ro = new ResizeObserver(() => {});
          const io = new IntersectionObserver(() => {});
          if (ref.current) {
            ro.observe(ref.current);
            io.observe(ref.current);
          }
          return () => {
            ro.disconnect();
          };
        }, []);
        return <div ref={ref} />;
      }
    `,
  },
  {
    file: "src/components/MixedIntervalWidget.tsx",
    expectedKind: "interval",
    code: `
      "use client";
      import { useEffect } from "react";
      export function MixedIntervalWidget() {
        useEffect(() => {
          const clean = setInterval(() => {}, 1000);
          const leaky = setInterval(() => {}, 2000);
          return () => {
            clearInterval(clean);
          };
        }, []);
        return null;
      }
    `,
  },
  {
    file: "src/components/MixedTimeoutWidget.tsx",
    expectedKind: "timeout",
    code: `
      "use client";
      import { useEffect } from "react";
      export function MixedTimeoutWidget() {
        useEffect(() => {
          const cleanTimer = setTimeout(() => {}, 100);
          const leakyTimer = setTimeout(() => {}, 200);
          return () => {
            clearTimeout(cleanTimer);
          };
        }, []);
        return null;
      }
    `,
  },
  {
    file: "src/components/CrossEffectLeakWidget.tsx",
    expectedKind: "eventListener",
    code: `
      "use client";
      import { useEffect } from "react";
      export function CrossEffectLeakWidget() {
        const onResize = () => {};
        useEffect(() => {
          window.addEventListener("resize", onResize);
        }, []);
        useEffect(() => {
          return () => window.removeEventListener("resize", onResize);
        }, []);
        return null;
      }
    `,
  },
];

function runNegativeControlSubprocess(): never {
  const reports = NEGATIVE_CONTROL_FIXTURES.map((s) => inspectLifecycleInSource(s.file, s.code));
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

  check("scanned non-landing src/ files pairing each listener/observer/interval/timeout/RAF/subscription in its lifecycle scope", () => {
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
      const hasMatchingAcq = report.acquisitions.some(
        (a) =>
          a.kind === entry.kind &&
          (!entry.snippetMatch || a.snippet.includes(entry.snippetMatch)) &&
          !isAcquisitionCleaned(a, report.cleanups)
      );
      assert.ok(
        hasMatchingAcq,
        `Stale allowlist entry ${entry.file} (${entry.kind}${entry.snippetMatch ? ` matching "${entry.snippetMatch}"` : ""}): no matching uncleaned acquisition found`
      );
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
    assert.ok(
      cb.includes("if (cancelled || resolved) return;"),
      "auth/callback must check cancelled/resolved after awaits and before timers"
    );
    assert.ok(
      fs.existsSync(path.join(repoRoot, "src/app/auth/callback/__tests__/page.test.tsx")),
      "auth/callback delayed-getSession unmount regression test must exist"
    );
  });

  check("docs/lifecycle-audit.md exists and documents PR #441, PR #447, heuristics, allowlist entries, and audited files", () => {
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
      "Heuristic",
    ]) {
      assert.ok(doc.includes(token), `docs/lifecycle-audit.md missing required token '${token}'`);
    }
    for (const entry of LIFECYCLE_ALLOWLIST) {
      assert.ok(doc.includes(entry.file), `docs/lifecycle-audit.md missing allowlist entry '${entry.file}'`);
    }
  });

  check("mixed clean+leaky fixtures ALL fail per-acquisition scope & binding checks", () => {
    for (const fixture of NEGATIVE_CONTROL_FIXTURES) {
      const rep = inspectLifecycleInSource(fixture.file, fixture.code);
      const v = validateLifecycleReports([rep]);
      assert.ok(
        v.some((item) => item.kind === fixture.expectedKind),
        `Fixture ${fixture.file} (${fixture.expectedKind}) unexpectedly passed!`
      );
    }
  });

  check("negative-control subprocess fails (exit 1) on every mixed leaky fixture", () => {
    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), __filename, "--negative-control"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.strictEqual(res.status, 1, `Expected exit 1 from negative control, got ${res.status}\n${res.stdout}\n${res.stderr}`);
    for (const fixture of NEGATIVE_CONTROL_FIXTURES) {
      assert.ok(
        res.stderr.includes(fixture.file),
        `Negative control did not catch ${fixture.file}`
      );
    }
  });

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
