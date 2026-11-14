/**
 * CareerMonke Navigation & Browser History Offline Guard Suite
 *
 * Statically scans `src/app/` and `src/components/` for `router.replace(` calls
 * and fails on any usage not present in the documented allowlist below.
 * Verifies `docs/navigation-history-policy.md` coverage and tests a negative
 * control snippet through the same scanner/allowlist validator.
 *
 * Run with: npx tsx scripts/test-navigation-history.ts
 * Run negative control: npx tsx scripts/test-navigation-history.ts --negative-control
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface RouterReplaceAllowlistEntry {
  file: string;
  expectedCount: number;
  requiredSnippets: string[];
}

export interface RouterReplaceMatch {
  file: string;
  line: number;
  snippet: string;
}

/**
 * Documented allowlist of permitted `router.replace(` usages in `src/app/` and `src/components/`.
 * Every entry MUST have a one-line comment justifying why `replace` (not `push`) is required.
 */
export const ROUTER_REPLACE_ALLOWLIST: RouterReplaceAllowlistEntry[] = [
  // Non-admin SSR guard fallback (2 sites) replaces unauthorized `/admin` entry so Back does not loop
  {
    file: "src/app/admin/layout.tsx",
    expectedCount: 2,
    requiredSnippets: ['router.replace("/")'],
  },
  // PKCE/OAuth callback completion removes one-time `/auth/callback` token URL from browser history
  {
    file: "src/app/auth/callback/page.tsx",
    expectedCount: 1,
    requiredSnippets: ["router.replace(destination)"],
  },
  // Unauthenticated mount guard on `/dashboard` replaces protected URL to avoid a Back-button trap
  {
    file: "src/app/dashboard/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/dashboard")'],
  },
  // Legacy `/job-detail` redirect shim replaces deprecated route with canonical `/jobs` URL
  {
    file: "src/app/job-detail/page.tsx",
    expectedCount: 1,
    requiredSnippets: ["router.replace(`/jobs${search}`)"],
  },
  // Legacy `/job-search/all` redirect shim replaces deprecated route with canonical `/jobs` URL
  {
    file: "src/app/job-search/all/page.tsx",
    expectedCount: 1,
    requiredSnippets: ["router.replace(target)"],
  },
  // Feature-flag & auth mount guards on interview-pack replace blocked URL with `/dashboard` or `/login`
  {
    file: "src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx",
    expectedCount: 2,
    requiredSnippets: [
      'router.replace("/dashboard")',
      "router.replace(`/login?returnTo=/jobs/${jobId}/interview-pack`)",
    ],
  },
  // Feature-flag & auth mount guards on skill-what-if replace blocked URL with `/dashboard` or `/login`
  {
    file: "src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx",
    expectedCount: 2,
    requiredSnippets: [
      'router.replace("/dashboard")',
      "router.replace(`/login?returnTo=/jobs/${jobId}/skill-what-if`)",
    ],
  },
  // State-only filter/reset URL sync (2 sites) on `/jobs`
  {
    file: "src/app/jobs/page.tsx",
    expectedCount: 2,
    requiredSnippets: [
      "router.replace(newUrl, { scroll: false })",
    ],
  },
  // Already-authenticated auto-redirect on `/login` replaces login screen so Back does not revisit it
  {
    file: "src/app/login/page.tsx",
    expectedCount: 1,
    requiredSnippets: ["router.replace(next)"],
  },
  // Unauthenticated mount guard (guest login) and completed-account auto-redirect on `/onboarding` replace protected URL
  {
    file: "src/app/onboarding/page.tsx",
    expectedCount: 2,
    requiredSnippets: [
      "router.replace(`/login?returnTo=${encodeURIComponent(returnUrl)}`)",
      "router.replace(next)",
    ],
  },
  // Unauthenticated mount guard on `/profile` replaces protected URL to prevent Back-button loop
  {
    file: "src/app/profile/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/profile")'],
  },
  // Unauthenticated mount guard on `/radar` replaces protected URL to prevent Back-button loop
  {
    file: "src/app/radar/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/radar")'],
  },
  // Unauthenticated mount guard on `/resume` replaces protected URL to prevent Back-button loop
  {
    file: "src/app/resume/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/resume")'],
  },
  // Unauthenticated mount guard on `/settings` replaces protected URL to prevent Back-button loop
  {
    file: "src/app/settings/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/settings")'],
  },
  // Already-authenticated auto-redirect on `/signup` replaces signup screen so Back does not revisit it
  {
    file: "src/app/signup/page.tsx",
    expectedCount: 1,
    requiredSnippets: ["router.replace(next)"],
  },
  // Unauthenticated mount guard on `/tracker` replaces protected URL to prevent Back-button loop
  {
    file: "src/app/tracker/page.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login?returnTo=/tracker")'],
  },
  // Post-sign-out exit in `UserMenu` replaces authenticated entry with `/` so Back stays signed out
  {
    file: "src/components/UserMenu.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/")'],
  },
  // Cross-tab sign-out `storage` listener replaces stale authenticated view with `/login`
  {
    file: "src/components/shell/LoggedInAppShell.tsx",
    expectedCount: 1,
    requiredSnippets: ['router.replace("/login")'],
  },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function toPosixRelative(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function collectSourceFiles(dirs: string[]): string[] {
  const files: string[] = [];

  function walk(dirPath: string) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") continue;
        walk(fullPath);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  for (const dir of dirs) {
    walk(dir);
  }
  return files.sort();
}

export function findRouterReplaceInSource(fileRelPath: string, content: string): RouterReplaceMatch[] {
  const matches: RouterReplaceMatch[] = [];
  const kind = fileRelPath.endsWith(".tsx") || fileRelPath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileRelPath, content, ts.ScriptTarget.Latest, true, kind);

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const expr = node.expression;
      if (
        expr.name.text === "replace" &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "router"
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const normalized = node.getText(sourceFile).replace(/\s+/g, " ").trim();
        matches.push({
          file: fileRelPath,
          line: line + 1,
          snippet: normalized,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

export function scanRouterReplaceDirectory(repoRoot: string, scanSubdirs = ["src/app", "src/components"]): RouterReplaceMatch[] {
  const targetDirs = scanSubdirs.map((d) => path.resolve(repoRoot, d));
  const files = collectSourceFiles(targetDirs);
  const allMatches: RouterReplaceMatch[] = [];

  for (const absFile of files) {
    const rel = toPosixRelative(repoRoot, absFile);
    const content = fs.readFileSync(absFile, "utf8");
    if (!content.includes("router") || !content.includes("replace")) continue;
    allMatches.push(...findRouterReplaceInSource(rel, content));
  }

  return allMatches;
}

export function validateRouterReplaceMatches(
  matches: RouterReplaceMatch[],
  allowlist: RouterReplaceAllowlistEntry[] = ROUTER_REPLACE_ALLOWLIST
): { violations: string[]; matchedTotal: number } {
  const byFile = new Map<string, RouterReplaceMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const allowMap = new Map<string, RouterReplaceAllowlistEntry>();
  for (const entry of allowlist) {
    allowMap.set(entry.file, entry);
  }

  const violations: string[] = [];

  for (const [file, fileMatches] of byFile.entries()) {
    const entry = allowMap.get(file);
    if (!entry) {
      for (const m of fileMatches) {
        violations.push(`Unallowlisted router.replace( in ${file}:${m.line} -> ${m.snippet}`);
      }
      continue;
    }

    if (fileMatches.length > entry.expectedCount) {
      violations.push(
        `Unexpected extra router.replace( call in ${file}: found ${fileMatches.length}, allowlisted ${entry.expectedCount}`
      );
    }

    for (const m of fileMatches) {
      const normalizedSnippet = m.snippet.replace(/\s+/g, " ");
      const recognized = entry.requiredSnippets.some((req) =>
        normalizedSnippet.includes(req.replace(/\s+/g, " "))
      );
      if (!recognized) {
        violations.push(
          `Unrecognized router.replace( argument in ${file}:${m.line} -> ${m.snippet}`
        );
      }
    }
  }

  return { violations, matchedTotal: matches.length };
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("TEST SUITE: Navigation & Browser History Offline Guard");
  console.log("================================================================================\n");

  let passed = 0;
  let failed = 0;

  function check(desc: string, fn: () => void) {
    try {
      fn();
      console.log(`  [PASS] ${desc}`);
      passed++;
    } catch (err: any) {
      console.error(`  [FAIL] ${desc}: ${err?.message || err}`);
      failed++;
    }
  }

  const realMatches = scanRouterReplaceDirectory(repoRoot);

  if (isNegativeControl) {
    // Inject a synthetic violation into the same scanner and validator code path
    const synthetic = findRouterReplaceInSource(
      "src/app/synthetic-violation/page.tsx",
      `export function Synthetic() { router.replace("/dashboard"); }`
    );
    const { violations } = validateRouterReplaceMatches([...realMatches, ...synthetic]);
    console.log(`[NEGATIVE CONTROL] Injected synthetic violation -> caught ${violations.length} violation(s):`);
    violations.forEach((v) => console.log(`  - ${v}`));
    process.exit(violations.length > 0 ? 1 : 0);
  }

  // 1. No unallowlisted or unapproved router.replace( usages in src/app/ or src/components/
  check("All router.replace( usages in src/app/ and src/components/ match documented allowlist", () => {
    const { violations, matchedTotal } = validateRouterReplaceMatches(realMatches);
    assert.strictEqual(
      violations.length,
      0,
      `Found unauthorized router.replace( calls:\n  ${violations.join("\n  ")}`
    );
    const allowlistExpectedSum = ROUTER_REPLACE_ALLOWLIST.reduce((acc, e) => acc + e.expectedCount, 0);
    assert.strictEqual(
      matchedTotal,
      allowlistExpectedSum,
      `Allowlist drift detected: scanned ${matchedTotal} router.replace( calls, expected ${allowlistExpectedSum}`
    );
  });

  // 2. Every allowlist entry matches actual source file and count (prevents stale allowlist entries)
  check("Allowlist entries are non-empty, accurate, and have non-empty snippet matchers", () => {
    assert.ok(ROUTER_REPLACE_ALLOWLIST.length >= 17, "Expected all 17 allowlisted files");
    const byFile = new Map<string, RouterReplaceMatch[]>();
    for (const m of realMatches) {
      const list = byFile.get(m.file) ?? [];
      list.push(m);
      byFile.set(m.file, list);
    }

    for (const entry of ROUTER_REPLACE_ALLOWLIST) {
      assert.ok(entry.requiredSnippets.length > 0, `Allowlist entry ${entry.file} missing requiredSnippets`);
      const actual = byFile.get(entry.file) ?? [];
      assert.strictEqual(
        actual.length,
        entry.expectedCount,
        `Stale allowlist count for ${entry.file}: expected ${entry.expectedCount}, found ${actual.length}`
      );
    }
  });

  // 3. Policy doc exists and covers all allowlisted files
  check("docs/navigation-history-policy.md exists and documents every allowlisted file", () => {
    const docPath = path.resolve(repoRoot, "docs", "navigation-history-policy.md");
    assert.ok(fs.existsSync(docPath), "Missing docs/navigation-history-policy.md");
    const docText = fs.readFileSync(docPath, "utf8");
    assert.ok(docText.includes("router.replace"), "Policy doc must explain router.replace policy");
    assert.ok(docText.includes("router.push"), "Policy doc must explain router.push policy");
    assert.ok(docText.includes("window.history"), "Policy doc must audit window.history usages");

    for (const entry of ROUTER_REPLACE_ALLOWLIST) {
      assert.ok(
        docText.includes(entry.file),
        `Policy doc is missing audit table entry for ${entry.file}`
      );
    }
  });

  // 4. Negative control verification via the exact scanner + validator code path
  check("Scanner + validator rejects an unallowlisted router.replace( in a new component", () => {
    const injected = findRouterReplaceInSource(
      "src/components/UnapprovedRedirectCard.tsx",
      `
      "use client";
      export function UnapprovedRedirectCard({ router }: { router: { replace: (u: string) => void } }) {
        return <button onClick={() => router.replace("/pricing")}>Upgrade</button>;
      }
      `
    );
    assert.strictEqual(injected.length, 1, "AST scanner must detect router.replace( in synthetic component");
    const result = validateRouterReplaceMatches([...realMatches, ...injected]);
    assert.ok(
      result.violations.some((v) => v.includes("src/components/UnapprovedRedirectCard.tsx")),
      "Validator must fail on unallowlisted router.replace( in synthetic file"
    );
  });

  // 5. Extra unauthorized router.replace( inside an already-allowlisted file also fails
  check("Scanner + validator rejects an extra unreviewed router.replace( inside an allowlisted file", () => {
    const extraInJobs = findRouterReplaceInSource(
      "src/app/dashboard/page.tsx",
      `function onCardClick(router: any) { router.replace("/jobs"); }`
    );
    const result = validateRouterReplaceMatches([...realMatches, ...extraInJobs]);
    assert.ok(
      result.violations.some(
        (v) => v.includes("src/app/dashboard/page.tsx") && v.includes("Unexpected extra router.replace(")
      ),
      "Validator must reject unexpected additional router.replace( inside an allowlisted file"
    );
  });

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
