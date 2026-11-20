// @vitest-environment jsdom
import React from "react";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AppIconRail from "../AppIconRail";
import { SIDEBAR_STORAGE_KEY, getStoredSidebarExpanded } from "@/lib/sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/jobs", useRouter: () => ({ push: vi.fn() }) }));

// Wide desktop: the old Jobs-only override forced the rail open at >=1440px, so the toggle did nothing.
const setViewportMatches = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
};

const mode = () => screen.getByTestId("app-icon-rail").getAttribute("data-sidebar-mode");

describe("Jobs left sidebar: collapsible like Tracker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportMatches(true);
  });
  afterEach(() => cleanup());

  it("collapses to the 72px icon rail and expands again via the chevron toggle", () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({ v: 1, data: true }));
    render(<AppIconRail />);
    expect(mode()).toBe("expanded");

    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(mode()).toBe("narrow");
    expect(screen.getByTestId("app-icon-rail").className).toContain("w-[72px]");

    fireEvent.click(screen.getByLabelText("Expand sidebar"));
    expect(mode()).toBe("expanded");
    expect(screen.getByTestId("app-icon-rail").className).toContain("w-[240px]");
  });

  it("persists the collapsed state in the shared sidebar key and restores it on remount", () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({ v: 1, data: true }));
    const first = render(<AppIconRail />);
    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(getStoredSidebarExpanded()).toBe(false);
    first.unmount();

    render(<AppIconRail />);
    expect(mode()).toBe("narrow"); // stays collapsed at >=1440px, not forced open
  });

  it("Jobs page uses the same rail and content offset as the Tracker shell", () => {
    const jobs = fs.readFileSync(path.resolve("src/app/jobs/page.tsx"), "utf8");
    const shell = fs.readFileSync(path.resolve("src/components/shell/LoggedInAppShell.tsx"), "utf8");
    expect(jobs).toContain("<AppIconRail />");
    expect(jobs).toContain('isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"');
    expect(shell).toContain('isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"');
  });
});
