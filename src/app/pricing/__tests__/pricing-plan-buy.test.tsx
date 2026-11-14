// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHandleProCheckout = vi.fn();
const mockGetSession = vi.fn();
const mockGetProAccessStatus = vi.fn();

vi.mock("@/lib/billing/checkout", () => ({
  handleProCheckout: (...args: any[]) => mockHandleProCheckout(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
    },
  }),
}));

vi.mock("@/lib/billing/subscription", () => ({
  getProAccessStatus: (...args: any[]) => mockGetProAccessStatus(...args),
}));

vi.mock("@/components/shell/LoggedInAppShell", () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "app-shell" }, children),
}));

vi.mock("@/components/Footer", () => ({
  default: () => null,
}));

vi.mock("@/components/seo/BreadcrumbJsonLd", () => ({
  BreadcrumbJsonLd: () => null,
}));

vi.mock("react-toastify", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import PricingPage from "../page";

describe("Pricing Page Plan Purchase Flow (NEXT_PUBLIC_BILLING_ENABLED)", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let originalLocation: Location;
  const originalBillingEnv = process.env.NEXT_PUBLIC_BILLING_ENABLED;

  beforeEach(() => {
    mockHandleProCheckout.mockReset();
    mockGetSession.mockReset();
    mockGetProAccessStatus.mockReset().mockResolvedValue({ isPro: true });

    originalLocation = window.location;
    delete (window as any).location;
    (window as any).location = {
      href: "http://localhost:3000/pricing",
      pathname: "/pricing",
      search: "",
    };
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    (window as any).location = originalLocation;
    process.env.NEXT_PUBLIC_BILLING_ENABLED = originalBillingEnv;
    vi.restoreAllMocks();
  });

  async function mountPage() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(PricingPage));
      await Promise.resolve();
    });
    // Allow useEffect auth check to finish
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  describe("Flag OFF (Payments strictly OFF)", () => {
    it("keeps plan cards disabled with 'Upgrade' text and 'Payments opening soon' badge when flag is undefined", async () => {
      delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      // No data-plan-code buy buttons should exist
      const buyButtons = container ? Array.from(container.querySelectorAll("button[data-plan-code]")) : [];
      expect(buyButtons.length).toBe(0);

      // Disabled Upgrade buttons should be present
      const upgradeButtons = container
        ? Array.from(container.querySelectorAll("button")).filter(
            (btn) => btn.textContent?.trim() === "Upgrade"
          )
        : [];
      expect(upgradeButtons.length).toBeGreaterThan(0);
      for (const btn of upgradeButtons) {
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute("aria-disabled")).toBe("true");
      }

      // "Payments opening soon" badges must be present
      expect(container?.textContent).toContain("Payments opening soon");

      // Clicking disabled upgrade button must not invoke checkout
      if (upgradeButtons[0]) {
        await act(async () => {
          upgradeButtons[0].click();
          await Promise.resolve();
        });
      }
      expect(mockHandleProCheckout).not.toHaveBeenCalled();
    });

    it("keeps plan cards disabled when flag is explicitly 'false'", async () => {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const buyButtons = container ? Array.from(container.querySelectorAll("button[data-plan-code]")) : [];
      expect(buyButtons.length).toBe(0);
      expect(container?.textContent).toContain("Payments opening soon");
    });
  });

  describe("Flag ON (Payments ON: NEXT_PUBLIC_BILLING_ENABLED=true)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    });

    it("renders active Buy buttons for all plans (Buy Weekly, Buy Monthly, Buy Quarterly) without 'Payments opening soon'", async () => {
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const buyButtons = container ? Array.from(container.querySelectorAll("button[data-plan-code]")) : [];
      // Both desktop and mobile buttons are rendered (3 plans * 2 views = 6 buttons)
      expect(buyButtons.length).toBe(6);

      const codes = buyButtons.map((btn) => btn.getAttribute("data-plan-code"));
      expect(codes).toContain("weekly");
      expect(codes).toContain("monthly");
      expect(codes).toContain("quarterly");

      const weeklyBtns = buyButtons.filter((b) => b.getAttribute("data-plan-code") === "weekly");
      const monthlyBtns = buyButtons.filter((b) => b.getAttribute("data-plan-code") === "monthly");
      const quarterlyBtns = buyButtons.filter((b) => b.getAttribute("data-plan-code") === "quarterly");

      for (const btn of weeklyBtns) expect(btn.textContent).toBe("Buy Weekly");
      for (const btn of monthlyBtns) expect(btn.textContent).toBe("Buy Monthly");
      for (const btn of quarterlyBtns) expect(btn.textContent).toBe("Buy Quarterly");

      // None of the plan cards should have "Payments opening soon" badge
      expect(container?.textContent).not.toContain("Payments opening soon");
    });

    it("clicking Buy Monthly calls handleProCheckout with planCode 'monthly'", async () => {
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      expect(monthlyBtn).toBeTruthy();

      await act(async () => {
        monthlyBtn.click();
        await Promise.resolve();
      });

      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
      expect(mockHandleProCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          planCode: "monthly",
          redirectTarget: "/pricing",
        })
      );
    });

    it("clicking Buy Weekly calls handleProCheckout with planCode 'weekly'", async () => {
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const weeklyBtn = container?.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement;
      expect(weeklyBtn).toBeTruthy();

      await act(async () => {
        weeklyBtn.click();
        await Promise.resolve();
      });

      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
      expect(mockHandleProCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          planCode: "weekly",
          redirectTarget: "/pricing",
        })
      );
    });

    it("clicking Buy Quarterly calls handleProCheckout with planCode 'quarterly'", async () => {
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const quarterlyBtn = container?.querySelector("button[data-plan-code='quarterly']") as HTMLButtonElement;
      expect(quarterlyBtn).toBeTruthy();

      await act(async () => {
        quarterlyBtn.click();
        await Promise.resolve();
      });

      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
      expect(mockHandleProCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          planCode: "quarterly",
          redirectTarget: "/pricing",
        })
      );
    });

    it("redirects unauthenticated visitors to /login when clicking Buy", async () => {
      mockGetSession.mockResolvedValue({
        data: { session: null },
      });

      await mountPage();

      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      expect(monthlyBtn).toBeTruthy();

      await act(async () => {
        monthlyBtn.click();
        await Promise.resolve();
      });

      expect(mockHandleProCheckout).not.toHaveBeenCalled();
      expect(window.location.href).toContain("/login");
      expect(window.location.href).toContain(encodeURIComponent("/pricing"));
    });

    it("disables ALL plan buttons while checkout is in flight, preventing duplicate orders", async () => {
      let capturedOptions: any = null;
      mockHandleProCheckout.mockImplementation((opts: any) => {
        capturedOptions = opts;
        return new Promise(() => {}); // Intentionally pending
      });

      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const planButtons = container ? Array.from(container.querySelectorAll("button[data-plan-code]")) as HTMLButtonElement[] : [];
      expect(planButtons.length).toBe(6);
      expect(planButtons.every((btn) => !btn.disabled)).toBe(true);

      // Click monthly plan
      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      await act(async () => {
        monthlyBtn.click();
        await Promise.resolve();
      });

      // ALL plan buttons must now be disabled
      expect(planButtons.every((btn) => btn.disabled)).toBe(true);

      // Attempt second click on weekly plan while in flight - must not invoke checkout again
      const weeklyBtn = container?.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement;
      await act(async () => {
        weeklyBtn.click();
        await Promise.resolve();
      });
      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);

      // Trigger onDismiss - must clear in-flight state and re-enable all buttons
      await act(async () => {
        capturedOptions?.onDismiss?.();
        await Promise.resolve();
      });

      expect(planButtons.every((btn) => !btn.disabled)).toBe(true);
    });

    it("clears in-flight disabled state when checkout triggers onError", async () => {
      let capturedOptions: any = null;
      mockHandleProCheckout.mockImplementation((opts: any) => {
        capturedOptions = opts;
        return new Promise(() => {});
      });

      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;

      await act(async () => {
        monthlyBtn.click();
        await Promise.resolve();
      });
      expect(monthlyBtn.disabled).toBe(true);

      // Simulate payment error / failure
      await act(async () => {
        capturedOptions?.onError?.("Payment cancelled or failed");
        await Promise.resolve();
      });

      expect(monthlyBtn.disabled).toBe(false);
    });

    it("synchronously locks concurrent clicks while getSession is pending, calling handleProCheckout exactly once", async () => {
      // Initial mount: user is null so handleBuyPlan will await getSession()
      mockGetSession.mockResolvedValueOnce({
        data: { session: null },
      });

      await mountPage();

      let resolveSession: ((val: any) => void) | null = null;
      const pendingSessionPromise = new Promise((resolve) => {
        resolveSession = resolve;
      });

      // When handleBuyPlan calls getSession, return the pending promise
      mockGetSession.mockImplementation(() => pendingSessionPromise);

      const weeklyBtn = container?.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement;
      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      expect(weeklyBtn).toBeTruthy();
      expect(monthlyBtn).toBeTruthy();

      // Click 1: weekly plan while getSession is pending
      await act(async () => {
        weeklyBtn.click();
      });

      // Click 2: different plan (monthly) in a separate act while getSession is STILL pending
      await act(async () => {
        monthlyBtn.click();
      });

      // handleProCheckout must not have been called yet
      expect(mockHandleProCheckout).not.toHaveBeenCalled();

      // Now resolve getSession with an authenticated user
      await act(async () => {
        resolveSession!({
          data: {
            session: {
              user: { id: "test-user-id", email: "candidate@gmail.com" },
            },
          },
        });
        await Promise.resolve();
      });

      // Assert handleProCheckout is called exactly once (for the first plan weekly)
      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
      expect(mockHandleProCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          planCode: "weekly",
          redirectTarget: "/pricing",
        })
      );
    });
  });
});
