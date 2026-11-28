import assert from "assert";
import ts from "typescript";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Lock, RotateCw } from "lucide-react";

/**
 * Radar Drawer Error Banner Component representation as rendered in JobRadarGlobe
 */
function RadarJobDrawerBanner({
  radarProUnlockError,
  onRetry,
  loading = false,
}: {
  radarProUnlockError: boolean;
  onRetry: () => void;
  loading?: boolean;
}) {
  if (!radarProUnlockError) return null;

  return React.createElement(
    "div",
    {
      "data-testid": "radar-pro-unlock-error-banner",
      className:
        "p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 flex items-center justify-between gap-3 text-xs text-slate-300",
    },
    React.createElement(
      "div",
      { className: "flex items-center gap-2" },
      React.createElement(Lock, { className: "w-4 h-4 text-cyan-400 shrink-0" }),
      React.createElement("span", null, "Details are locked. Retry")
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onRetry,
        disabled: loading,
        className:
          "px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white border border-slate-600 transition flex items-center gap-1.5 cursor-pointer",
      },
      React.createElement(RotateCw, { className: `w-3 h-3 ${loading ? "animate-spin" : ""}` }),
      React.createElement("span", null, "Retry")
    )
  );
}

async function runRadarDrawerRetryErrorSuite() {
  console.log("================================================================================");
  console.log("       CAREERMONKE RADAR JOB DRAWER RETRY ERROR CLEARING TEST SUITE             ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  // ---------------------------------------------------------------------------
  // TEST 1: Drawer Error Lifecycle Simulation: Fail -> Retry Success -> Banner Gone
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying Fail -> Retry Success flow (banner must be cleared)...");

  // State machine simulation replicating JobRadarGlobe's state transitions
  let radarProUnlockError = false;
  let jobsLoading = false;
  let selectedCity: string | null = "san-francisco";

  const handleRetry = async (simulateSuccess: boolean) => {
    // 1. Clear banner at the start of retry
    radarProUnlockError = false;
    jobsLoading = true;

    // Simulate async API call
    if (simulateSuccess) {
      // 2. On success, banner remains false
      radarProUnlockError = false;
    } else {
      // On failure, banner is surfaced
      radarProUnlockError = true;
    }
    jobsLoading = false;
  };

  const handleTargetChange = (newCity: string | null) => {
    // Whenever drawer opens a different job/city, clear error
    radarProUnlockError = false;
    selectedCity = newCity;
  };

  // STEP A: Initial fetch fails (HTTP 500 / Network Error)
  await handleRetry(false);
  assert.strictEqual(
    radarProUnlockError,
    true,
    "radarProUnlockError must be true on failed attempt"
  );

  const markupAfterFailure = renderToStaticMarkup(
    React.createElement(RadarJobDrawerBanner, {
      radarProUnlockError,
      onRetry: () => handleRetry(true),
      loading: jobsLoading,
    })
  );
  assert.ok(
    markupAfterFailure.includes("radar-pro-unlock-error-banner"),
    "Banner must be rendered in DOM when unlock fails"
  );
  assert.ok(
    markupAfterFailure.includes("Details are locked. Retry"),
    "Error banner copy must be present when unlock fails"
  );
  console.log("  -> [PASS-LOCAL] Initial failure: Banner correctly rendered in DOM.");

  // STEP B: User clicks Retry -> Retry succeeds
  await handleRetry(true);

  if (isNegativeControl) {
    console.log(
      "\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (banner MUST linger after retry success)...\n"
    );
    // Deliberately assert that banner is still visible after success
    assert.strictEqual(
      radarProUnlockError,
      true,
      "Negative control expected mismatch: banner must NOT be visible after retry success!"
    );
    return;
  }

  const markupAfterSuccess = renderToStaticMarkup(
    React.createElement(RadarJobDrawerBanner, {
      radarProUnlockError,
      onRetry: () => handleRetry(true),
      loading: jobsLoading,
    })
  );

  assert.strictEqual(
    radarProUnlockError,
    false,
    "radarProUnlockError must be false after successful retry"
  );
  assert.strictEqual(
    markupAfterSuccess,
    "",
    "Banner markup must be completely empty after successful retry"
  );
  assert.strictEqual(
    markupAfterSuccess.includes("radar-pro-unlock-error-banner"),
    false,
    "Banner MUST be gone after successful retry"
  );
  console.log("  -> [PASS-LOCAL] Retry success: Banner is completely gone from DOM.");

  // ---------------------------------------------------------------------------
  // TEST 2: Different Target / City Selection Clears Lingering Error
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying opening a different job/city clears lingering error state...");
  // Simulate previous failure on City A
  await handleRetry(false);
  assert.strictEqual(radarProUnlockError, true, "City A has unlock error");

  // User selects City B / different job
  handleTargetChange("london");
  assert.strictEqual(selectedCity, "london", "City selection updated");
  assert.strictEqual(
    radarProUnlockError,
    false,
    "Selecting a different job/city must immediately clear banner state"
  );

  const markupAfterSwitch = renderToStaticMarkup(
    React.createElement(RadarJobDrawerBanner, {
      radarProUnlockError,
      onRetry: () => handleRetry(true),
      loading: jobsLoading,
    })
  );
  assert.strictEqual(
    markupAfterSwitch,
    "",
    "Drawer for new job/city must not show lingering error banner from previous job"
  );
  console.log(
    "  -> [PASS-LOCAL] Target switch: Previous error immediately cleared for new selection."
  );

  // ---------------------------------------------------------------------------
  // TEST 3: Source Code Verification in src/components/JobRadarGlobe.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Inspecting src/components/JobRadarGlobe.tsx source code guards...");
  const globePath = path.resolve(process.cwd(), "src/components/JobRadarGlobe.tsx");
  const globeSource = fs.readFileSync(globePath, "utf-8");

  // Structural checks of the shipped callbacks, not adjacent formatter-specific strings.
  function guards(src: string) {
    const f = ts.createSourceFile(
      "globe.tsx",
      src,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const found = { start: false, success: false, failure: false, retry: false, target: false };
    const directCalls = (n: ts.Node): ts.CallExpression[] => {
      if (ts.isArrowFunction(n)) return directCalls(n.body);
      if (
        ts.isJsxAttribute(n) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression
      )
        return directCalls(n.initializer.expression);
      const statements = ts.isBlock(n) ? n.statements : ts.isExpressionStatement(n) ? [n] : [];
      return statements
        .filter(ts.isExpressionStatement)
        .map((st) => st.expression)
        .filter(ts.isCallExpression);
    };
    const has = (n: ts.Node, value: boolean) =>
      directCalls(n).some(
        (c) =>
          ts.isIdentifier(c.expression) &&
          c.expression.text === "setRadarProUnlockError" &&
          c.arguments.length === 1 &&
          c.arguments[0].kind === (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword)
      );
    const containsRetry = (n: ts.Node): boolean => {
      let found = false;
      const visit = (x: ts.Node) => {
        if (
          ts.isCallExpression(x) &&
          x.expression.getText(f) === "fetchCityJobs" &&
          x.arguments.map((a) => a.getText(f)).join(",") === "selectedCity,jobsPage,false"
        )
          found = true;
        ts.forEachChild(x, visit);
      };
      visit(n);
      return found;
    };
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.name.getText(f) === "fetchCityJobs") {
        const init = n.initializer;
        if (init && ts.isCallExpression(init)) {
          const cb = init.arguments[0];
          if (cb && ts.isArrowFunction(cb) && ts.isBlock(cb.body)) {
            found.start = cb.body.statements.slice(0, 3).some((st) => has(st, false));
          }
        }
      }
      if (ts.isIfStatement(n) && n.expression.getText(f) === "proRes.ok")
        found.success =
          has(n.thenStatement, false) && !!n.elseStatement && has(n.elseStatement, true);
      if (ts.isCatchClause(n) && n.variableDeclaration?.name.getText(f) === "proErr")
        found.failure = has(n.block, true);
      if (ts.isJsxAttribute(n) && n.name.getText(f) === "onClick" && containsRetry(n))
        found.retry = has(n, false);
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(f) === "useEffect" &&
        n.arguments[1] &&
        ts.isArrayLiteralExpression(n.arguments[1]) &&
        n.arguments[1].elements.some((e) => e.getText(f) === "selectedCity")
      )
        found.target = found.target || has(n.arguments[0], false);
      ts.forEachChild(n, visit);
    };
    visit(f);
    return found;
  }
  for (const [name, ok] of Object.entries(guards(globeSource)))
    assert.ok(ok, "actual shipped callback guard missing: " + name);
  assert.ok(globeSource.includes("<span>Details are locked. Retry</span>"), "Preserve banner copy");
  // Mutation controls must reject removal of clearing or failure surfacing in the actual component.
  for (const value of ["false", "true"]) {
    const broken = globeSource
      .split("setRadarProUnlockError(" + value + ");")
      .join("/* mutation removed state transition */");
    assert.notStrictEqual(broken, globeSource);
    assert.ok(
      Object.values(guards(broken)).some((ok) => !ok),
      "must reject removed " + value + " transitions"
    );
  }
  console.log(
    "  -> [PASS-LOCAL] Source code checks: All 5 error-clearing locations verified; 0 copy changes."
  );

  for (const replacement of [
    "/* setRadarProUnlockError(false); */",
    "if (false) setRadarProUnlockError(false);",
    "(() => setRadarProUnlockError(false));",
  ]) {
    const broken = globeSource.split("setRadarProUnlockError(false);").join(replacement);
    assert.ok(!guards(broken).retry, "reject comment/dead/nested retry decoys");
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Subprocess Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(
    `  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`
  );

  console.log("\n================================================================================");
  console.log("    ALL RADAR JOB DRAWER RETRY ERROR TESTS PASSED SUCCESSFULLY [PASS-LOCAL]     ");
  console.log("================================================================================");
}

runRadarDrawerRetryErrorSuite().catch((err) => {
  console.error("\n[FAIL] Radar Drawer Retry Error Suite Error:\n", err);
  process.exit(1);
});
