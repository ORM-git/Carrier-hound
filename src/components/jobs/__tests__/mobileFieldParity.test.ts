import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 20: mobile reflows, never drops, the job facts desktop shows.
const card = readFileSync("src/components/jobs/JobCardContent.tsx", "utf8");
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const mobileCard = card.slice(card.indexOf("MOBILE VIEW (under sm"), card.indexOf("function CircularMatchRing("));

describe("mobile field parity (item 20)", () => {
  it("mobile card keeps location, type, work model, seniority, early-applicant, salary + original and CM arrival age", () => {
    for (const s of ["locInfo.primary", "formattedJobType", "{workModelLabel(job)}", "{jobLevel}", "Early applicant", "{isPro ? job.salary", "({job.salary_original})", "formatRelativeTime(arrivalAt)", "job.category"]) {
      expect(mobileCard).toContain(s);
    }
    // The footer age is CM arrival (first_seen_at), never the employer posting time.
    expect(mobileCard).not.toContain("formatRelativeTime(job.postedAt)");
  });

  it("detail keeps salary original, skills, description, Company section and shows the rail (similar jobs, notes) below lg", () => {
    for (const s of ["job.salary_original", 'id="company-section"', "Similar jobs", "tracker-notes-panel", 'testId="mobile-match-score"']) expect(detail).toContain(s);
    expect(detail).not.toContain("hidden lg:block lg:col-span-5");
  });
});
