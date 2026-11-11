/**
 * scripts/test-hover-touch-guards.ts
 *
 * Deterministic offline static audit for hover-on-touch guards (FE row "Hover-on-touch handling").
 *
 * Asserts that in all audited CSS files:
 * 1. Every `:hover` pseudo-class and `hover:` utility selector is wrapped inside
 *    a `@media (hover: hover)` or `@media (hover:hover)` query.
 * 2. No unguarded hover selectors remain that could cause sticky hover states on touch devices.
 * 3. Verified guarded selectors exist (confirming real hover rules are detected).
 *
 * Usage:
 *   npx tsx scripts/test-hover-touch-guards.ts                    -> exit 0 on pass
 *   npx tsx scripts/test-hover-touch-guards.ts --negative-control -> exit 1 on injected failure
 */

import assert from "assert";
import fs from "fs";
import path from "path";

export interface HoverSelectorOccurrence {
  file: string;
  line: number;
  selector: string;
  guarded: boolean;
  enclosingMedia?: string;
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Preserve newlines so line numbers match original source file
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ".repeat(match.length);
  });
}

export function auditCssContent(filePath: string, content: string): HoverSelectorOccurrence[] {
  const stripped = stripCssComments(content);
  const occurrences: HoverSelectorOccurrence[] = [];
  let line = 1;
  const blockStack: Array<{ type: "media" | "at-rule" | "rule"; isHoverGuard: boolean; heading?: string; line: number }> = [];
  let buffer = "";

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "\n") {
      line++;
      buffer += ch;
    } else if (ch === "{") {
      const heading = buffer.trim();
      buffer = "";
      if (heading.startsWith("@media")) {
        const isHoverGuard = /\(\s*hover\s*:\s*hover\s*\)/i.test(heading);
        blockStack.push({ type: "media", isHoverGuard, heading, line });
      } else if (heading.startsWith("@")) {
        blockStack.push({ type: "at-rule", isHoverGuard: false, heading, line });
      } else {
        const isGuarded = blockStack.some((b) => b.isHoverGuard);
        const enclosingMedia = blockStack.filter((b) => b.type === "media").map((b) => b.heading).join(" > ") || undefined;
        blockStack.push({ type: "rule", isHoverGuard: false, heading, line });
        if (/(?::hover\b|hover:)/.test(heading)) {
          occurrences.push({
            file: filePath,
            line,
            selector: heading.replace(/\s+/g, " "),
            guarded: isGuarded,
            enclosingMedia,
          });
        }
      }
    } else if (ch === "}") {
      buffer = "";
      blockStack.pop();
    } else {
      buffer += ch;
    }
  }

  return occurrences;
}

const ROOT = path.resolve(__dirname, "..");

const AUDITED_FILES = [
  "src/app/globals.css",
  "src/styles/landing-top-artifact.css",
  "src/styles/tokens.css",
];

export function runAudit(isNegativeControl = false): {
  auditedFiles: string[];
  totalOccurrences: number;
  guardedCount: number;
  unguarded: HoverSelectorOccurrence[];
} {
  const allOccurrences: HoverSelectorOccurrence[] = [];

  for (const relPath of AUDITED_FILES) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Expected audited CSS file not found: ${relPath}`);
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const results = auditCssContent(relPath, content);
    allOccurrences.push(...results);
  }

  if (isNegativeControl) {
    // Inject simulated unguarded :hover selectors to test negative control
    const simulatedUnguarded = auditCssContent(
      "src/styles/simulated-corrupt.css",
      `.broken-card:hover { transform: scale(1.05); }\n@media (min-width: 640px) { .broken-btn:hover { color: red; } }`
    );
    allOccurrences.push(...simulatedUnguarded);
  }

  const guardedCount = allOccurrences.filter((o) => o.guarded).length;
  const unguarded = allOccurrences.filter((o) => !o.guarded);

  return {
    auditedFiles: AUDITED_FILES,
    totalOccurrences: allOccurrences.length,
    guardedCount,
    unguarded,
  };
}

if (process.argv.includes("--negative-control")) {
  console.log("Running negative control: injecting simulated unguarded hover selectors...");
  const result = runAudit(true);
  if (result.unguarded.length > 0) {
    console.log(`NEGATIVE CONTROL PASSED: Detected ${result.unguarded.length} expected intentional failure(s):`);
    result.unguarded.forEach((u) => console.log(`  - [EXPECTED VIOLATION] ${u.file}:${u.line} "${u.selector}"`));
    process.exit(1);
  } else {
    console.error("NEGATIVE CONTROL FAILED: Injected unguarded hover styles were not detected!");
    process.exit(0);
  }
}

function main() {
  console.log("================================================================================");
  console.log("             HOVER-ON-TOUCH GUARDS AUDIT & VERIFICATION SUITE                   ");
  console.log("================================================================================\n");

  const result = runAudit(false);

  console.log(`Audited ${result.auditedFiles.length} CSS files:`);
  result.auditedFiles.forEach((f) => console.log(`  - ${f}`));
  console.log(`\nDetected ${result.totalOccurrences} total hover selector occurrences.`);
  console.log(`Guarded under @media (hover: hover): ${result.guardedCount}`);
  console.log(`Unguarded hover selectors: ${result.unguarded.length}\n`);

  // Assertions
  assert.ok(
    result.auditedFiles.length >= 3,
    "Audit must inspect all primary CSS stylesheets (globals.css, landing-top-artifact.css, tokens.css)"
  );

  assert.ok(
    result.guardedCount >= 5,
    `Audit must find active guarded hover selectors in the codebase (found ${result.guardedCount})`
  );

  if (result.unguarded.length > 0) {
    console.error("FAIL: Found unguarded hover selectors that will stick on touch devices:");
    result.unguarded.forEach((u) => {
      console.error(`  - ${u.file}:${u.line} "${u.selector}"`);
    });
    process.exit(1);
  }

  console.log("PASS: No unguarded hover selectors found across audited files.");
  console.log("PASS: Touch devices are protected from sticky hover states.");
  console.log("\nHOVER-ON-TOUCH AUDIT VERIFIED [PASS-LOCAL]");
  process.exit(0);
}

if (require.main === module) {
  main();
}
