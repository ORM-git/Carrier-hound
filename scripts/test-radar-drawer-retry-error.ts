import assert from "assert";
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
  assert.strictEqual(radarProUnlockError, true, "radarProUnlockError must be true on failed attempt");

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
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (banner MUST linger after retry success)...\n");
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

  assert.strictEqual(radarProUnlockError, false, "radarProUnlockError must be false after successful retry");
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
  console.log("  -> [PASS-LOCAL] Target switch: Previous error immediately cleared for new selection.");

  // ---------------------------------------------------------------------------
  // TEST 3: Source Code Verification in src/components/JobRadarGlobe.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Inspecting src/components/JobRadarGlobe.tsx source code guards...");
  const globePath = path.resolve(process.cwd(), "src/components/JobRadarGlobe.tsx");
  const globeSource = fs.readFileSync(globePath, "utf-8");

  // 1. fetchCityJobs clears error at start
  assert.ok(
    globeSource.includes("setRadarProUnlockError(false);") &&
      globeSource.includes("async (target: ActiveSelection, page: number = 1, append: boolean = false) => {\n      setJobsLoading(true);\n      setRadarProUnlockError(false);") ||
      globeSource.includes("async (target: ActiveSelection, page: number = 1, append: boolean = false) => {\r\n      setJobsLoading(true);\r\n      setRadarProUnlockError(false);"),
    "fetchCityJobs must clear radarProUnlockError(false) at start of every fetch/retry"
  );

  // 2. fetchCityJobs clears error on successful pro unlock
  assert.ok(
    globeSource.includes("setRadarProUnlockError(false);\n              } else {\n                console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failed") ||
      globeSource.includes("setRadarProUnlockError(false);\r\n              } else {\r\n                console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failed"),
    "fetchCityJobs must clear radarProUnlockError(false) on successful Pro unlock response"
  );

  // 3. fetchCityJobs sets error on catch
  assert.ok(
    globeSource.includes("catch (proErr: any) {\n            console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failure") ||
      globeSource.includes("catch (proErr: any) {\r\n            console.error(`[API /jobs/pro error]: Radar drawer Pro unlock failure"),
    "fetchCityJobs must catch Pro unlock network errors and handle error state"
  );

  // 4. Retry button explicitly clears error on click
  assert.ok(
    globeSource.includes("onClick={() => {\n                    setRadarProUnlockError(false);") ||
      globeSource.includes("onClick={() => {\r\n                    setRadarProUnlockError(false);"),
    "Retry button in radar drawer must clear setRadarProUnlockError(false) on click"
  );

  // 5. Drawer target changes clear error
  assert.ok(
    globeSource.includes("useEffect(() => {\n    setRadarProUnlockError(false);") ||
      globeSource.includes("useEffect(() => {\r\n    setRadarProUnlockError(false);"),
    "useEffect watching selectedCity must clear radarProUnlockError on target change"
  );

  // 6. Zero unintended copy changes
  assert.ok(
    globeSource.includes("<span>Details are locked. Retry</span>"),
    "Must preserve existing banner copy without modification"
  );
  console.log("  -> [PASS-LOCAL] Source code checks: All 5 error-clearing locations verified; 0 copy changes.");

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
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("    ALL RADAR JOB DRAWER RETRY ERROR TESTS PASSED SUCCESSFULLY [PASS-LOCAL]     ");
  console.log("================================================================================");
}

runRadarDrawerRetryErrorSuite().catch((err) => {
  console.error("\n[FAIL] Radar Drawer Retry Error Suite Error:\n", err);
  process.exit(1);
});
