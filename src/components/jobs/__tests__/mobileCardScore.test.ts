import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 19: the mobile card score is a 56px CM-blue ring (J01 weight) from the same matchScore; no invented score.
const page = readFileSync("src/app/jobs/page.tsx", "utf8");
const card = readFileSync("src/components/jobs/JobCardContent.tsx", "utf8");
const ring = card.slice(card.indexOf("function CircularMatchRing("));

describe("mobile card score weight (item 19)", () => {
  it("Jobs page adopts the shared renderer with the computed real score and entitlement", () => {
    expect(page).toContain('import JobCardContent from "@/components/jobs/JobCardContent"');
    const adoption = page.match(/<JobCardContent\b[\s\S]*?\/>/)?.[0];
    expect(adoption).toBeDefined();
    for (const prop of ["job", "isPro", "matchScore", "cardZeroSkills"]) expect(adoption).toContain(`${prop}={${prop}}`);
    for (const previewOnly of ["scoreDescription=", "footerActions=", "footerText="]) expect(adoption).not.toContain(previewOnly);
    expect(card).toContain('export default function JobCardContent(');
    expect(card).toContain('<CircularMatchRing');
  });

  it("renders the real matchScore in a 56px light ring with an accessible label", () => {
    const block = card.slice(card.indexOf('data-testid="mobile-card-score"') - 200, card.indexOf('data-testid="mobile-card-score"') + 700);
    expect(block).toContain("matchScore !== null ? (");
    expect(block).toContain("aria-label={scoreDescription || `Fit Match: ${matchScore}%`}");
    expect(block).toContain("<CircularMatchRing score={matchScore} size={56} strokeWidth={1.75} light />");
    expect(card).not.toContain("w-[54px] h-[30px]");
  });

  it("both feed rings use a blue gradient and small percent sign; no-score cards keep the resume link", () => {
    expect(ring).toContain('stroke={`url(#${gradientId})`}');
    expect(ring).toContain('stopColor="#EFF6FF"');
    expect(ring).toContain('stopColor="#2563EB"');
    expect(ring).toContain('text-[0.6em]');
    expect(ring).toContain('const offset = 100 - displayScore;');
    expect(ring).toContain('pathLength={100}');
    expect(ring).toContain('d={outline}');
    expect(ring).toContain('58 / 104');
    expect(ring).not.toContain('<ellipse');
    expect(ring).toContain('stroke={light ? "#F4F4F5" : "#1E293B"}');
    expect(card).toContain("+Score");
  });
});
