import { isEarlyApplicant, getJobAgeInHours } from "../src/lib/jobs/service";
import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("================================================================================");
  console.log("            EARLY APPLICANT BADGE CONDITION VERIFICATION SUITE                  ");
  console.log("================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  const now = Date.now();
  const hoursAgoIso = (h: number) => new Date(now - h * 3600 * 1000).toISOString();

  // If in negative control mode, corrupt the test assertions to verify negative control failure
  const threshold6h = isNegativeControl ? 48 : 6;
  const threshold24h = isNegativeControl ? 1 : 24;

  // -----------------------------------------------------------------------------------------
  // TEST GROUP 1: NO APPLICANT COUNT DATA (Scraped ATS feeds, direct employer pages)
  // Rule: Show badge ONLY when post is strictly under 6 hours old
  // -----------------------------------------------------------------------------------------
  console.log("Test Group 1: No applicant-count data exists (show strictly for posts < 6 hours old)...");

  const job1hNoCount = { id: "j1", postedAt: hoursAgoIso(1) };
  const job3hNoCount = { id: "j2", postedAt: hoursAgoIso(3) };
  const job5hNoCount = { id: "j3", postedAt: hoursAgoIso(5) };
  const job6hNoCount = { id: "j4", postedAt: hoursAgoIso(6.1) };
  const job8hNoCount = { id: "j5", postedAt: hoursAgoIso(8) };
  const job18hNoCount = { id: "j6", postedAt: hoursAgoIso(18) };
  const job2dNoCount = { id: "j7", postedAt: hoursAgoIso(48) };

  if (isEarlyApplicant(job1hNoCount) !== (1 < threshold6h)) {
    failures.push("FAIL: Job posted 1h ago with no applicant count should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job3hNoCount) !== (3 < threshold6h)) {
    failures.push("FAIL: Job posted 3h ago with no applicant count should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job5hNoCount) !== (5 < threshold6h)) {
    failures.push("FAIL: Job posted 5h ago with no applicant count should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job6hNoCount) !== false) {
    failures.push("FAIL: Job posted 6.1h ago with no applicant count MUST NOT qualify as Early applicant.");
  }
  if (isEarlyApplicant(job8hNoCount) !== false) {
    failures.push("FAIL: Job posted 8h ago with no applicant count MUST NOT qualify as Early applicant.");
  }
  if (isEarlyApplicant(job18hNoCount) !== false) {
    failures.push("FAIL: Job posted 18h ago with no applicant count MUST NOT qualify as Early applicant.");
  }
  if (isEarlyApplicant(job2dNoCount) !== false) {
    failures.push("FAIL: Job posted 48h ago with no applicant count MUST NOT qualify as Early applicant.");
  }

  // -----------------------------------------------------------------------------------------
  // TEST GROUP 2: WITH APPLICANT COUNT DATA — LOW COUNT (<= 25)
  // Rule: Show badge when posted within the last 24 hours AND applicant count is genuinely low
  // -----------------------------------------------------------------------------------------
  console.log("Test Group 2: Applicant count data exists and is LOW (<= 25, posted within 24 hours)...");

  const job2hLowCount = { id: "j8", postedAt: hoursAgoIso(2), applicantCount: 5 };
  const job12hLowCount = { id: "j9", postedAt: hoursAgoIso(12), applicantCount: 15 };
  const job22hLowCount = { id: "j10", postedAt: hoursAgoIso(22), applicantCount: 25 };
  const job28hLowCount = { id: "j11", postedAt: hoursAgoIso(28), applicantCount: 5 }; // Low count, but > 24 hours

  if (isEarlyApplicant(job2hLowCount) !== (2 < threshold24h)) {
    failures.push("FAIL: Job posted 2h ago with 5 applicants should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job12hLowCount) !== (12 < threshold24h)) {
    failures.push("FAIL: Job posted 12h ago with 15 applicants should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job22hLowCount) !== (22 < threshold24h)) {
    failures.push("FAIL: Job posted 22h ago with 25 applicants should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job28hLowCount) !== false) {
    failures.push("FAIL: Job posted 28h ago (>24h) with 5 applicants MUST NOT qualify as Early applicant.");
  }

  // -----------------------------------------------------------------------------------------
  // TEST GROUP 3: WITH APPLICANT COUNT DATA — HIGH COUNT (> 25)
  // Rule: Do NOT show badge even if under 24 hours
  // -----------------------------------------------------------------------------------------
  console.log("Test Group 3: Applicant count data exists and is HIGH (> 25)...");

  const job2hHighCount = { id: "j12", postedAt: hoursAgoIso(2), applicantCount: 80 };
  const job10hHighCount = { id: "j13", postedAt: hoursAgoIso(10), applicantCount: 120 };

  if (isEarlyApplicant(job2hHighCount) !== false) {
    failures.push("FAIL: Job posted 2h ago with 80 applicants MUST NOT qualify as Early applicant.");
  }
  if (isEarlyApplicant(job10hHighCount) !== false) {
    failures.push("FAIL: Job posted 10h ago with 120 applicants MUST NOT qualify as Early applicant.");
  }

  // -----------------------------------------------------------------------------------------
  // TEST GROUP 4: RELATIVE STRINGS & INVALID INPUTS
  // -----------------------------------------------------------------------------------------
  console.log("Test Group 4: Relative time strings and edge cases...");

  const jobJustNow = { id: "j14", postedAt: "Just now" };
  const job2hString = { id: "j15", postedAt: "2 hours ago" };
  const job10hString = { id: "j16", postedAt: "10 hours ago" };
  const jobInvalidDate = { id: "j17", postedAt: "not-a-valid-date" };
  const jobMissingDate = { id: "j18" };

  if (isEarlyApplicant(jobJustNow) !== (0.1 < threshold6h)) {
    failures.push("FAIL: 'Just now' job should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job2hString) !== (2 < threshold6h)) {
    failures.push("FAIL: '2 hours ago' job should qualify as Early applicant.");
  }
  if (isEarlyApplicant(job10hString) !== false) {
    failures.push("FAIL: '10 hours ago' job without applicant count MUST NOT qualify.");
  }
  if (isEarlyApplicant(jobInvalidDate) !== false) {
    failures.push("FAIL: Invalid date string MUST NOT qualify.");
  }
  if (isEarlyApplicant(jobMissingDate) !== false) {
    failures.push("FAIL: Missing postedAt MUST NOT qualify.");
  }

  // -----------------------------------------------------------------------------------------
  // TEST GROUP 5: VERIFY INTEGRATION IN src/app/jobs/page.tsx
  // -----------------------------------------------------------------------------------------
  console.log("Test Group 5: Verifying integration in src/app/jobs/page.tsx...");

  const pagePath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  if (!fs.existsSync(pagePath)) {
    failures.push("FAIL: src/app/jobs/page.tsx not found!");
  } else {
    const pageCode = fs.readFileSync(pagePath, "utf-8");
    if (!pageCode.includes("isEarlyApplicant(job)")) {
      failures.push("FAIL: src/app/jobs/page.tsx must invoke isEarlyApplicant(job) for isRecent badge determination.");
    }
    if (!pageCode.includes("Early applicant")) {
      failures.push("FAIL: Badge text 'Early applicant' must remain in src/app/jobs/page.tsx.");
    }
  }

  // -----------------------------------------------------------------------------------------
  // RESULTS EVALUATION & NEGATIVE CONTROL ENFORCEMENT
  // -----------------------------------------------------------------------------------------
  console.log("\n--------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 2) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 2 failures, but only got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("ALL EARLY APPLICANT BADGE TESTS PASSED [PASS-LOCAL]");
  process.exit(0);
}

run();
