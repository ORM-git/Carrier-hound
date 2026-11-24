// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BackToTop from "@/components/BackToTop";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
beforeEach(() => {
  route.pathname = "/";
  Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
  window.scrollTo = vi.fn();
});
afterEach(cleanup);

describe("BackToTop onboarding action-bar safety", () => {
  it.each(["/onboarding", "/onboarding/"])('never overlays the onboarding footer on %s, including after scrolling', (pathname) => {
    route.pathname = pathname;
    render(<BackToTop />);
    fireEvent.scroll(window);
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
  });
  it("removes a visible shortcut immediately on client navigation into onboarding and restores it outside", () => {
    const view = render(<BackToTop />);
    expect(screen.getByRole("button", { name: "Back to top" })).toBeTruthy();
    route.pathname = "/onboarding";
    view.rerender(<BackToTop />);
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
    route.pathname = "/jobs";
    view.rerender(<BackToTop />);
    expect(screen.getByRole("button", { name: "Back to top" })).toBeTruthy();
  });
  it("preserves the shortcut and smooth scrolling on ordinary routes", () => {
    route.pathname = "/jobs";
    render(<BackToTop />);
    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    Object.defineProperty(window, "scrollY", { value: 100, configurable: true });
    fireEvent.scroll(window);
    expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
  });
});
