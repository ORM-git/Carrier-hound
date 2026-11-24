// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AppIconRail from "../AppIconRail";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs", useRouter: () => ({ push: vi.fn() }) }));
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
}));

// Owner request (2026-11-24): the mobile bottom navigation bar (Jobs/Resume/Tracker/Profile/Radar/Pricing)
// is removed entirely - nothing sits at the bottom. The six destinations stay reachable from the top-left
// hamburger drawer in AppTopBar.
describe("mobile bottom nav removed", () => {
  afterEach(() => cleanup());

  it("the rail renders no fixed bottom navigation", () => {
    render(<AppIconRail />);
    expect(screen.queryByTestId("app-mobile-nav")).toBeNull();
    expect(screen.queryByLabelText("Mobile Navigation")).toBeNull();
  });

  it("no source keeps the bottom bar or its 64px clearances", () => {
    const rail = readFileSync("src/components/shell/AppIconRail.tsx", "utf8");
    expect(rail).not.toContain("app-mobile-nav");
    expect(rail).not.toContain("useCookieNoticeHeight");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    expect(detail).toContain("pb-[calc(var(--cookie-h)+1.5rem)] md:pb-[calc(var(--cookie-h)+7rem)]");
    expect(detail).not.toContain("pb-[calc(var(--cookie-h)+5rem)]");
    const tracker = readFileSync("src/app/tracker/page.tsx", "utf8");
    expect(tracker).not.toContain("pb-24 lg:pb-12");
    const feed = readFileSync("src/app/jobs/page.tsx", "utf8");
    expect(feed).not.toContain("sm:pb-32");
    const backToTop = readFileSync("src/components/BackToTop.tsx", "utf8");
    expect(backToTop).not.toContain("bottom-[84px]");
  });

  it("the six destinations stay reachable from the top-left drawer", () => {
    const topBar = readFileSync("src/components/shell/AppTopBar.tsx", "utf8");
    expect(topBar).toContain('id="mobile-nav-drawer"');
    expect(topBar).toContain("NAV_ITEMS.map");
    const rail = readFileSync("src/components/shell/AppIconRail.tsx", "utf8");
    for (const href of ['href: "/jobs"', 'href: "/resume"', 'href: "/tracker"', 'href: "/profile"', 'href: "/radar"', 'href: "/pricing"']) {
      expect(rail).toContain(href);
    }
  });

  it("/jobs no longer emits the detail-open hide signal", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    expect(page).not.toContain("careermonke_detail_open");
  });
});
