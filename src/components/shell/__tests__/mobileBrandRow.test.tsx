// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AppTopBar from "../AppTopBar";

let path = "/jobs";
vi.mock("next/navigation", () => ({ usePathname: () => path, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/session", () => ({ signOutUser: vi.fn() }));
afterEach(() => { cleanup(); path = "/jobs"; });

const user = { id: "u1", email: "a@b.test", user_metadata: {} } as any;

describe("shared mobile brand row", () => {
  it.each(["JOBS", "TRACKER", "SETTINGS", "PROFILE", "RESUME", "RADAR", "PRICING"])("%s: wordmark home link left, own-profile link right, one of each", (label) => {
    render(<AppTopBar pageLabel={label} user={user} />);
    const row = screen.getByTestId("app-mobile-brand-row");
    expect(row.className).toContain("md:hidden");
    const brand = screen.getByTestId("app-mobile-brand");
    expect(brand.getAttribute("href")).toBe("/jobs");
    expect(brand.textContent).toBe("career monke"); // one line of text, not the stacked two-line image
    expect(brand.querySelector("img")).toBeNull();
    const profile = screen.getByRole("link", { name: "Open my profile" });
    expect(profile.getAttribute("href")).toBe("/profile");
    expect(profile.querySelector("svg")).toBeTruthy();
    expect(row.firstElementChild).toBe(brand);
    expect(row.lastElementChild?.contains(profile)).toBe(true);
    expect(screen.getAllByTestId("app-mobile-brand")).toHaveLength(1);
  });
  it("jobs tabs keep their row and the brand row sits before the sticky bar, which keeps h-14", () => {
    const t = (id: string, label: string, active = false) => ({ id, label, active, onClick: () => {} });
    render(<AppTopBar pageLabel="JOBS" user={user} mobileTabs={[t("recommended", "For You", true), t("saved", "Saved"), t("applied", "Applied")]} />);
    const row = screen.getByTestId("app-mobile-brand-row");
    const bar = screen.getByTestId("app-top-bar");
    expect(row.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.className).toContain("sticky top-0");
    expect(bar.className).toContain("h-14");
    expect(screen.getByRole("button", { name: "For You" })).toBeTruthy();
  });
  it("guests get the same profile link (the profile page sends them to login and back)", () => {
    render(<AppTopBar pageLabel="JOBS" user={null} />);
    expect(screen.getByRole("link", { name: "Open my profile" }).getAttribute("href")).toBe("/profile");
  });
  it("on the profile page the icon is marked current and still points at /profile (no redirect loop)", () => {
    path = "/profile";
    render(<AppTopBar pageLabel="PROFILE" user={user} />);
    const link = screen.getByRole("link", { name: "Open my profile" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("href")).toBe("/profile");
  });
  it("existing bar controls are untouched: search toggle, avatar menu and hidden-below-sm cluster stay in the bar", () => {
    render(<AppTopBar pageLabel="TRACKER" user={user} onSearchChange={() => {}} />);
    const bar = screen.getByTestId("app-top-bar");
    expect(bar.querySelector('[aria-label="Toggle search input"]')).toBeTruthy();
    expect(bar.querySelector('[aria-label="User avatar menu"]')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "TRACKER" }).className).toContain("sr-only md:not-sr-only");
  });
});
