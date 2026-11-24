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
// Session is switchable per test (null = guest). FIXTURE user only.
const mockAuth = vi.hoisted(() => ({ session: null as any }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => ({ data: { session: mockAuth.session } }) } }) }));
vi.mock("@/lib/billing/subscription", () => ({ getProAccessStatus: async () => ({ isPro: false }) }));
vi.mock("@/components/shell/LoggedInAppShell", () => ({ default: ({ children }: { children: React.ReactNode }) => createElement("div", null, children) }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/seo/BreadcrumbJsonLd", () => ({ BreadcrumbJsonLd: () => null }));
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: mockToast }));

import PricingPage from "../page";
import { PLAN_PRICING, PLANS } from "@/config/plans";

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
});

describe("mobile plan picker: selection, explicit CTA, lock and recovery (item 23)", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  const env = { ...process.env };

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(PricingPage));
      await Promise.resolve();
    });
    for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  }
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED = "true";
    mockAuth.session = { user: { id: "fx-user", email: "fixture@example.invalid" } };
    mockHandleProCheckout.mockReset();
    mockOpenSubscription.mockReset();
    mockToast.error.mockReset();
    await mount();
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    process.env = { ...env };
    mockAuth.session = null;
  });

  const radios = () => Array.from(container.querySelectorAll<HTMLInputElement>('[data-testid="mobile-plan-picker"] input[type="radio"]'));
  const card = (id: string) => container.querySelector(`[data-plan-card="${id}"]`)!;
  const buy = (id: string) => card(id).querySelector<HTMLButtonElement>("button[data-plan-code]")!;
  const visibleCards = () =>
    Array.from(container.querySelectorAll("[data-plan-card]"))
      .filter((c) => !c.className.includes("max-md:hidden"))
      .map((c) => c.getAttribute("data-plan-card"));
  const consent = () => container.querySelector<HTMLInputElement>('[data-testid="autorenew-consent-checkbox"]')!;

  it("radios form one native group (arrow keys move within it) and are reachable by keyboard", async () => {
    expect(new Set(radios().map((r) => r.name)).size).toBe(1);
    for (const r of radios()) expect(r.tabIndex).not.toBe(-1);
    radios()[0].focus();
    expect(document.activeElement).toBe(radios()[0]);
    // Space on a focused radio checks it; jsdom has no default action, so the same click event is dispatched.
    await act(async () => radios()[0].click());
    expect(visibleCards()).toEqual(["weekly"]);
    await act(async () => radios()[2].click());
    expect(visibleCards()).toEqual(["quarterly"]);
    await act(async () => radios()[1].click());
    expect(visibleCards()).toEqual(["monthly"]);
  });

  it.each(["weekly", "monthly", "quarterly"] as const)(
    "%s: exactly one visible card whose CTA carries the plan code; price and duration from the catalog",
    async (id) => {
      await act(async () => radios().find((r) => r.value === id)!.click());
      expect(visibleCards()).toEqual([id]);
      expect(buy(id).getAttribute("data-plan-code")).toBe(id);
      expect(buy(id).textContent).toBe(`Buy ${PLANS.find((p) => p.id === id)!.name}`);
      const label = radios().find((r) => r.value === id)!.closest("label")!.textContent!;
      expect(label).toContain(`₹${PLAN_PRICING[id].price_inr.toLocaleString("en-IN")}`);
      expect(card(id).textContent).toMatch(id === "monthly" ? /Auto-renews monthly/ : new RegExp(`${PLAN_PRICING[id].duration_days} days access`));
      expect(mockHandleProCheckout).not.toHaveBeenCalled();
      expect(mockOpenSubscription).not.toHaveBeenCalled();
    }
  );

  it("price and duration contract is unchanged: ₹399/7d, ₹499/30d, ₹2,199/90d", () => {
    expect([PLAN_PRICING.weekly, PLAN_PRICING.monthly, PLAN_PRICING.quarterly].map((p) => [p.price_inr, p.duration_days])).toEqual([
      [399, 7],
      [499, 30],
      [2199, 90],
    ]);
  });

  it("consent starts unchecked; ticking it never starts checkout; only the explicit Buy click does, once", async () => {
    expect(consent().checked).toBe(false);
    expect(buy("monthly").disabled).toBe(true);
    await act(async () => consent().click());
    expect(consent().checked).toBe(true);
    expect(mockOpenSubscription).not.toHaveBeenCalled();
    mockOpenSubscription.mockImplementation(() => new Promise(() => {})); // provider sheet stays open
    await act(async () => buy("monthly").click());
    await act(async () => buy("monthly").click());
    await act(async () => buy("weekly").click());
    expect(mockOpenSubscription).toHaveBeenCalledTimes(1);
    expect(mockOpenSubscription.mock.calls[0][0]).toMatchObject({ planCode: "monthly", consent: { agreed: true } });
    expect(mockHandleProCheckout).not.toHaveBeenCalled();
    expect(buy("monthly").disabled).toBe(true);
    expect(buy("weekly").disabled).toBe(true);
  });

  it("prepaid plan: one checkout per explicit click with its plan code; duplicate clicks are locked", async () => {
    mockHandleProCheckout.mockImplementation(() => new Promise(() => {}));
    await act(async () => radios()[2].click());
    await act(async () => buy("quarterly").click());
    await act(async () => buy("quarterly").click());
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(mockHandleProCheckout.mock.calls[0][0]).toMatchObject({ planCode: "quarterly" });
    expect(mockOpenSubscription).not.toHaveBeenCalled();
  });

  it("cancel (dismiss) unlocks the buttons with no error and no automatic retry", async () => {
    mockHandleProCheckout.mockImplementation(async (opts: any) => opts.onDismiss());
    await act(async () => radios()[0].click());
    await act(async () => buy("weekly").click());
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    expect(buy("weekly").disabled).toBe(false);
    expect(mockToast.error).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["provider error callback", (opts: any) => opts.onError("FIXTURE: payment declined")],
    ["thrown error", () => Promise.reject(new Error("FIXTURE: network"))],
  ])("%s: message shown, lock released, the user can try again explicitly", async (_n, impl) => {
    mockHandleProCheckout.mockImplementationOnce(impl as any);
    await act(async () => radios()[0].click());
    await act(async () => buy("weekly").click());
    expect(mockToast.error).toHaveBeenCalledTimes(1);
    expect(buy("weekly").disabled).toBe(false);
    mockHandleProCheckout.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => buy("weekly").click());
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(2);
  });
});
