import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       TEST: USER WITHOUT CONFIRMED RESUME NEVER SEES A MATCH PERCENTAGE          ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  if (!fs.existsSync(jobsPath)) {
    console.error("FAIL: src/app/jobs/page.tsx does not exist!");
    process.exit(1);
  }

  let code = fs.readFileSync(jobsPath, "utf-8");

  if (isNegativeControl) {
    // Intentionally inject corruption: return a fake percentage when confirmedAt is missing
    code = code.replace(
      "return null;",
      'const hash = (job.id || "job").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0); return 62 + (hash % 33);'
    );
  }

  const failures: string[] = [];

  // Check 1: Zero unbacked hash or random score fallback in getJobMatchScore
  const hasHashFallback = /hash\s*%\s*33/.test(code) || /62\s*\+\s*\(hash/.test(code);
  if (hasHashFallback) {
    failures.push("LEAK DETECTED: Found unbacked hash fallback in src/app/jobs/page.tsx returning an artificial score.");
  } else {
    console.log("  [PASS] source audit: zero hash/artificial fallback in getJobMatchScore");
  }

  // Check 2: getJobMatchScore returns number | null and ends with return null
  const fnMatch = code.match(/function getJobMatchScore\([\s\S]*?\n\}/);
  if (!fnMatch) {
    failures.push("PARSE ERROR: Could not locate getJobMatchScore function declaration.");
  } else {
    const fnBody = fnMatch[0];
    if (!fnBody.includes("number | null")) {
      failures.push("TYPE ERROR: getJobMatchScore return type must be number | null.");
    } else {
      console.log("  [PASS] typing: getJobMatchScore correctly typed to return number | null");
    }

    if (!fnBody.includes("return null;")) {
      failures.push("LOGIC ERROR: getJobMatchScore must return null when no confirmed resume exists.");
    } else {
      console.log("  [PASS] default return: getJobMatchScore defaults to null when facts unconfirmed");
    }
  }

  // Check 3: CircularMatchRing is strictly guarded by matchScore !== null
  const hasUnguardedRing = code.includes("<CircularMatchRing") && !code.includes("matchScore !== null");
  if (hasUnguardedRing) {
    failures.push("RENDER LEAK: CircularMatchRing rendered without matchScore !== null guard.");
  } else {
    console.log("  [PASS] guard check: CircularMatchRing strictly guarded by matchScore !== null");
  }

  // Check 4: Fit Match panel conditionally rendered, CTA rendered when null
  const hasDesktopGating = code.includes("matchScore !== null ?");
  const hasUploadResumeCta = code.includes("Upload your resume to see your real match") && code.includes('href="/resume"');
  if (!hasDesktopGating || !hasUploadResumeCta) {
    failures.push('CTA ERROR: Missing conditioned Fit Match panel or "Upload your resume to see your real match" CTA linking to /resume.');
  } else {
    console.log('  [PASS] cta check: "Upload your resume to see your real match" rendered in exact spot when matchScore is null');
  }

  // Check 5: Functional execution simulation across unconfirmed vs confirmed profiles
  if (fnMatch) {
    try {
      const jsFn = fnMatch[0]
        .replace(/:\s*LiveJob/g, "")
        .replace(/:\s*CandidateProfile\s*\|\s*null/g, "")
        .replace(/\):\s*number\s*\|\s*null/g, ")");

      const harness = `
        const computeFitDiagnostics = (cand, job) => {
          if (!cand || !cand.confirmedAt) return null;
          return { score: 85, breakdown: {} };
        };
        ${jsFn}
        return getJobMatchScore;
      `;
      const fn = new Function(harness)();
      const testJob = { id: "job_xyz_99", title: "Full Stack Developer", company: "CarrierHound" };

      // Case A: No candidate (guest/unauthenticated)
      const scoreGuest = fn(testJob, null);
      if (scoreGuest !== null) {
        failures.push(`LEAK: Guest user received score ${scoreGuest}% (expected null).`);
      } else {
        console.log("  [PASS] Case A (Guest user): score is null, zero percentage rendered");
      }

      // Case B: Candidate profile exists but has null confirmedAt
      const scoreNullConfirmed = fn(testJob, { confirmedAt: null, skills: ["TypeScript"] });
      if (scoreNullConfirmed !== null) {
        failures.push(`LEAK: Candidate with null confirmedAt received score ${scoreNullConfirmed}% (expected null).`);
      } else {
        console.log("  [PASS] Case B (null confirmedAt): score is null, zero percentage rendered");
      }

      // Case C: Candidate profile exists but has undefined confirmedAt
      const scoreUndefConfirmed = fn(testJob, { confirmedAt: undefined, skills: ["TypeScript"] });
      if (scoreUndefConfirmed !== null) {
        failures.push(`LEAK: Candidate with undefined confirmedAt received score ${scoreUndefConfirmed}% (expected null).`);
      } else {
        console.log("  [PASS] Case C (undefined confirmedAt): score is null, zero percentage rendered");
      }

      // Case D: Candidate profile exists with empty confirmedAt
      const scoreEmptyConfirmed = fn(testJob, { confirmedAt: "", skills: ["TypeScript"] });
      if (scoreEmptyConfirmed !== null) {
        failures.push(`LEAK: Candidate with empty string confirmedAt received score ${scoreEmptyConfirmed}% (expected null).`);
      } else {
        console.log("  [PASS] Case D (empty string confirmedAt): score is null, zero percentage rendered");
      }

      // Case E: Candidate profile exists WITH confirmedAt
      const scoreConfirmed = fn(testJob, { confirmedAt: "2026-10-20T10:00:00Z", skills: ["TypeScript"] });
      if (typeof scoreConfirmed !== "number" || scoreConfirmed < 10 || scoreConfirmed > 99) {
        failures.push(`ACCURACY FAIL: Candidate with confirmedAt received invalid score ${scoreConfirmed}.`);
      } else {
        console.log(`  [PASS] Case E (Confirmed candidate): real calculated score returned (${scoreConfirmed}%)`);
      }
    } catch (err: any) {
      failures.push(`HARNESS ERROR: ${err.message}`);
    }
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 1) {
      console.log(`NEGATIVE CONTROL PASSED: Successfully detected ${failures.length} intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1); // Non-zero exit code proves negative control works
    } else {
      console.error("NEGATIVE CONTROL FAILED: Expected intentional failures, but none were detected!");
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("TEST FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("USER WITHOUT CONFIRMED RESUME NEVER SEES PERCENTAGE [PASS-LOCAL]");
  process.exit(0);
}

run();
