// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, fireEvent, act, screen, cleanup } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getAuthUser: vi.fn().mockResolvedValue(null),
  signOutUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/billing/subscription", () => ({
  getProAccessStatus: vi.fn().mockResolvedValue({ isPro: false }),
}));

vi.mock("next/image", () => ({
  default: ({ priority: _priority, ...props }: any) => React.createElement("img", { ...props, alt: props.alt || "" }),
}));

import AppTopBar from "@/components/shell/AppTopBar";
import GuideHeader from "@/components/GuideHeader";

describe("Mobile Navigation Drawer A11y", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("AppTopBar mobile drawer", () => {
    it("renders drawer with role='dialog' and aria-modal='true'", () => {
      render(<AppTopBar pageLabel="Jobs" />);
      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer).toBeDefined();
      expect(drawer.getAttribute("role")).toBe("dialog");
      expect(drawer.getAttribute("aria-modal")).toBe("true");
    });

    it("is hidden and inert when closed", () => {
      render(<AppTopBar pageLabel="Jobs" />);
      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(drawer.hasAttribute("inert") || drawer.getAttribute("inert") === "").toBe(true);
      expect(drawer.className).toContain("invisible");
      expect(drawer.className).toContain("pointer-events-none");
    });

    it("moves focus into drawer on open and exposes accessible state", async () => {
      vi.useFakeTimers();
      render(<AppTopBar pageLabel="Jobs" />);
      const menuButton = screen.getByLabelText("Open navigation menu");
      expect(menuButton.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(menuButton);
      expect(menuButton.getAttribute("aria-expanded")).toBe("true");

      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer.getAttribute("aria-hidden")).toBe("false");

      act(() => {
        vi.runAllTimers();
      });

      const closeButton = screen.getByLabelText("Close navigation menu");
      expect(document.activeElement).toBe(closeButton);
    });

    it("traps Tab and Shift-Tab inside the drawer", async () => {
      vi.useFakeTimers();
      render(<AppTopBar pageLabel="Jobs" />);
      const menuButton = screen.getByLabelText("Open navigation menu");
      fireEvent.click(menuButton);

      act(() => {
        vi.runAllTimers();
      });

      const drawer = screen.getByLabelText("Mobile Navigation");
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));

      expect(focusables.length).toBeGreaterThan(1);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // Tab on last element wraps to first
      last.focus();
      expect(document.activeElement).toBe(last);
      fireEvent.keyDown(window, { key: "Tab" });
      expect(document.activeElement).toBe(first);

      // Shift-Tab on first element wraps to last
      first.focus();
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it("closes drawer on Escape and restores focus to menu button", async () => {
      vi.useFakeTimers();
      render(<AppTopBar pageLabel="Jobs" />);
      const menuButton = screen.getByLabelText("Open navigation menu");
      menuButton.focus();
      act(() => {
        fireEvent.click(menuButton);
        vi.runAllTimers();
      });

      expect(menuButton.getAttribute("aria-expanded")).toBe("true");

      // Press Escape
      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      expect(menuButton.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(menuButton);
    });
  });

  describe("GuideHeader mobile drawer", () => {
    it("renders drawer with role='dialog' and aria-modal='true'", async () => {
      await act(async () => {
        render(<GuideHeader />);
      });
      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer).toBeDefined();
      expect(drawer.getAttribute("role")).toBe("dialog");
      expect(drawer.getAttribute("aria-modal")).toBe("true");
    });

    it("is hidden and inert when closed", async () => {
      await act(async () => {
        render(<GuideHeader />);
      });
      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      expect(drawer.hasAttribute("inert") || drawer.getAttribute("inert") === "").toBe(true);
      expect(drawer.className).toContain("invisible");
      expect(drawer.className).toContain("pointer-events-none");
    });

    it("moves focus into drawer on open and exposes accessible state", async () => {
      vi.useFakeTimers();
      await act(async () => {
        render(<GuideHeader />);
      });
      const menuButton = screen.getByLabelText("Open navigation menu");
      expect(menuButton.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(menuButton);
      expect(menuButton.getAttribute("aria-expanded")).toBe("true");

      const drawer = screen.getByLabelText("Mobile Navigation");
      expect(drawer.getAttribute("aria-hidden")).toBe("false");

      act(() => {
        vi.runAllTimers();
      });

      const closeButton = screen.getByLabelText("Close navigation menu");
      expect(document.activeElement).toBe(closeButton);
    });

    it("traps Tab and Shift-Tab inside the drawer", async () => {
      vi.useFakeTimers();
      await act(async () => {
        render(<GuideHeader />);
      });
      const menuButton = screen.getByLabelText("Open navigation menu");
      fireEvent.click(menuButton);

      act(() => {
        vi.runAllTimers();
      });

      const drawer = screen.getByLabelText("Mobile Navigation");
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));

      expect(focusables.length).toBeGreaterThan(1);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // Tab on last element wraps to first
      last.focus();
      expect(document.activeElement).toBe(last);
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(first);

      // Shift-Tab on first element wraps to last
      first.focus();
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it("closes drawer on Escape and restores focus to menu button", async () => {
      vi.useFakeTimers();
      await act(async () => {
        render(<GuideHeader />);
      });
      const menuButton = screen.getByLabelText("Open navigation menu");
      menuButton.focus();
      act(() => {
        fireEvent.click(menuButton);
        vi.runAllTimers();
      });

      expect(menuButton.getAttribute("aria-expanded")).toBe("true");

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(menuButton.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(menuButton);
    });
  });
});
