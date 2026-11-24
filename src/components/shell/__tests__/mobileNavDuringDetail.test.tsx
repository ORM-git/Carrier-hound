// @vitest-environment jsdom
import React, { act } from "react";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AppIconRail from "../AppIconRail";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs", useRouter: () => ({ push: vi.fn() }) }));
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
}));

// CM mobile item 16: the six-icon bottom nav stays visible while a job detail is open.
const visibleBelowMd = (el: HTMLElement) => {
  const cls = el.className.split(/\s+/);
  return cls.includes("flex") && cls.includes("md:hidden") && !cls.includes("hidden");
};

describe("mobile bottom nav during job detail (item 16)", () => {
  afterEach(() => cleanup());

  it("shows all six items and stays visible when a detail-open signal fires", () => {
    render(<AppIconRail />);
    const nav = screen.getByTestId("app-mobile-nav");
    expect(nav.querySelectorAll("a")).toHaveLength(6);
    expect(visibleBelowMd(nav)).toBe(true);

    act(() => {
      document.body.classList.add("cm-job-detail-open");
      window.dispatchEvent(new CustomEvent("careermonke_detail_open", { detail: { isOpen: true } }));
    });
    expect(visibleBelowMd(screen.getByTestId("app-mobile-nav"))).toBe(true);
  });

  it("/jobs no longer emits the detail-open hide signal, and the detail clears the 64px nav on mobile", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    expect(page).not.toContain("careermonke_detail_open");
    expect(detail).toContain("pb-[calc(var(--cookie-h)+5rem)] md:pb-[calc(var(--cookie-h)+7rem)]");
  });
});
