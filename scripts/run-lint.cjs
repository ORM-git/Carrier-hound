#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = process.cwd();
const baselinePath = path.join(rootDir, ".eslint-baseline.json");

let maxWarnings = 305;
if (fs.existsSync(baselinePath)) {
  try {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    if (typeof baseline.maxWarnings === "number") {
      maxWarnings = baseline.maxWarnings;
    }
  } catch (_err) {
    console.warn("[lint] Warning: Failed to parse .eslint-baseline.json, using default cap 305");
  }
}

const userArgs = process.argv.slice(2);
const hasMaxWarnings = userArgs.some((arg) => arg.startsWith("--max-warnings"));
const hasTarget = userArgs.some((arg) => !arg.startsWith("-"));

const eslintArgs = [];
if (!hasTarget) {
  eslintArgs.push("src");
}
if (!hasMaxWarnings) {
  eslintArgs.push("--max-warnings", String(maxWarnings));
}
eslintArgs.push(...userArgs);

const isWindows = process.platform === "win32";
const eslintCmd = isWindows ? "npx.cmd" : "npx";

const result = spawnSync(eslintCmd, ["eslint", ...eslintArgs], {
  stdio: "inherit",
  shell: isWindows,
  cwd: rootDir,
});

process.exit(result.status !== null ? result.status : 1);
