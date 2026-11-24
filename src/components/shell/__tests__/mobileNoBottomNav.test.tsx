// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AppIconRail, { NAV_ITEMS } from "../AppIconRail";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs", useRouter: () => ({ push: vi.fn() }) }));
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
}));

// Owner request: remove the mobile bottom navigation bar entirely. Navigation on
// mobile lives in the top-left hamburger drawer; nothing renders at the bottom.
describe("mobile bottom nav removed", () => {
  afterEach(() => cleanup());

  it("renders no bottom nav element", () => {
    render(<AppIconRail />);
    expect(screen.queryByTestId("app-mobile-nav")).toBeNull();
  });

  it("the rail source keeps no bottom-nav markup or cookie-height hook for it", () => {
    const rail = readFileSync("src/components/shell/AppIconRail.tsx", "utf8");
    expect(rail).not.toContain("app-mobile-nav");
    expect(rail).not.toContain("useCookieNoticeHeight");
  });

  it("pages keep no below-md clearance tokens for the removed 64px nav (tablet/desktop keep main's spacing)", () => {
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    expect(detail).not.toContain("pb-[calc(var(--cookie-h)+5rem)]");
    expect(detail).toContain("md:pb-[calc(var(--cookie-h)+7rem)]");
    const tracker = readFileSync("src/app/tracker/page.tsx", "utf8");
    expect(tracker).toContain("pb-8 md:pb-24 lg:pb-12");
    expect(tracker).not.toMatch(/(?<!:)pb-24/);
    const jobs = readFileSync("src/app/jobs/page.tsx", "utf8");
    expect(jobs).toContain("space-y-3 pb-4 md:pb-32 lg:pb-12");
    expect(jobs).not.toContain("sm:pb-32");
    const backToTop = readFileSync("src/components/BackToTop.tsx", "utf8");
    expect(backToTop).toContain("bottom-[24px]");
    expect(backToTop).not.toContain("bottom-[84px]");
  });

  it("the hamburger drawer keeps all six destinations", () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual(["jobs", "resume", "tracker", "profile", "radar", "pricing"]);
    const topBar = readFileSync("src/components/shell/AppTopBar.tsx", "utf8");
    expect(topBar).toContain('id="mobile-nav-drawer"');
    expect(topBar).toContain("NAV_ITEMS.map");
  });

  it("/jobs emits no detail-open signal (it only existed for the bottom nav)", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    expect(page).not.toContain("careermonke_detail_open");
  });
});
