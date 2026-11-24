import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 17 (density): below md each job fact appears once, as one compact chip row, so the score and
// description sit high on screen. md+ keeps the overview chips and metadata grid unchanged.
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const facts = detail.slice(detail.indexOf('data-testid="mobile-job-facts"'), detail.indexOf('data-testid="overview-chips"'));

describe("mobile detail density (item 17)", () => {
  it("the compact fact row is mobile-only and carries every fact once", () => {
    expect(detail).toContain('<ul data-testid="mobile-job-facts" aria-label="Job details" className="md:hidden');
    for (const fact of ["job.location", "Location locked", "workModelLabel(job)", "job.remoteScope", "{job.type}", "{jobLevel}", "{job.category}", "compactSalaryDisplay(job.salary)", "{expText}", "formatRelativeTime(job.postedAt || job.date)"]) {
      expect(facts).toContain(fact);
    }
  });

  it("the duplicated presentations are hidden only below md", () => {
    expect(detail).toContain('data-testid="overview-chips" className="max-md:hidden flex');
    expect(detail).toContain('className="max-md:hidden grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t');
    expect(detail).toContain('<div className="max-md:hidden flex items-center gap-3">'); // logo/company row: shown in the sticky strip on mobile
    expect(detail).toContain('className="text-[20px] md:text-[24px] font-bold');
  });

  it("the compact score follows the facts, before the description", () => {
    expect(detail.indexOf('data-testid="mobile-job-facts"')).toBeLessThan(detail.indexOf('data-testid="mobile-match-score"'));
    expect(detail.indexOf('data-testid="mobile-match-score"')).toBeLessThan(detail.indexOf("(3) CONTENT ORDER"));
  });
});
