import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 17: mobile detail reads tabs -> logo/actions -> title/metadata -> compact score -> description,
// with Match Insights (expansive explanations, collapsed disclosure) after the job content; Company anchor clears the sticky header.
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const panel = readFileSync("src/components/jobs/JobAiToolsPanel.tsx", "utf8");

describe("mobile detail order (item 17)", () => {
  it("root is a flex column; on mobile the content grid comes before Match Insights; desktop order untouched", () => {
    expect(detail).toContain('className="max-w-[880px] w-full mx-auto lg:mx-0 lg:min-w-0 lg:flex-1 flex flex-col gap-4 sm:gap-3');
    expect(detail).toMatch(/<JobAiToolsPanel\s+className="max-md:order-2( lg:hidden)?"/);
    expect(detail).toContain('grid grid-cols-1 lg:grid-cols-12 gap-5 items-start max-md:order-1');
    // the header card (title/metadata/compact score) keeps the default order, so it precedes both
    expect(detail.indexOf("(2) HEADER BODY CARD")).toBeLessThan(detail.indexOf("(3) CONTENT ORDER"));
    expect(panel).toContain('aria-expanded={isMobileExpanded}'); // explanations stay behind the disclosure
  });

  it("score row keeps the overall and all three component scores with readable, honest labels", () => {
    const score = detail.slice(detail.indexOf('testId="mobile-match-score"'), detail.indexOf("(3) CONTENT ORDER"));
    for (const label of ["Experience Level", "Skill", "Role Match", "matchLabel", "expSubScore", "skillSubScore", "roleSubScore"]) expect(score).toContain(label);
    expect(detail).not.toMatch(/Industry/); // no industry dimension exists in FitDiagnosticsResult
    const tiles = detail.slice(detail.indexOf("function MatchScoreTiles"), detail.indexOf("function MatchScorePrompt"));
    expect(score + tiles).not.toMatch(/text-\[(9|10)px\]/);
  });

  it("Company anchor clears the sticky header; Overview returns to the top", () => {
    expect(detail).toContain('id="company-section"\n            className="scroll-mt-44 md:scroll-mt-36');
    expect(detail.match(/window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
