import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 19: the mobile card score is a 52px CM-blue ring (J01 weight) from the same matchScore; no invented score.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");

describe("mobile card score weight (item 19)", () => {
  it("renders the real matchScore in a 52px light ring with an accessible label", () => {
    const block = page.slice(page.indexOf('data-testid="mobile-card-score"') - 200, page.indexOf('data-testid="mobile-card-score"') + 700);
    expect(block).toContain("matchScore !== null ? (");
    expect(block).toContain("aria-label={`Fit Match: ${matchScore}%`}");
    expect(block).toContain("<CircularMatchRing score={matchScore} size={52} strokeWidth={5} light />");
    expect(page).not.toContain("w-[54px] h-[30px]");
  });

  it("light ring uses CM blue, dark ring unchanged for desktop; no-score cards keep the +Score resume link", () => {
    expect(page).toContain('stroke={light ? "#2563EB" : "#2DD4BF"}');
    expect(page).toContain('stroke={light ? "#DBEAFE" : "#1E293B"}');
    expect(page).toContain("+Score");
  });
});
