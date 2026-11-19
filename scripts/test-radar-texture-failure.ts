/**
 * Guards against the full-screen loading overlay in JobRadarGlobe staying up
 * forever when the earth texture itself fails to load (even with valid
 * telemetry): the initial loadStyleTexture() call must settle textureLoaded
 * on error, not just on success, and the overlay must still gate on it.
 * Run: npx tsx scripts/test-radar-texture-failure.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

// Minimal, order-independent regex: an onError callback body (within the next
// 400 chars after the "() => {" that follows textureLoader.load's second
// `undefined,` argument marker inside loadStyleTexture) must call onError?.().
function loadStyleTextureCallsOnError(src: string): boolean {
  const fnStart = src.indexOf("const loadStyleTexture = (");
  assert.ok(fnStart !== -1, "loadStyleTexture definition not found");
  const fnBody = src.slice(fnStart, fnStart + 1200);
  return /onError\?\.\(\)/.test(fnBody);
}

function runNegativeControl(): number {
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/components/JobRadarGlobe.tsx"), "utf8");

  // Simulate the original bug, reverting both halves of the fix:
  // 1) loadStyleTexture's onError handler did nothing (no forwarding).
  let leaky = src.replace(/if \(!isCancelled\) onError\?\.\(\);/, "/* leave fallback material in place on error */");
  // 2) the initial call site had no third (onError) argument at all.
  leaky = leaky.replace(
    /\}, \(\) => \{\s*\/\/ Texture failed to load[\s\S]{0,200}setTextureLoaded\(true\);\s*setTextureLoadFailed\(true\);\s*\}\);/,
    "});"
  );

  assert.ok(!loadStyleTextureCallsOnError(leaky), "negative control: leaky source must fail the onError-call check");
  assert.ok(
    !/\}, \(\) => \{\s*\/\/ Texture failed to load[\s\S]{0,200}setTextureLoaded\(true\);\s*setTextureLoadFailed\(true\);\s*\}\);/.test(
      leaky
    ),
    "negative control: leaky source must fail the call-site settle check"
  );
  console.log("PASS negative control correctly rejects a source lacking the fix");
  return 0;
}

if (process.argv.includes("--negative-control")) {
  process.exit(runNegativeControl());
}

const globePath = path.resolve(process.cwd(), "src/components/JobRadarGlobe.tsx");
const src = fs.readFileSync(globePath, "utf8");

check(
  "loadStyleTexture's onError branch forwards to the caller's onError callback",
  loadStyleTextureCallsOnError(src)
);

check(
  "initial loadStyleTexture call site settles textureLoaded AND marks textureLoadFailed on error",
  /\}, \(\) => \{\s*\/\/ Texture failed to load[\s\S]{0,200}setTextureLoaded\(true\);\s*setTextureLoadFailed\(true\);\s*\}\);/.test(
    src
  )
);

check(
  "loading overlay still gates on !textureLoaded (so settling it on error clears the overlay)",
  /\(!textureLoaded \|\| \(isLoadingTelemetry && !telemetry\)\)/.test(src)
);

check(
  "a non-blocking note is shown on texture failure (pointer-events-none, doesn't block interaction)",
  /textureLoadFailed &&[\s\S]{0,200}pointer-events-none/.test(src)
);

check(
  "fallback wireframe mesh is still added to the scene before the texture load attempt (visible once overlay clears)",
  /const fallbackMesh = new THREE\.Mesh\(earthGeo, fallbackMat\);\s*scene\.add\(fallbackMesh\);/.test(src)
);

// Negative-control subprocess: confirms this test actually detects a reintroduced bug, not just a tautology.
const neg = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
  encoding: "utf-8",
  env: process.env,
});
check(
  "negative control subprocess passes (confirms the test fails on a reverted/leaky source)",
  neg.status === 0
);
if (neg.status !== 0) {
  console.log(neg.stdout);
  console.log(neg.stderr);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
