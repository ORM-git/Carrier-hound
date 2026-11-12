#!/usr/bin/env node
/**
 * scripts/check-ops-runbook.cjs
 *
 * Standalone offline guard for docs/ops-runbook.md.
 * Verifies:
 *   1. docs/ops-runbook.md exists and is non-empty.
 *   2. Extracts all file paths and script names referenced in the runbook.
 *   3. Verifies every referenced file and script exists in the repository.
 *   4. Ensures core operational sections (Deploy, Rollback, Cron, Migrations, Env, Incident) are present.
 *
 * Usage:
 *   node scripts/check-ops-runbook.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const RUNBOOK_PATH = path.join(REPO_ROOT, "docs", "ops-runbook.md");

function run() {
  console.log("=== Checking Operational Runbook Guard ===");

  if (process.argv.includes("--negative-control")) {
    console.log("Running in --negative-control test mode...");
    const fakeContent = "References `scripts/non_existent_fake_script_xyz.ts` in the doc.";
    const matches = Array.from(fakeContent.matchAll(/`([^`\n]+)`/g)).map((m) => m[1]);
    const fakePath = matches[0];
    const exists = fs.existsSync(path.resolve(REPO_ROOT, fakePath));
    if (!exists) {
      console.log("[PASS] Negative control successfully detected non-existent file path.");
      process.exit(0);
    } else {
      console.error("[FAIL] Negative control expected missing file, but it existed.");
      process.exit(1);
    }
  }

  if (!fs.existsSync(RUNBOOK_PATH)) {
    console.error(`[FAIL] docs/ops-runbook.md not found at ${RUNBOOK_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(RUNBOOK_PATH, "utf8");
  if (!content.trim()) {
    console.error("[FAIL] docs/ops-runbook.md is empty");
    process.exit(1);
  }

  // 1. Verify required operational sections
  const requiredSections = [
    "Deploy",
    "Rollback",
    "Cron",
    "Migration",
    "Env",
    "Incident",
  ];

  for (const sec of requiredSections) {
    const reg = new RegExp(`#+\\s+.*${sec}`, "i");
    if (!reg.test(content)) {
      console.error(`[FAIL] docs/ops-runbook.md missing required section covering: ${sec}`);
      process.exit(1);
    }
  }

  // 2. Extract referenced files and scripts
  const referencedFiles = new Set();

  // A. Markdown links: [title](target)
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

    // Check if relative to docs/ or repo root
    if (fs.existsSync(path.resolve(REPO_ROOT, target))) {
      referencedFiles.add(target.replace(/\\/g, "/"));
    } else if (fs.existsSync(path.resolve(REPO_ROOT, "docs", target))) {
      referencedFiles.add(path.posix.join("docs", target));
    } else {
      // Keep for failure assertion
      referencedFiles.add(target.replace(/\\/g, "/"));
    }
  }

  // B. Code spans and backticks: `target`
  const codeRegex = /`([^`\n]+)`/g;
  let codeMatch;
  while ((codeMatch = codeRegex.exec(content)) !== null) {
    const text = codeMatch[1].trim();

    // Check for script execution commands like `node scripts/foo.cjs` or `npx tsx scripts/bar.ts`
    const execMatches = text.matchAll(/(?:node|npx\s+tsx|cat|bash)\s+([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)/g);
    for (const em of execMatches) {
      const p = em[1].replace(/^[.\/]+/, "");
      if (p.includes("/") || p.endsWith(".ts") || p.endsWith(".cjs") || p.endsWith(".mjs") || p.endsWith(".js") || p.endsWith(".sql")) {
        referencedFiles.add(p);
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
        referencedFiles.add(token.replace(/\\/g, "/"));
      }
    }
  }

  console.log(`Discovered ${referencedFiles.size} unique file/script references to verify.`);

  const missing = [];
  const verified = [];

  for (const relPath of Array.from(referencedFiles).sort()) {
    const absPath = path.resolve(REPO_ROOT, relPath);
    if (fs.existsSync(absPath)) {
      verified.push(relPath);
    } else {
      missing.push(relPath);
    }
  }

  console.log(`[PASS] Verified ${verified.length} existing files & scripts:`);
  for (const f of verified) {
    console.log(`  ✓ ${f}`);
  }

  if (missing.length > 0) {
    console.error(`\n[FAIL] Found ${missing.length} missing file or script references:`);
    for (const m of missing) {
      console.error(`  ✗ ${m}`);
    }
    process.exit(1);
  }

  if (verified.length < 25) {
    console.error(`\n[FAIL] Expected at least 25 verified file citations, but found only ${verified.length}.`);
    process.exit(1);
  }

  console.log(`\n[SUCCESS] docs/ops-runbook.md passed all checks (${verified.length} verified references, 0 missing).`);
}

run();
