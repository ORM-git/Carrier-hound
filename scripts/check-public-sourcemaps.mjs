#!/usr/bin/env node
/** Fail a production build if browser assets contain maps or sourceMappingURL
 * references. Never scan .next/server: private server maps are not public. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkPublicSourcemaps(root) {
  const failures = [];
  const directories = ["public", ".next/static", "out/_next/static", ".vercel/output/static"];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".map")) failures.push(path.relative(root, full));
      else if (/\.(?:m?js|css)$/.test(entry.name)) {
        const source = readFileSync(full, "utf8");
        if (/\/[/\*][#@]\s*sourceMappingURL\s*=/.test(source)) failures.push(`${path.relative(root, full)} (sourceMappingURL)`);
      }
    }
  }
  for (const dir of directories) {
    const full = path.join(root, dir);
    if (existsSync(full)) walk(full);
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(process.cwd(), ".next/static"))) {
    console.error("Public sourcemap check needs a completed production build (.next/static).");
    process.exit(2);
  }
  const failures = checkPublicSourcemaps(process.cwd());
  if (failures.length) {
    console.error("Public sourcemaps must not ship:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("Public assets contain no sourcemaps or sourceMappingURL references.");
}
