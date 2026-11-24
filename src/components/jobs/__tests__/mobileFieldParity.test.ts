import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 20: mobile reflows, never drops, the job facts desktop shows.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const mobileCard = page.slice(page.indexOf("MOBILE VIEW (under sm"), page.indexOf("{/* Load More"));

describe("mobile field parity (item 20)", () => {
  it("mobile card keeps location, type, work model, seniority, early-applicant, compact salary only, date and source", () => {
    for (const s of ["locInfo.primary", "formattedJobType", "{workModelLabel(job)}", "{jobLevel}", "Early applicant", "{compactSalaryDisplay(job.salary)", "formatRelativeTime(job.postedAt)", '"Direct feed" : "Active feed"', "job.category"]) {
      expect(mobileCard).toContain(s);
    }
  });

  it("detail keeps compact salary, skills, description, Company section and shows the rail (similar jobs, notes) below lg", () => {
    for (const s of ["compactSalaryDisplay(job.salary)", 'id="company-section"', "Similar jobs", "tracker-notes-panel", 'data-testid="mobile-match-score"']) expect(detail).toContain(s);
    expect(detail).not.toContain("hidden lg:block lg:col-span-5");
    expect(detail).not.toContain("job.salary_original");
    expect(page).not.toContain("job.salary_original");
  });
});
