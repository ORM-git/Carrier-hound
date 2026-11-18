// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHandleProCheckout = vi.fn();
const mockOpenRazorpaySubscription = vi.fn();
const mockGetSession = vi.fn();
const mockGetProAccessStatus = vi.fn();

vi.mock("@/lib/billing/checkout", () => ({
  handleProCheckout: (...args: any[]) => mockHandleProCheckout(...args),
  openRazorpaySubscription: (...args: any[]) => mockOpenRazorpaySubscription(...args),
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

describe("Pricing Page Auto-Renew Subscription Permutations & Lock Behavior", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let originalLocation: Location;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockHandleProCheckout.mockReset();
    mockOpenRazorpaySubscription.mockReset();
    mockGetSession.mockReset().mockResolvedValue({
      data: {
        session: {
          user: { id: "user_123", email: "user@example.com" },
          access_token: "mock_token",
        },
      },
    });
    mockGetProAccessStatus.mockReset().mockResolvedValue({ isPro: false });

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
    process.env = { ...originalEnv };
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("keeps all plan buttons disabled when NEXT_PUBLIC_BILLING_ENABLED is off", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
    delete process.env.NEXT_PUBLIC_AUTORENEW_ENABLED;

    await mountPage();

    const upgradeButtons = container
      ? Array.from(container.querySelectorAll("button")).filter((btn) =>
          btn.textContent?.trim().includes("Upgrade")
        )
      : [];
    expect(upgradeButtons.length).toBeGreaterThanOrEqual(3);

    for (const btn of upgradeButtons) {
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      await act(async () => {
        btn.click();
      });
      expect(mockHandleProCheckout).not.toHaveBeenCalled();
      expect(mockOpenRazorpaySubscription).not.toHaveBeenCalled();
    }
  });

  it("calls handleProCheckout prepaid flow when BILLING is on and AUTORENEW is off", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";

    await mountPage();

    const monthlyButton = container?.querySelector(
      'button[data-plan-code="monthly"]'
    ) as HTMLButtonElement | null;
    expect(monthlyButton).not.toBeNull();
    expect(monthlyButton?.disabled).toBe(false);

    await act(async () => {
      monthlyButton?.click();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        planCode: "monthly",
        redirectTarget: "/pricing",
      })
    );
    expect(mockOpenRazorpaySubscription).not.toHaveBeenCalled();
  });

  it("calls handleProCheckout prepaid flow even when both BILLING and AUTORENEW are on (prepaid forced)", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

    await mountPage();

    const weeklyButton = container?.querySelector(
      'button[data-plan-code="weekly"]'
    ) as HTMLButtonElement | null;
    expect(weeklyButton).not.toBeNull();
    expect(weeklyButton?.disabled).toBe(false);

    await act(async () => {
      weeklyButton?.click();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        planCode: "weekly",
        redirectTarget: "/pricing",
      })
    );
    expect(mockOpenRazorpaySubscription).not.toHaveBeenCalled();
  });

  it("holds lock while checkout is pending and re-enables on dismissal", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

    let capturedOptions: any = null;
    mockHandleProCheckout.mockImplementation((opts: any) => {
      capturedOptions = opts;
      return new Promise<void>(() => {}); // Stays pending
    });

    await mountPage();

    const monthlyButton = container?.querySelector(
      'button[data-plan-code="monthly"]'
    ) as HTMLButtonElement | null;
    const weeklyButton = container?.querySelector(
      'button[data-plan-code="weekly"]'
    ) as HTMLButtonElement | null;
    const quarterlyButton = container?.querySelector(
      'button[data-plan-code="quarterly"]'
    ) as HTMLButtonElement | null;

    // First click initiates prepaid checkout
    await act(async () => {
      monthlyButton?.click();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(monthlyButton?.disabled).toBe(true);
    expect(weeklyButton?.disabled).toBe(true);
    expect(quarterlyButton?.disabled).toBe(true);

    // Second click on any button while locked must do nothing
    await act(async () => {
      weeklyButton?.click();
    });
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);

    // Terminal callback (e.g. user dismisses modal) releases lock
    await act(async () => {
      capturedOptions?.onDismiss?.();
    });

    expect(monthlyButton?.disabled).toBe(false);
    expect(weeklyButton?.disabled).toBe(false);
    expect(quarterlyButton?.disabled).toBe(false);
  });

  it("redirects signed-out visitor to login before opening subscription modal", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

    mockGetSession.mockResolvedValue({ data: { session: null } });

    await mountPage();

    const monthlyButton = container?.querySelector(
      'button[data-plan-code="monthly"]'
    ) as HTMLButtonElement | null;

    await act(async () => {
      monthlyButton?.click();
    });

    expect(mockOpenRazorpaySubscription).not.toHaveBeenCalled();
    expect(mockHandleProCheckout).not.toHaveBeenCalled();
    expect(window.location.href).toBe("/login?returnTo=%2Fpricing");
  });

  it("renders exact 'prepaid, no auto-renew' text and durations", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "false";

    await mountPage();

    const textContent = container?.textContent || "";
    expect(textContent).toContain(
      "Plans are prepaid for a fixed duration and do not auto-renew. (Weekly: ₹399 for 7 days, Monthly: ₹499 for 30 days, Quarterly: ₹2,199 for 90 days). Access ends automatically when the plan period expires."
    );
    expect(textContent).toContain("7 days access");
    expect(textContent).toContain("30 days access");
    expect(textContent).toContain("90 days access");
  });

  it("renders prepaid copy and prices with new amounts (₹399, ₹499, ₹2,199)", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";

    await mountPage();

    const textContent = container?.textContent || "";
    expect(textContent).toContain("Plans are prepaid for a fixed duration and do not auto-renew");
    expect(textContent).toContain("Weekly: ₹399 for 7 days");
    expect(textContent).toContain("Monthly: ₹499 for 30 days");
    expect(textContent).toContain("Quarterly: ₹2,199 for 90 days");
    expect(textContent).toContain("7 days access");
    expect(textContent).toContain("30 days access");
    expect(textContent).toContain("90 days access");
  });
});
