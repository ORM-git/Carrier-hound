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

// Inspect the actual callback structure, independent of formatter line wrapping.
import ts from "typescript";
function textureContract(src: string) {
  const file = ts.createSourceFile(
    "globe.tsx",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let forwards = false,
    settles = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "loadStyleTexture" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer) &&
      ts.isBlock(node.initializer.body)
    ) {
      for (const st of node.initializer.body.statements) {
        if (
          !ts.isExpressionStatement(st) ||
          !ts.isCallExpression(st.expression) ||
          st.expression.expression.getText(file) !== "textureLoader.load"
        )
          continue;
        const error = st.expression.arguments[3];
        if (!error || !ts.isArrowFunction(error) || !ts.isBlock(error.body)) continue;
        forwards = error.body.statements.some(
          (st) =>
            ts.isIfStatement(st) &&
            st.expression.getText(file) === "!isCancelled" &&
            ts.isExpressionStatement(st.thenStatement) &&
            ts.isCallExpression(st.thenStatement.expression) &&
            ts.isIdentifier(st.thenStatement.expression.expression) &&
            st.thenStatement.expression.expression.text === "onError" &&
            !!st.thenStatement.expression.questionDotToken
        );
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "loadStyleTexture") {
      const cb = node.arguments[2];
      if (cb && ts.isArrowFunction(cb)) {
        const direct = ts.isBlock(cb.body)
          ? cb.body.statements
              .filter(ts.isExpressionStatement)
              .map((st) => st.expression)
              .filter(ts.isCallExpression)
          : [];
        const calls = direct.map(
          (c) =>
            c.expression.getText(file) +
            "(" +
            c.arguments.map((a) => a.getText(file)).join(",") +
            ")"
        );
        settles =
          calls.includes("setTextureLoaded(true)") && calls.includes("setTextureLoadFailed(true)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { forwards, settles };
}
function loadStyleTextureCallsOnError(src: string): boolean {
  return textureContract(src).forwards;
}
function runNegativeControl(): number {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/JobRadarGlobe.tsx"),
    "utf8"
  );
  for (const [needle, field] of [
    ["onError?.()", "forwards"],
    ["setTextureLoaded(true);", "settles"],
    ["setTextureLoadFailed(true);", "settles"],
  ] as const) {
    // Remove every matching call so the check must reject the corresponding missing behaviour.
    const broken = src.split(needle).join("/* mutation removed call */");
    assert.notStrictEqual(broken, src, "mutation must change source");
    assert.strictEqual(
      textureContract(broken)[field],
      false,
      "negative control must reject missing " + needle
    );
  }
  for (const replacement of [
    "/* onError?.() */",
    "if (false) onError?.()",
    "(() => onError?.())",
  ]) {
    const broken = src.replace("if (!isCancelled) onError?.();", replacement + ";");
    assert.notStrictEqual(broken, src);
    assert.strictEqual(textureContract(broken).forwards, false, "reject comment/dead/nested decoy");
  }
  console.log(
    "PASS negative controls reject missing forwarding and either missing error-state setter"
  );
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
  textureContract(src).settles
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
  /const fallbackMesh = new THREE\.Mesh\(earthGeo, fallbackMat\);\s*scene\.add\(fallbackMesh\);/.test(
    src
  )
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
