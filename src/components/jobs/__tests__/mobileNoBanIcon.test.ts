import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 13: no standalone circle-slash (Ban) button on mobile cards or the mobile detail sticky
// strip; hiding there stays available as the labeled "Remove From List" menu action. The mobile overview
// action row (in the header body, not the sticky strip) intentionally carries the block-icon Hide circle.
const card = readFileSync("src/components/jobs/JobCardContent.tsx", "utf8");
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const menu = readFileSync("src/components/jobs/JobCardMenu.tsx", "utf8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf(end, i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j);
};

describe("mobile hide control (item 13)", () => {
  it("mobile card footer actions have no standalone ban button", () => {
    const footer = between(card, "Footer divider, posted time on left", "function CircularMatchRing(");
    expect(footer).not.toContain("<Ban");
    expect(footer).not.toContain('aria-label="Hide position"');
  });

  it("mobile detail strip uses the labeled card menu instead of a ban button", () => {
    const strip = between(detail, 'data-testid="mobile-sticky-header-strip"', "MATCH INSIGHTS & TRACKER PANEL");
    expect(strip).not.toContain("<Ban");
    expect(strip).toContain("<JobCardMenu");
    expect(strip).toContain("onRemoveFromList={() => onHide()}");
    expect(strip).toContain('className="-my-1"'); // 44px target without growing the sticky strip
  });

  it("the overview action row intentionally carries the block-icon Hide circle", () => {
    const actionRow = between(detail, "w-16 h-16 rounded-2xl", "{/* Mobile pills:");
    expect(actionRow).toContain("<Ban");
    expect(actionRow).toContain('aria-label="Hide position"');
    expect(actionRow).toContain("onHide");
  });

  it("the menu keeps the labeled hide action and desktop keeps its hide button", () => {
    expect(menu).toContain("Remove From List");
    expect(detail).toContain('aria-label="Hide position"'); // desktop header (hidden md:flex)
  });
});
