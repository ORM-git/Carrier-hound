/**
 * Guards WebGL memory-leak hygiene in JobRadarGlobe (three.js globe):
 * the unmount path must release geometries/materials, marker meshes, the
 * WebGL context itself, RAF and listeners, and an async texture that
 * finishes loading after unmount must be disposed, not leaked.
 * Run: npx tsx scripts/test-globe-cleanup.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const src = fs.readFileSync("src/components/JobRadarGlobe.tsx", "utf8");

check(
  "async texture disposed when load completes after unmount",
  /if \(isCancelled\) \{\s*\/\/[^}]*texture\.dispose\(\);\s*return;\s*\}/s.test(src) ||
    /if \(isCancelled\) \{\s*texture\.dispose\(\);\s*return;\s*\}/s.test(src)
);
check(
  "unmount cleanup disposes tracked disposables",
  /disposablesRef\.current\.forEach\(\(d\) => \{[\s\S]*?d\.dispose\(\)/.test(src)
);
check(
  "unmount cleanup disposes marker group children (effect-9-owned meshes)",
  /markersGroupRef\.current[\s\S]{0,600}?child\.geometry\.dispose\(\)/.test(src.split("return () => {").pop() || "")
);
check("controls disposed on unmount", /controls\.dispose\(\)/.test(src));
check("renderer disposed on unmount", /renderer\.dispose\(\)/.test(src));
check(
  "WebGL context explicitly released on unmount (forceContextLoss)",
  /renderer\.forceContextLoss\(\)/.test(src)
);
check(
  "animation frame cancelled on unmount",
  /cancelAnimationFrame\(animationFrameRef\.current\)/.test(src)
);
check(
  "resize and visibility listeners removed on unmount",
  /removeEventListener\("resize", handleResize\)/.test(src) &&
    /removeEventListener\("visibilitychange", handleVisibilityChange\)/.test(src)
);
check(
  "renderer canvas removed from DOM on unmount",
  /renderer\.domElement\.remove\(\)/.test(src)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
