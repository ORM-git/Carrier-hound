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
    expect(detail).toContain("pb-[calc(var(--cookie-h)+5rem)] md:pb-[calc(var(--cookie-h)+7rem)]");
    expect(detail).not.toContain("paddingBottom: `calc(${cookieNoticeHeight}px + 7rem)`");
  });

  it("keeps Share (44px) and Apply in the sticky header strip and the desktop share button", () => {
    const strip = detail.slice(detail.indexOf('data-testid="mobile-sticky-header-strip"'), detail.indexOf("MATCH INSIGHTS & TRACKER PANEL"));
    expect(strip).toMatch(/data-testid="mobile-header-share-button"[\s\S]*?className="w-11 h-11/);
    expect(strip).toContain("Apply");
    expect(detail).toContain('data-testid="share-job-button"');
  });
});
