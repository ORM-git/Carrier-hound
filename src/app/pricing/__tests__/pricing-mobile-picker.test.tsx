// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CM mobile item 23: mobile plan picker with Monthly (middle tier) preselected; CTA follows the selection;
// selecting never starts checkout; recurring consent stays unchecked.
const mockHandleProCheckout = vi.fn();
const mockOpenSubscription = vi.fn();
vi.mock("@/lib/billing/checkout", () => ({
  handleProCheckout: (...a: any[]) => mockHandleProCheckout(...a),
  openRazorpaySubscription: (...a: any[]) => mockOpenSubscription(...a),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: "fixture-user" } } } }) } }) }));
vi.mock("@/lib/billing/subscription", () => ({ getProAccessStatus: async () => ({ isPro: false }) }));
vi.mock("@/components/shell/LoggedInAppShell", () => ({ default: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/seo/BreadcrumbJsonLd", () => ({ BreadcrumbJsonLd: () => null }));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import PricingPage from "../page";

describe("mobile plan picker (item 23)", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  const env = { ...process.env };

  beforeEach(async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    mockHandleProCheckout.mockReset();
    mockOpenSubscription.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(PricingPage));
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    process.env = { ...env };
  });

  const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>('[data-testid="mobile-plan-picker"] input[type="radio"]'));
  const card = (id: string) => container.querySelector(`[data-plan-card="${id}"]`)!;

  it("is a labelled radio group in Weekly, Monthly, Quarterly order with Monthly checked", () => {
    expect(container.querySelector('[data-testid="mobile-plan-picker"] legend')?.textContent).toBe("Choose a plan");
    expect(radios().map((r) => r.value)).toEqual(["weekly", "monthly", "quarterly"]);
    expect(radios().find((r) => r.checked)?.value).toBe("monthly");
    expect(card("monthly").className).not.toContain("max-md:hidden");
    expect(card("weekly").className).toContain("max-md:hidden");
    expect(card("quarterly").className).toContain("max-md:hidden");
  });

  it("selecting Weekly/Quarterly moves the visible card and its CTA without starting checkout", async () => {
    await act(async () => radios()[0].click());
    expect(card("weekly").className).not.toContain("max-md:hidden");
    expect(card("monthly").className).toContain("max-md:hidden");
    expect(card("weekly").querySelector("button[data-plan-code]")?.textContent).toBe("Buy Weekly");
    await act(async () => radios()[2].click());
    expect(card("quarterly").className).not.toContain("max-md:hidden");
    expect(card("quarterly").querySelector("button[data-plan-code]")?.textContent).toBe("Buy Quarterly");
    expect(mockHandleProCheckout).not.toHaveBeenCalled();
    expect(mockOpenSubscription).not.toHaveBeenCalled();
  });

  it("keeps prices, durations and the unchecked recurring consent gating Buy Monthly", () => {
    const consent = container.querySelector<HTMLInputElement>('[data-testid="autorenew-consent-checkbox"]')!;
    expect(container.querySelectorAll('[data-testid="autorenew-consent-checkbox"]').length).toBe(1);
    expect(consent.checked).toBe(false);
    expect((card("monthly").querySelector("button[data-plan-code]") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelectorAll("[data-plan-card]").length).toBe(3); // desktop cards all still rendered
    for (const r of radios()) expect(r.closest("label")?.textContent).toMatch(/₹/);
  });
  it.each(["weekly", "monthly", "quarterly"])("explicit Buy %s uses correct checkout and cancellation unlocks retry", async (plan) => {
    const radio = radios().find(r => r.value === plan)!;
    await act(async () => radio.click());
    if (plan === "monthly") {
      const consent = container.querySelector<HTMLInputElement>('[data-testid="autorenew-consent-checkbox"]')!;
      expect(consent.checked).toBe(false);
      await act(async () => consent.click());
    }
    expect(mockHandleProCheckout).not.toHaveBeenCalled();
    expect(mockOpenSubscription).not.toHaveBeenCalled();
    const buy = card(plan).querySelector<HTMLButtonElement>('button[data-plan-code]')!;
    await act(async () => { buy.click(); buy.click(); });
    const checkout = plan === "monthly" ? mockOpenSubscription : mockHandleProCheckout;
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout.mock.calls[0][0].planCode).toBe(plan);
    await act(async () => checkout.mock.calls[0][0].onDismiss());
    expect(buy.disabled).toBe(false);
    await act(async () => buy.click());
    expect(checkout).toHaveBeenCalledTimes(2);
    await act(async () => checkout.mock.calls[1][0].onError("Fixture error"));
    expect(buy.disabled).toBe(false);
  });

});
