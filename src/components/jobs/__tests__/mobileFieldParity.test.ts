import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 20: mobile reflows, never drops, the job facts desktop shows.
const card = readFileSync("src/components/jobs/JobCardContent.tsx", "utf8");
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const mobileCard = card.slice(card.indexOf("MOBILE VIEW (under sm"), card.indexOf("function CircularMatchRing("));

function expectCanonicalMobileMode(source: string) {
  const mobile = source.slice(source.indexOf("MOBILE VIEW (under sm"), source.indexOf("function CircularMatchRing("));
  expect(source).toContain("const mode = workModelLabel(job);");
  expect(mobile).toMatch(/<Laptop[^>]*\/>\s*\{mode\}/);
  expect(mobile).not.toContain('{job.remote ? "Remote" : "On-site"}');
}

describe("mobile field parity (item 20)", () => {
  it("mobile card keeps location, type, work model, seniority, early-applicant, salary + original and CM arrival age", () => {
    expectCanonicalMobileMode(card);
    for (const s of ["locInfo.primary", "formattedJobType", "{jobLevel}", "Early applicant", "{isPro ? job.salary", "({job.salary_original})", "formatRelativeTime(arrivalAt)", "job.category"]) {
      expect(mobileCard).toContain(s);
    }
    // The footer age is CM arrival (first_seen_at), never the employer posting time.
    expect(mobileCard).not.toContain("formatRelativeTime(job.postedAt)");
  });

  it("rejects removal or replacement of the canonical mobile work-mode chip", () => {
    const mobileStart = card.indexOf("MOBILE VIEW (under sm");
    const before = card.slice(0, mobileStart), mobile = card.slice(mobileStart);
    const missing = mobile.replace("{mode}", "");
    const wrong = mobile.replace("{mode}", '{job.remote ? "Remote" : "On-site"}');
    expect(missing).not.toBe(mobile);
    expect(wrong).not.toBe(mobile);
    expect(() => expectCanonicalMobileMode(before + missing)).toThrow();
    expect(() => expectCanonicalMobileMode(before + wrong)).toThrow();
    const rebound = card.replace("const mode = workModelLabel(job);", 'const mode = "On-site";');
    expect(rebound).not.toBe(card);
    expect(() => expectCanonicalMobileMode(rebound)).toThrow();
  });

  it("detail keeps salary original, skills, description, Company section and shows the rail (similar jobs, notes) below lg", () => {
    for (const s of ["job.salary_original", 'id="company-section"', "Similar jobs", "tracker-notes-panel", 'testId="mobile-match-score"']) expect(detail).toContain(s);
    expect(detail).not.toContain("hidden lg:block lg:col-span-5");
  });
});
