import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 19: the mobile card score is a 56px CM-blue ring (J01 weight) from the same matchScore; no invented score.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");

describe("mobile card score weight (item 19)", () => {
  it("renders the real matchScore in a 56px light ring with an accessible label", () => {
    const block = page.slice(page.indexOf('data-testid="mobile-card-score"') - 200, page.indexOf('data-testid="mobile-card-score"') + 700);
    expect(block).toContain("matchScore !== null ? (");
    expect(block).toContain("aria-label={`Fit Match: ${matchScore}%`}");
    expect(block).toContain("<CircularMatchRing score={matchScore} size={56} strokeWidth={1.75} light />");
    expect(page).not.toContain("w-[54px] h-[30px]");
  });

  it("both feed rings use a blue gradient and small percent sign; no-score cards keep the resume link", () => {
    expect(page).toContain('stroke={`url(#${gradientId})`}');
    expect(page).toContain('stopColor="#EFF6FF"');
    expect(page).toContain('stopColor="#2563EB"');
    expect(page).toContain('text-[0.6em]');
    expect(page).toContain('const offset = 100 - displayScore;');
    expect(page).toContain('pathLength={100}');
    expect(page).toContain('d={outline}');
    expect(page).toContain('58 / 104');
    expect(page).not.toContain('<ellipse');
    expect(page).toContain('stroke={light ? "#F4F4F5" : "#1E293B"}');
    expect(page).toContain("+Score");
  });
});
