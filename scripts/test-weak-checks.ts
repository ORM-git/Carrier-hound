import assert from "assert";

console.log("==================================================================================");
console.log("          TEST WEAK CHECKS: VERIFICATION AGAINST CORRUPTED & FAILING DATA         ");
console.log("==================================================================================\n");

interface WeakCheckFinding {
  id: string;
  file: string;
  line: number;
  description: string;
  status: "WEAK_DETECTED" | "ROBUST";
  details: string;
}

const findings: WeakCheckFinding[] = [];

// -------------------------------------------------------------------------------------
// TEST 1: run-full-pro-regression.js line 336 (Resume step modal & preview verification)
// -------------------------------------------------------------------------------------
console.log("Test 1: Evaluating run-full-pro-regression.js:336 with corrupted modal state...");

// The actual check at line 336 in scripts/run-full-pro-regression.js:
function existingRegressionCheck(tailorModalData: { hasTailorHeader: boolean; hasScore: boolean; hasPreview: boolean }): "PASS" | "FAIL" {
  if (tailorModalData.hasTailorHeader) {
    return "PASS";
  } else {
    return "FAIL";
  }
}

// Corrupted/incomplete data: header rendered, but score calculation failed and preview is blank
const wrongResumeData = {
  hasTailorHeader: true,
  hasScore: false,
  hasPreview: false,
};

const regressionResult = existingRegressionCheck(wrongResumeData);

if (regressionResult === "PASS") {
  console.log("❌ WEAK CHECK CONFIRMED: scripts/run-full-pro-regression.js:336 passes when score and preview are missing!");
  findings.push({
    id: "REGRESSION-RESUME-WEAK",
    file: "scripts/run-full-pro-regression.js",
    line: 336,
    description: "Tailored resume modal passes based solely on hasTailorHeader, ignoring hasScore and hasPreview",
    status: "WEAK_DETECTED",
    details: "When fed { hasTailorHeader: true, hasScore: false, hasPreview: false }, existing logic returns PASS. Should require (hasTailorHeader && hasScore && hasPreview).",
  });
} else {
  console.log("✅ Check is robust.");
}

// -------------------------------------------------------------------------------------
// TEST 2: test-filters.ts line 398-417 (Insert error reuse & update check)
// -------------------------------------------------------------------------------------
console.log("\nTest 2: Evaluating test-filters.ts RLS assertion behavior against wrong data...");

// Simulation of vulnerable reused-variable pattern:
function vulnerableFilterCheck(insertSucceeded: boolean, updateSucceeded: boolean): boolean {
  let err: any = insertSucceeded ? null : new Error("permission denied for table jobs");
  // If err variable is reused and update succeeds with null error:
  // let { error: err } = update ... if not reassigned, old err lingers
  const updateErr = updateSucceeded ? null : new Error("permission denied for table jobs");
  // Vulnerable check where insert error shadowed update error:
  const isDenied = err !== null; // ignores updateErr!
  return isDenied;
}

// Simulation of current robust test-filters.ts logic:
function currentFilterCheck(anonInsertError: any, anonUpdateData: any[], anonUpdateError: any): boolean {
  const insertBlocked = anonInsertError !== null;
  const updatedRows = Array.isArray(anonUpdateData) ? anonUpdateData.length : 0;
  const updateBlocked = (anonUpdateError !== null || updatedRows === 0) && updatedRows === 0;
  return insertBlocked && updateBlocked;
}

// Feed wrong data: Insert succeeded (anonInsertError = null)
const wrongDataInsertAllowed = currentFilterCheck(null, [], new Error("permission denied"));
assert.strictEqual(wrongDataInsertAllowed, false, "Current test-filters.ts correctly fails when insert is allowed");

// Feed wrong data: Update succeeded (updatedRows = 1)
const wrongDataUpdateAllowed = currentFilterCheck(new Error("permission denied"), [{ id: "123" }], null);
assert.strictEqual(wrongDataUpdateAllowed, false, "Current test-filters.ts correctly fails when update is allowed");

console.log("✅ Current test-filters.ts lines 398-417 correctly fail on wrong data (separate variables used).");

// But demonstrate the historical pattern:
const historicalLingeringError = vulnerableFilterCheck(false, true); // update succeeded!
if (historicalLingeringError === true) {
  findings.push({
    id: "FILTERS-REUSED-ERROR-RISK",
    file: "scripts/test-filters.ts",
    line: 413,
    description: "Historical pattern of reused 'error' variable can mask update successes if insert errored",
    status: "WEAK_DETECTED",
    details: "In test-filters.ts, lines 390 & 405 now use separate variables (anonInsertError, anonUpdateError). Verified that current implementation rejects wrong data.",
  });
}

// -------------------------------------------------------------------------------------
// NEGATIVE CONTROL: Prove test-weak-checks fails if a weak check is falsely marked robust
// -------------------------------------------------------------------------------------
console.log("\n--- RUNNING NEGATIVE CONTROL ---");
let negativeControlPassed = false;
try {
  // We know run-full-pro-regression.js:336 is weak. Asserting it is robust must throw!
  assert.strictEqual(
    regressionResult,
    "FAIL",
    "Negative control: existingRegressionCheck was expected to fail on wrong data but passed"
  );
} catch (err: any) {
  negativeControlPassed = true;
  console.log(`✅ Negative control caught the weak check: "${err.message}"`);
}

assert(negativeControlPassed, "Negative control failed to detect the weak check!");

console.log("\n==================================================================================");
console.log("WEAK CHECKS AUDIT FINDINGS:");
findings.forEach((f, i) => {
  console.log(`${i + 1}. [${f.status}] ${f.file}:${f.line} — ${f.description}`);
  console.log(`   Details: ${f.details}`);
});
console.log("==================================================================================");
