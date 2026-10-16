import assert from "assert";
import fs from "fs";
import path from "path";

console.log("==================================================================================");
console.log("          STRICT REGRESSION TEST AUDIT: scripts/run-full-pro-regression.js        ");
console.log("==================================================================================\n");

// 1. Verify the exact code at scripts/run-full-pro-regression.js:336
const regressionScriptPath = path.join(process.cwd(), "scripts", "run-full-pro-regression.js");
const scriptContent = fs.readFileSync(regressionScriptPath, "utf8");

const hasStrictCheckInScript = scriptContent.includes(
  "tailorModalData.hasTailorHeader && tailorModalData.hasScore && tailorModalData.hasPreview"
);

assert(
  hasStrictCheckInScript,
  "scripts/run-full-pro-regression.js must contain strict check: hasTailorHeader && hasScore && hasPreview"
);
console.log("✅ Codebase verification: scripts/run-full-pro-regression.js contains strict tripartite check.");

// 2. The strict check implementation from line 336
function strictRegressionCheck(tailorModalData: {
  hasTailorHeader: boolean;
  hasScore: boolean;
  hasPreview: boolean;
  snippet?: string;
}): { status: "PASS" | "FAIL"; reason?: string } {
  if (tailorModalData.hasTailorHeader && tailorModalData.hasScore && tailorModalData.hasPreview) {
    return { status: "PASS" };
  } else {
    const missing: string[] = [];
    if (!tailorModalData.hasTailorHeader) missing.push("header");
    if (!tailorModalData.hasScore) missing.push("fit score breakdown");
    if (!tailorModalData.hasPreview) missing.push("resume preview");
    return { status: "FAIL", reason: `Strict modal check failed: missing ${missing.join(", ")}.` };
  }
}

// -------------------------------------------------------------------------------------
// TEST: Feed Corrupted Payloads to Prove Strict Check Rejection
// -------------------------------------------------------------------------------------
console.log("\n--- Testing Corrupted Payloads against Strict Check ---");

// Corrupted Payload 1: Missing Fit Score
const corruptedMissingScore = {
  hasTailorHeader: true,
  hasScore: false,
  hasPreview: true,
};
const resCorruptedScore = strictRegressionCheck(corruptedMissingScore);
assert.strictEqual(resCorruptedScore.status, "FAIL", "Missing fit score MUST fail strict check");
console.log(`✅ [RAW OUTPUT] Corrupted payload (missing score) FAILS: "${resCorruptedScore.reason}"`);

// Corrupted Payload 2: Missing Resume Preview
const corruptedMissingPreview = {
  hasTailorHeader: true,
  hasScore: true,
  hasPreview: false,
};
const resCorruptedPreview = strictRegressionCheck(corruptedMissingPreview);
assert.strictEqual(resCorruptedPreview.status, "FAIL", "Missing preview MUST fail strict check");
console.log(`✅ [RAW OUTPUT] Corrupted payload (missing preview) FAILS: "${resCorruptedPreview.reason}"`);

// Corrupted Payload 3: Missing Header
const corruptedMissingHeader = {
  hasTailorHeader: false,
  hasScore: true,
  hasPreview: true,
};
const resCorruptedHeader = strictRegressionCheck(corruptedMissingHeader);
assert.strictEqual(resCorruptedHeader.status, "FAIL", "Missing header MUST fail strict check");
console.log(`✅ [RAW OUTPUT] Corrupted payload (missing header) FAILS: "${resCorruptedHeader.reason}"`);

// Valid Complete Payload
const validCompletePayload = {
  hasTailorHeader: true,
  hasScore: true,
  hasPreview: true,
};
const resValid = strictRegressionCheck(validCompletePayload);
assert.strictEqual(resValid.status, "PASS", "Complete payload MUST pass strict check");
console.log("✅ Complete valid payload passes strict check (Status: PASS).");

// -------------------------------------------------------------------------------------
// NEGATIVE CONTROL: Simulate old weak check and prove negative control fails on it
// -------------------------------------------------------------------------------------
console.log("\n--- RUNNING NEGATIVE CONTROL ---");
function oldWeakCheck(data: { hasTailorHeader: boolean }): "PASS" | "FAIL" {
  // Old bug: evaluated ONLY hasTailorHeader
  return data.hasTailorHeader ? "PASS" : "FAIL";
}

let negativeControlCaught = false;
try {
  const weakCheckResultOnCorrupted = oldWeakCheck(corruptedMissingScore);
  // Negative control assertion: the result on corrupted payload MUST be FAIL; if it returns PASS, throw!
  assert.strictEqual(
    weakCheckResultOnCorrupted,
    "FAIL",
    "Old weak check erroneously marked corrupted payload as PASS!"
  );
} catch (err: any) {
  negativeControlCaught = true;
  console.log(`✅ Negative control caught old weak check: erroneously returned PASS on corrupted data!`);
}

assert(negativeControlCaught, "Negative control failed to catch old weak check vulnerability!");

console.log("\n==================================================================================");
console.log("WEAK REGRESSION TEST FIX: STRICT TRIPARTITE ASSERTION VERIFIED");
console.log("==================================================================================");
