/**
 * OpenAPI coverage check (offline, registered in suite-runner).
 *
 * Guarantees docs/openapi.yaml stays honest:
 *  - every src/app/api route file has a matching path entry in the spec
 *  - every /api path in the spec maps to an existing route file
 *  - every spec operation method matches an exported handler in the route file
 *  - the spec parses as YAML-shaped text with the required top-level keys
 * No network calls; no external YAML dependency (structural string checks).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const specPath = path.join(root, "docs", "openapi.yaml");
const apiDir = path.join(root, "src", "app", "api");

console.log("OpenAPI spec coverage validation (offline)");

assert.ok(fs.existsSync(specPath), "docs/openapi.yaml exists");
const spec = fs.readFileSync(specPath, "utf8");
for (const key of ["openapi: 3", "info:", "paths:", "components:"]) {
  assert.ok(spec.includes(key), `spec has top-level ${key}`);
}
console.log("  -> [PASS] spec file exists with required top-level keys");

// Collect route files -> [apiPath, methods]
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === "route.ts") yield full;
  }
}

const routes = new Map<string, Set<string>>();
for (const file of walk(apiDir)) {
  const rel = path.relative(apiDir, path.dirname(file)).replace(/\\/g, "/");
  const apiPath = `/api/${rel}`;
  const content = fs.readFileSync(file, "utf8");
  const methods = new Set<string>();
  for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(content)) {
      methods.add(m);
    }
  }
  routes.set(apiPath, methods);
}
assert.ok(routes.size >= 20, `route inventory sane (${routes.size} routes)`);

// Collect spec paths -> methods (simple structural parse of the paths block)
const pathsBlock = spec.split(/^paths:/m)[1].split(/^components:/m)[0];
const specPaths = new Map<string, Set<string>>();
const pathRe = /^  (\/api\/[a-z0-9\-/]+):\s*$/gim;
let match: RegExpExecArray | null;
const pathPositions: Array<{ p: string; start: number }> = [];
while ((match = pathRe.exec(pathsBlock)) !== null) {
  pathPositions.push({ p: match[1], start: match.index });
}
for (let i = 0; i < pathPositions.length; i++) {
  const end = i + 1 < pathPositions.length ? pathPositions[i + 1].start : pathsBlock.length;
  const block = pathsBlock.slice(pathPositions[i].start, end);
  const methods = new Set<string>();
  for (const m of ["get", "post", "put", "delete", "patch"]) {
    if (new RegExp(`^    ${m}:\\s*$`, "m").test(block)) methods.add(m.toUpperCase());
  }
  specPaths.set(pathPositions[i].p, methods);
}

// 1. Every route file is documented
for (const [routePath, methods] of routes) {
  assert.ok(specPaths.has(routePath), `spec documents ${routePath}`);
  for (const method of methods) {
    assert.ok(
      specPaths.get(routePath)!.has(method),
      `spec documents ${method} ${routePath}`
    );
  }
}
console.log(`  -> [PASS] all ${routes.size} route files are documented with their exported methods`);

// 2. Every spec path maps to a real route file
for (const [specPathEntry, methods] of specPaths) {
  assert.ok(routes.has(specPathEntry), `spec path ${specPathEntry} maps to a real route file`);
  for (const method of methods) {
    assert.ok(
      routes.get(specPathEntry)!.has(method),
      `route file exports ${method} for spec path ${specPathEntry}`
    );
  }
}
console.log(`  -> [PASS] all ${specPaths.size} spec paths map to real route files and methods`);

// 3. Admin routes carry the adminSession security requirement
for (const [p, methods] of specPaths) {
  if (p.startsWith("/api/admin/") && methods.size > 0) {
    const idx = spec.indexOf(`${p}:`);
    const block = spec.slice(idx, idx + 1200);
    assert.ok(block.includes("adminSession"), `${p} operations require adminSession in the spec`);
  }
}
console.log("  -> [PASS] admin paths declare the adminSession security scheme");

console.log("\nAll OpenAPI coverage checks passed.");
