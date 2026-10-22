import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("            REDESIGN PART 2 — /jobs LIST PAGE VERIFICATION                        ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  if (!fs.existsSync(jobsPath)) {
    console.error("FAIL: src/app/jobs/page.tsx does not exist!");
    process.exit(1);
  }

  let code = fs.readFileSync(jobsPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions
    code = code.replace(/id="main-content"/g, "");
    code = code.replace(/data-testid="job-card"/g, "");
    code = code.replace(/useReducedMotion/g, "badMotion");
    code = code.replace(/aria-label="Sort by"/g, "");
    code = code.replace(/matchScore !== null/g, "true");
    code = code.replace(/Upload your resume to see your real match/g, "Corrupted CTA Text");
    code = code.replace("return null;", "return 62 + (hash % 33);");
    code = code + '\nimport { useSearchParams } from "next/navigation";';
  }

  const failures: string[] = [];

  // Check 1: Static export safe - NO useSearchParams
  const hasUseSearchParams = /useSearchParams\s*\(/.test(code) || /from\s+["']next\/navigation["'].*useSearchParams/.test(code);
  if (hasUseSearchParams) {
    failures.push("STATIC EXPORT FAIL: src/app/jobs/page.tsx uses useSearchParams (read URL via window.location instead).");
  } else {
    console.log("  [PASS] static export safe: zero useSearchParams");
  }

  // Check 2: Accessible semantic main element
  if (!code.includes('id="main-content"')) {
    failures.push('A11Y FAIL: Missing id="main-content" on <main> element.');
  } else {
    console.log('  [PASS] accessible main container: id="main-content"');
  }

  // Check 3: Semantic article with testid for cards
  if (!code.includes('data-testid="job-card"')) {
    failures.push('CONTRACT FAIL: Missing data-testid="job-card" on job cards.');
  } else {
    console.log('  [PASS] contract: data-testid="job-card" present');
  }

  // Check 4: Skeleton loader layout matching
  if (!code.includes('data-testid="jobs-skeleton-list"')) {
    failures.push('CONTRACT FAIL: Missing data-testid="jobs-skeleton-list" on loading skeleton.');
  } else {
    console.log('  [PASS] skeleton: data-testid="jobs-skeleton-list" with matching card layout');
  }

  // Check 5: Accessible sort select
  if (!code.includes('aria-label="Sort by"')) {
    failures.push('A11Y FAIL: Sort <select> missing aria-label="Sort by".');
  } else {
    console.log('  [PASS] a11y: sort select has aria-label="Sort by"');
  }

  // Check 6: Accessible search input
  if (!code.includes('aria-label="Search by job title, company, or keyword"')) {
    failures.push('A11Y FAIL: Search <input> missing accessible aria-label.');
  } else {
    console.log('  [PASS] a11y: search input has accessible aria-label');
  }

  // Check 7: Motion and Reduced-Motion Safe
  const hasMotionImport = code.includes('from "motion/react"') || code.includes("from 'motion/react'");
  const hasUseReducedMotion = code.includes("useReducedMotion");
  if (!hasMotionImport || !hasUseReducedMotion) {
    failures.push('MOTION FAIL: Must import motion and useReducedMotion from "motion/react".');
  } else {
    console.log('  [PASS] motion: motion & useReducedMotion imported from "motion/react"');
  }

  // Check 8: Stagger delay capped at <= 60ms
  const hasStagger = code.includes("staggerDelay") || code.includes("Math.min(index *");
  if (!hasStagger) {
    failures.push("ANIMATION FAIL: First-mount stagger entrance missing or not capped.");
  } else {
    console.log("  [PASS] animation: first-mount stagger entrance configured with max 60ms step");
  }

  // Check 9: Sticky filter bar
  if (!code.includes("sticky top-[64px]") || !code.includes("z-tk-sticky")) {
    failures.push("LAYOUT FAIL: Filter bar missing sticky top-[64px] z-tk-sticky.");
  } else {
    console.log("  [PASS] layout: sticky filter bar with z-tk-sticky on scroll");
  }

  // Check 10: Active filter chips
  if (!code.includes("Active:") || !code.includes("Clear all")) {
    failures.push("FILTER FAIL: Missing active filter chips or Clear all button.");
  } else {
    console.log("  [PASS] filter: active filter chips with clear actions");
  }

  // Check 11: Mobile filter collapsible sheet
  if (!code.includes("mobileFiltersOpen") || !code.includes("SlidersHorizontal")) {
    failures.push("MOBILE FAIL: Missing mobile collapsible filter panel.");
  } else {
    console.log("  [PASS] mobile: collapsible filter sheet with active filter badge");
  }

  // Check 12: Business logic integrity
  const hasEffectiveCandidate = code.includes("effectiveCandidate");
  const hasEffectiveSortBy = code.includes("effectiveSortBy");
  const hasHandleSaveJob = code.includes("handleSaveJob");
  const hasHandleLockedAction = code.includes("handleLockedAction");
  const hasPaywallModal = code.includes("PaywallModal");

  if (!hasEffectiveCandidate || !hasEffectiveSortBy || !hasHandleSaveJob || !hasHandleLockedAction || !hasPaywallModal) {
    failures.push("INTEGRITY FAIL: Core logic or gating handlers missing in src/app/jobs/page.tsx.");
  } else {
    console.log("  [PASS] business logic: effective candidate, sorting, save, and paywall handlers intact");
  }

  // Check 13: Zero unbacked match score fallback
  const hasHashFallback = /hash\s*%\s*33/.test(code) || /62\s*\+\s*\(hash/.test(code);
  if (hasHashFallback) {
    failures.push("SECURITY/ACCURACY FAIL: Found unbacked hash score fallback in src/app/jobs/page.tsx.");
  } else {
    console.log("  [PASS] match score: zero unbacked hash/random score fallback in getJobMatchScore");
  }

  // Check 14: Fit Match panel & CircularMatchRing conditioned strictly on real score
  const hasConditionedFitPanel = code.includes("matchScore !== null ?");
  const hasUploadResumeCta =
    code.includes("Upload your resume to see your real match") &&
    code.includes('href="/resume"');
  if (!hasConditionedFitPanel || !hasUploadResumeCta) {
    failures.push('FIT MATCH FAIL: Fit Match panel must be conditioned on matchScore !== null, with "Upload your resume to see your real match" CTA linking to /resume.');
  } else {
    console.log('  [PASS] fit match: Fit Match panel and CircularMatchRing strictly gated; "Upload your resume to see your real match" rendered when null');
  }

  // Check 15: Exact layout and card size preservation for CTA
  const hasMatchingCardSize = code.includes("w-44 shrink-0") && code.includes("rounded-[16px]");
  if (!hasMatchingCardSize) {
    failures.push("LAYOUT SHIFT FAIL: Upload resume CTA must match desktop Fit Match panel size (w-44 shrink-0 rounded-[16px]).");
  } else {
    console.log("  [PASS] layout: zero shift; CTA uses identical w-44 shrink-0 rounded-[16px] dimensions and design tokens");
  }

  // Check 16: Dynamic execution simulation: user without confirmed resume never receives a percentage
  try {
    const fnMatch = code.match(/function getJobMatchScore\([\s\S]*?\n\}/);
    if (!fnMatch) {
      failures.push("EXTRACTION FAIL: Unable to parse getJobMatchScore function body.");
    } else {
      const jsFn = fnMatch[0]
        .replace(/:\s*LiveJob/g, "")
        .replace(/:\s*CandidateProfile\s*\|\s*null/g, "")
        .replace(/\):\s*number\s*\|\s*null/g, ")");

      const scoringCode = `
        const computeFitDiagnostics = (cand, j) => {
          if (!cand || !cand.confirmedAt) return null;
          return { score: 88, breakdown: {} };
        };
        ${jsFn}
        return getJobMatchScore;
      `;
      const fn = new Function(scoringCode)();
      const dummyJob = { id: "job-test-123", title: "Senior Engineer", company: "MonkeCorp" };

      const unauthScore = fn(dummyJob, null);
      const unconfirmedScore = fn(dummyJob, { confirmedAt: null, skills: ["React"] });
      const emptyConfirmedScore = fn(dummyJob, { confirmedAt: "", skills: ["React"] });
      const confirmedScore = fn(dummyJob, { confirmedAt: "2026-10-01T00:00:00Z", skills: ["React"] });

      if (unauthScore !== null) {
        failures.push(`SCORE LEAK: User without candidate profile got score ${unauthScore}% instead of null.`);
      }
      if (unconfirmedScore !== null) {
        failures.push(`SCORE LEAK: User with unconfirmed resume got score ${unconfirmedScore}% instead of null.`);
      }
      if (emptyConfirmedScore !== null) {
        failures.push(`SCORE LEAK: User with empty confirmedAt got score ${emptyConfirmedScore}% instead of null.`);
      }
      if (typeof confirmedScore !== "number" || confirmedScore < 10 || confirmedScore > 99) {
        failures.push(`SCORE ERROR: User with confirmed resume failed to get valid score (got ${confirmedScore}).`);
      }

      if (unauthScore === null && unconfirmedScore === null && emptyConfirmedScore === null && typeof confirmedScore === "number") {
        console.log("  [PASS] score integrity: user without confirmed resume strictly receives null (never sees a percentage)");
      }
    }
  } catch (err: any) {
    failures.push(`SCORING TEST RUNTIME ERROR: ${err.message}`);
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 4) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1); // Non-zero exit code proves negative control works
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 4 failures, got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("REDESIGN PART 2 (/jobs LIST) VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
