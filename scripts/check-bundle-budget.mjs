#!/usr/bin/env node
/**
 * Bundle size budget check (runs after `next build`).
 *
 * The per-chunk budget (400 KB) is grounded in the production baseline
 * measured 2026-11-06 from https://careermonke.com (largest single chunk =
 * 340,293 bytes, the globe visualisation; ~18% headroom).
 *
 * The landing first-load budget is a RATCHET: the app-build-manifest basis
 * measured 800,131 bytes in CI on 2026-11-06 (manifest byte counts differ
 * from the deployed-site measurement above). Budget = baseline + ~5%
 * headroom; tighten it as the landing bundle shrinks. Landing code is not
 * to be modified to fit this budget (owner decision).
 *
 * Checks:
 *  1. Landing first-load JS (from .next/app-build-manifest.json) <= FIRST_LOAD_BUDGET_BYTES
 *  2. Every individual JS asset <= CHUNK_BUDGET_BYTES
 *
 * Exits non-zero when a budget is exceeded. Skips (with a warning) when build
 * output is missing so the script never blocks a non-build environment.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Ratchet: CI-measured baseline 800,131 + ~5% headroom. Lower over time.
const FIRST_LOAD_BUDGET_BYTES = 840_000;
const CHUNK_BUDGET_BYTES = 400_000;

const root = process.cwd();

function* walkJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

function sizeOf(file) {
  return statSync(file).size;
}

let failures = 0;

// 1. Landing first-load JS via the app build manifest (when present).
const manifestPath = path.join(root, ".next", "app-build-manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = manifest.pages?.["/page"] ?? [];
  const total = files.reduce((sum, rel) => {
    const full = path.join(root, ".next", rel);
    return existsSync(full) ? sum + sizeOf(full) : sum;
  }, 0);
  const status = total <= FIRST_LOAD_BUDGET_BYTES ? "PASS" : "FAIL";
  if (status === "FAIL") failures++;
  console.log(
    `[${status}] landing first-load JS: ${total.toLocaleString()} / ${FIRST_LOAD_BUDGET_BYTES.toLocaleString()} bytes (${files.length} files)`
  );
} else {
  console.log("[SKIP] .next/app-build-manifest.json not found; first-load check skipped (run after next build).");
}

// 2. Per-chunk cap across all emitted JS.
const staticDir = existsSync(path.join(root, "out", "_next", "static"))
  ? path.join(root, "out", "_next", "static")
  : path.join(root, ".next", "static");

if (existsSync(staticDir)) {
  let largest = { file: null, size: 0 };
  for (const file of walkJs(staticDir)) {
    const size = sizeOf(file);
    if (size > largest.size) largest = { file, size };
    if (size > CHUNK_BUDGET_BYTES) {
      failures++;
      console.log(
        `[FAIL] chunk exceeds budget: ${path.relative(root, file)} = ${size.toLocaleString()} / ${CHUNK_BUDGET_BYTES.toLocaleString()} bytes`
      );
    }
  }
  if (largest.file && largest.size <= CHUNK_BUDGET_BYTES) {
    console.log(
      `[PASS] largest chunk: ${path.relative(root, largest.file)} = ${largest.size.toLocaleString()} / ${CHUNK_BUDGET_BYTES.toLocaleString()} bytes`
    );
  }
} else {
  console.log("[SKIP] no static output dir found; chunk check skipped.");
}

if (failures > 0) {
  console.error(`\nBundle budget: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nBundle budget: all checks passed.");
