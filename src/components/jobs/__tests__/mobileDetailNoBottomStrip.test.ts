import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

// CM mobile item 16: the fixed bottom Share/Apply strip duplicated the sticky header strip; it and its spacer are gone.
const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
const page = readFileSync("src/app/jobs/page.tsx", "utf8");

describe("mobile detail without duplicate bottom strip (item 16)", () => {
  it("has no fixed bottom strip and no detail-only pb-44 spacer", () => {
    expect(detail).not.toContain("md:hidden fixed inset-x-0 bottom-0");
    expect(detail).not.toContain('data-testid="mobile-share-job-button"');
    expect(page).not.toContain('"pb-44"');
    // The detail root's 7rem strip clearance stays on desktop only.
    expect(detail).toContain("pb-[calc(var(--cookie-h)+1.5rem)] md:pb-[calc(var(--cookie-h)+7rem)]");
    expect(detail).not.toContain("paddingBottom: `calc(${cookieNoticeHeight}px + 7rem)`");
  });

  it("keeps Share and Apply reachable: Share lives in the strip menu, Apply in the overview action row", () => {
    const strip = detail.slice(detail.indexOf('data-testid="mobile-sticky-header-strip"'), detail.indexOf("MATCH INSIGHTS & TRACKER PANEL"));
    expect(strip).toContain("<JobCardMenu"); // Share/Report/Hide/Applied live in the \"...\" menu
    expect(strip).toContain('data-testid="mobile-header-share-button"'); // fallback when no menu renders
    const actionRow = detail.slice(detail.indexOf("w-16 h-16 rounded-2xl"), detail.indexOf("{/* Mobile pills:"));
    expect(actionRow).toContain("Apply");
    expect(detail).toContain('data-testid="share-job-button"');
  });
});
