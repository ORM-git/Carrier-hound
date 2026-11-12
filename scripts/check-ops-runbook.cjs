#!/usr/bin/env node
/**
 * scripts/check-ops-runbook.cjs
 *
 * Standalone offline reference guard for docs/ops-runbook.md.
 * Verifies:
 *   1. docs/ops-runbook.md exists and is non-empty.
 *   2. Required operational sections (Deploy, Rollback, Cron, Migration, Env, Incident) exist.
 *   3. All markdown link targets resolve document-relative from docs/ without root fallback.
 *   4. All backtick file paths and script invocations resolve to existing repository files.
 *   5. Negative control (--negative-control) runs real validator on mutated runbooks and asserts failure.
 *
 * Usage:
 *   node scripts/check-ops-runbook.cjs
 *   node scripts/check-ops-runbook.cjs --negative-control
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const RUNBOOK_PATH = path.join(DOCS_DIR, "ops-runbook.md");

const REQUIRED_SECTIONS = [
  "Deploy",
  "Rollback",
  "Cron",
  "Migration",
  "Env",
  "Incident",
];

/**
 * Validates runbook content string against repository files and required sections.
 * @param {string} content
 * @returns {{ valid: boolean, errors: string[], verified: string[] }}
 */
function validateRunbookContent(content) {
  const errors = [];
  const verified = [];

  if (!content || !content.trim()) {
    errors.push("Runbook content is empty");
    return { valid: false, errors, verified };
  }

  // 1. Verify required operational sections
  for (const sec of REQUIRED_SECTIONS) {
    const reg = new RegExp(`(^|\\n)#{1,4}\\s+.*${sec}`, "i");
    if (!reg.test(content)) {
      errors.push(`Missing required operational section: ${sec}`);
    }
  }

  // 2. Validate markdown link targets document-relative from DOCS_DIR (no root fallback)
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(content)) !== null) {
    let target = linkMatch[1].trim();
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    // Remove query params or anchors
    target = target.split("#")[0].split("?")[0].trim();
    if (!target) continue;

    // Must resolve relative to docs/ops-runbook.md
    const resolvedPath = path.resolve(DOCS_DIR, target);
    if (fs.existsSync(resolvedPath)) {
      const relToRepo = path.relative(REPO_ROOT, resolvedPath).replace(/\\/g, "/");
      verified.push(relToRepo);
    } else {
      errors.push(`Broken markdown link: [${target}] resolved to non-existent path: ${resolvedPath}`);
    }
  }

  // 3. Extract backtick code references: `target`
  const codeRegex = /`([^`\n]+)`/g;
  let codeMatch;
  while ((codeMatch = codeRegex.exec(content)) !== null) {
    const text = codeMatch[1].trim();

    // Script invocations: `node scripts/...`, `npx tsx scripts/...`
    const execMatches = text.matchAll(/(?:node|npx\s+tsx|cat|bash)\s+([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)/g);
    for (const em of execMatches) {
      const scriptPath = em[1].replace(/^[.\/]+/, "");
      if (scriptPath.includes("/") || /\.(ts|cjs|mjs|js|sql)$/.test(scriptPath)) {
        const absPath = path.resolve(REPO_ROOT, scriptPath);
        if (fs.existsSync(absPath)) {
          verified.push(scriptPath);
        } else {
          errors.push(`Referenced script invocation does not exist: ${scriptPath}`);
        }
      }
    }

    // Direct path candidates
    const tokens = text.split(/[\s,]+/);
    for (let token of tokens) {
      token = token.replace(/^[('"`]+|[)'"`:;,]+$/g, "");
      if (!token || token.includes("<") || token.includes(">") || token.includes("*")) continue;
      if (token.startsWith("http://") || token.startsWith("https://")) continue;

      const isKnownDir =
        token.startsWith("scripts/") ||
        token.startsWith("docs/") ||
        token.startsWith(".github/workflows/") ||
        token.startsWith("supabase/") ||
        token.startsWith("src/") ||
        token.startsWith("public/") ||
        token.startsWith("budgets/") ||
        token.startsWith("netlify/");

      const isKnownRootFile = [
        "next.config.mjs",
        "netlify.toml",
        "package.json",
        ".node-version",
        ".env.example",
      ].includes(token);

      const hasFileExt = /\.(ts|tsx|cjs|mjs|js|json|sql|yml|yaml|md|toml)$/.test(token);

      if (isKnownDir || isKnownRootFile || (hasFileExt && token.includes("/"))) {
        const absPath = path.resolve(REPO_ROOT, token);
        if (fs.existsSync(absPath)) {
          verified.push(token);
        } else {
          errors.push(`Referenced repository path does not exist: ${token}`);
        }
      }
    }
  }

  const uniqueVerified = Array.from(new Set(verified)).sort();
  return {
    valid: errors.length === 0,
    errors,
    verified: uniqueVerified,
  };
}

function runNegativeControl(realContent) {
  console.log("=== Running --negative-control test on real validator ===");

  // Mutation 1: Mutated runbook with a broken relative markdown link
  const mutatedLinkContent = realContent + "\n\n[Broken Link Test](../scripts/non_existent_fake_script_xyz.ts)\n";
  const resLink = validateRunbookContent(mutatedLinkContent);
  if (resLink.valid || !resLink.errors.some((e) => e.includes("non_existent_fake_script_xyz.ts"))) {
    console.error("[FAIL] Real validator failed to reject mutated runbook with broken link.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught mutated invalid link");

  // Mutation 2: Mutated runbook with missing required operational section
  const mutatedSectionContent = realContent.replace(/##\s+6\.\s+Incident[\s\S]*$/, "");
  const resSec = validateRunbookContent(mutatedSectionContent);
  if (resSec.valid || !resSec.errors.some((e) => e.includes("Incident"))) {
    console.error("[FAIL] Real validator failed to reject mutated runbook with missing section.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught missing operational section");

  console.log("[PASS] Negative control verified: real validator fails on mutated runbooks.");
  process.exit(0);
}

function main() {
  console.log("=== Checking Operational Runbook Guard ===");

  if (!fs.existsSync(RUNBOOK_PATH)) {
    console.error(`[FAIL] docs/ops-runbook.md not found at ${RUNBOOK_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(RUNBOOK_PATH, "utf8");

  if (process.argv.includes("--negative-control")) {
    runNegativeControl(content);
    return;
  }

  const result = validateRunbookContent(content);

  console.log(`Discovered ${result.verified.length} unique file & script references.`);

  if (!result.valid) {
    console.error(`\n[FAIL] Found ${result.errors.length} validation errors in docs/ops-runbook.md:`);
    for (const err of result.errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  if (result.verified.length < 25) {
    console.error(`\n[FAIL] Expected at least 25 verified file citations, found only ${result.verified.length}.`);
    process.exit(1);
  }

  console.log(`[PASS] Verified ${result.verified.length} existing files & scripts:`);
  for (const f of result.verified) {
    console.log(`  ✓ ${f}`);
  }

  console.log(`\n[SUCCESS] docs/ops-runbook.md passed all checks (${result.verified.length} verified references, 0 errors).`);
}

main();
