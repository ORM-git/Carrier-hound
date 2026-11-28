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
    expect(block).toContain("<CircularMatchRing score={matchScore} size={56} strokeWidth={2.4} light />");
    expect(card).not.toContain("w-[54px] h-[30px]");
  });

  it("the capsule is a solid CM-blue arc on a pale track with a bold percent; no-score cards keep the resume link", () => {
    // The gradient exists only in the opt-in desktop circle; the capsule branch is a flat colour.
    expect(ring.split('linearGradient id').length - 1).toBe(1);
    expect(ring).toContain('{gradient && (');
    expect(ring).toContain('light ? "#2563EB" : "#2DD4BF"');
    expect(ring).toContain('stroke={light ? "#E2E8F0" : "#1E293B"}');
    expect(ring).toContain('text-[0.62em]');
    expect(ring).toContain('font-extrabold');
    expect(ring).toContain('const offset = 100 - displayScore;');
    expect(ring).toContain('pathLength={100}');
    expect(ring).toContain('d={outline}');
    expect(ring).toContain('58 / 104');
    expect(ring).not.toContain('<ellipse');
    // The arc starts where the bottom edge meets the right end and runs clockwise (reference).
    expect(ring).toContain('M ${right} ${height - inset} H ${left}');
    expect(ring).toContain('displayScore > 0 &&');
    expect(card).toContain("+Score");
  });

  it("Early applicant tags carry the blue glow on desktop and mobile", () => {
    const glow = "shadow-[0_0_0_1px_rgba(37,99,235,0.18),0_1px_9px_rgba(37,99,235,0.42)]";
    expect(card.split(glow).length - 1).toBe(2);
  });

  it("desktop (laptop-only) match panel: full circle with a real-score CM-blue gradient arc; mobile capsule untouched", () => {
    const panel = card.slice(card.indexOf("Desktop Match Panel"), card.indexOf("PREVIEW SCORE"));
    expect(panel).toContain("<CircularMatchRing");
    expect(panel).toContain('shape="circle"');
    expect(panel).toContain("gradient");
    expect(panel).toContain("score={matchScore}");
    expect(panel).not.toContain("emerald");
    expect(panel).not.toContain("hidden md:block");
    expect(card).toContain("<CircularMatchRing score={matchScore} size={56} strokeWidth={2.4} light />");
  });
});
