import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// Mobile overview restyle: below md the header reads action row -> pills -> title -> meta line -> icon fact
// list (one row per fact) -> match score cards. Salary is always listed and visible to every viewer. md+ keeps
// the overview chips and metadata grid unchanged.
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const facts = detail.slice(detail.indexOf('data-testid="mobile-job-facts"'), detail.indexOf('data-testid="overview-chips"'));

describe("mobile detail density", () => {
  it("the fact list is mobile-only, one icon row per fact, with salary always shown", () => {
    expect(detail).toContain('<ul data-testid="mobile-job-facts" aria-label="Job details" className="md:hidden');
    for (const fact of ["job.location", "Location locked", "detailWorkModel", "{formatJobType(job.type)}", "{jobLevel}", "{expText}", "job.salary", "Not disclosed"]) {
      expect(facts).toContain(fact);
    }
    expect(detail).toContain("const detailWorkModel = workModelDetailLabel(job)");
    expect(detail).toContain("!canSeeLocation || !isDuplicateWorkModelLocation(job.location, detailWorkModel)");
    // salary row always listed, "Not disclosed" when empty
    // defensive: a salary value only renders for unlocked viewers (server already strips it for locked ones)
    expect(facts).toContain("isUnlocked ? job.salary");
    expect(detail).toContain('data-testid="mobile-job-salary"');
  });

  it("the desktop presentations stay hidden below md and unchanged", () => {
    expect(detail).toContain('data-testid="overview-chips" className="max-md:hidden lg:hidden flex');
    expect(detail).toContain('className="max-md:hidden grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-8 gap-y-2 pt-1');
    expect(detail).toContain('<div className="max-md:hidden flex items-center gap-3">'); // desktop logo/company row
    expect(detail).toContain('className="text-[28px] md:text-[22px] font-bold');
  });

  it("the mobile header reads action row, pills, title, meta line, fact list", () => {
    const actionRow = detail.indexOf("w-16 h-16 rounded-2xl");
    const pills = detail.indexOf("{/* Mobile pills: posted time + category (real data only) */}");
    const h1 = detail.indexOf('className="text-[28px] md:text-[22px] font-bold');
    const meta = detail.indexOf("{/* Mobile meta line");
    expect(actionRow).toBeGreaterThan(-1);
    expect(actionRow).toBeLessThan(pills);
    expect(pills).toBeLessThan(h1);
    expect(h1).toBeLessThan(meta);
    expect(meta).toBeLessThan(detail.indexOf('data-testid="mobile-job-facts"'));
  });

  it("the match score cards follow the facts, before the description", () => {
    expect(detail.indexOf('data-testid="mobile-job-facts"')).toBeLessThan(detail.indexOf('testId="mobile-match-score"'));
    expect(detail.indexOf('testId="mobile-match-score"')).toBeLessThan(detail.indexOf("(3) CONTENT ORDER"));
  });
});
