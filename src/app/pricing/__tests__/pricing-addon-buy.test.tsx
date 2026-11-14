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

describe("Pricing Page Add-on Pack Buy Flow", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let originalLocation: Location;

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

  it("renders Buy buttons on all add-on pack cards (addon_10, addon_30, addon_60)", async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: "test-user-id", email: "candidate@gmail.com" },
        },
      },
    });

    await mountPage();

    const buyButtons = container ? Array.from(container.querySelectorAll("button[data-addon-code]")) : [];
    expect(buyButtons.length).toBe(3);

    const codes = buyButtons.map((btn) => btn.getAttribute("data-addon-code"));
    expect(codes).toEqual(["addon_10", "addon_30", "addon_60"]);

    for (const btn of buyButtons) {
      expect(btn.textContent).toBe("Buy");
    }
  });

  it("clicking Buy on addon_30 sends addonCode 'addon_30' to checkout handler", async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: "test-user-id", email: "candidate@gmail.com" },
        },
      },
    });

    await mountPage();

    const btn30 = container?.querySelector("button[data-addon-code='addon_30']") as HTMLButtonElement;
    expect(btn30).toBeTruthy();

    await act(async () => {
      btn30.click();
      await Promise.resolve();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        addonCode: "addon_30",
        redirectTarget: "/pricing",
      })
    );
  });

  it("clicking Buy on addon_60 sends addonCode 'addon_60' to checkout handler", async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: "test-user-id", email: "candidate@gmail.com" },
        },
      },
    });

    await mountPage();

    const btn60 = container?.querySelector("button[data-addon-code='addon_60']") as HTMLButtonElement;
    expect(btn60).toBeTruthy();

    await act(async () => {
      btn60.click();
      await Promise.resolve();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        addonCode: "addon_60",
        redirectTarget: "/pricing",
      })
    );
  });

  it("clicking Buy on addon_10 sends addonCode 'addon_10' to checkout handler", async () => {
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: "test-user-id", email: "candidate@gmail.com" },
        },
      },
    });

    await mountPage();

    const btn10 = container?.querySelector("button[data-addon-code='addon_10']") as HTMLButtonElement;
    expect(btn10).toBeTruthy();

    await act(async () => {
      btn10.click();
      await Promise.resolve();
    });

    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        addonCode: "addon_10",
        redirectTarget: "/pricing",
      })
    );
  });

  it("redirects unauthenticated visitors to /login when clicking Buy", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
    });

    await mountPage();

    const btn30 = container?.querySelector("button[data-addon-code='addon_30']") as HTMLButtonElement;
    expect(btn30).toBeTruthy();

    await act(async () => {
      btn30.click();
      await Promise.resolve();
    });

    expect(mockHandleProCheckout).not.toHaveBeenCalled();
    expect(window.location.href).toContain("/login");
    expect(window.location.href).toContain(encodeURIComponent("/pricing"));
  });
});
