import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { checkPublicSourcemaps } from "./check-public-sourcemaps.mjs";
const root = mkdtempSync(path.join(tmpdir(), "cm-maps-"));
function put(name, body = "") {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}
try {
  put(".next/server/private.js.map", "{}");
  put(".next/static/chunks/safe.js", "console.log('safe')");
  assert.deepEqual(checkPublicSourcemaps(root), []);
  put(".next/static/chunks/leaked.js.map", "{}");
  put("public/inline.js", "//# sourceMappingURL=data:application/json;base64,e30=");
  put(".vercel/output/static/style.css", "/*# sourceMappingURL=style.css.map */");
  put("out/_next/static/legacy.js", "//@ sourceMappingURL=legacy.js.map");
  const failures = checkPublicSourcemaps(root);
  assert.equal(failures.length, 4);
  assert.ok(failures.includes(".next/static/chunks/leaked.js.map"));
  console.log("Public sourcemap guard: clean assets pass, private server maps excluded, public files/references fail.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
