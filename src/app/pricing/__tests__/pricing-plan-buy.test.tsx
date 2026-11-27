// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockHandleProCheckout = vi.fn();
const mockGetSession = vi.fn();
const mockFrom = vi.fn();
const mockGetProAccessStatus = vi.fn();

vi.mock("@/lib/billing/checkout", () => ({
  handleProCheckout: (...args: any[]) => mockHandleProCheckout(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: mockFrom,
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
    sessionStorage.clear();
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

  it("keeps prepaid confirmation locked and restores references after refresh without storing signatures", async()=>{
    process.env.NEXT_PUBLIC_BILLING_ENABLED="true";
    mockGetSession.mockResolvedValue({data:{session:{user:{id:"recovery-user"}}}});
    mockHandleProCheckout.mockImplementation(async(opts:any)=>{opts.onPending({orderId:"order_fixture",paymentId:"pay_fixture",retry:async()=>{}})});
    await mountPage();
    await act(async()=>{(container!.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement).click()});
    expect(container!.textContent).toContain("Payment confirmation pending");
    expect(Array.from(container!.querySelectorAll("button[data-plan-code]")).every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("cm_pending_payment:recovery-user")!)).toEqual({orderId:"order_fixture",paymentId:"pay_fixture"});
    act(()=>root!.unmount());root=null;container!.remove();
    await mountPage();
    expect(container!.textContent).toContain("Payment confirmation pending");
    expect(Array.from(container!.querySelectorAll("button[data-plan-code]")).every(b=>(b as HTMLButtonElement).disabled)).toBe(true);
    expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
    const q:any={select:vi.fn(()=>q),eq:vi.fn(()=>q),maybeSingle:vi.fn(async()=>({data:{status:"paid"}}))};mockFrom.mockReturnValue(q);
    const previousKey=process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID="rzp_live_fixture";
    await act(async()=>{(Array.from(container!.querySelectorAll("button")).find(b=>b.textContent==="Check payment status") as HTMLButtonElement).click()});
    expect(q.eq).toHaveBeenCalledWith("mode","live");expect(q.eq).toHaveBeenCalledWith("user_id","recovery-user");
    expect(container!.textContent).not.toContain("Payment confirmation pending");expect(sessionStorage.getItem("cm_pending_payment:recovery-user")).toBeNull();
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID=previousKey;
  });

  it("rebinds recovery on auth identity update and ignores old checkout callbacks",async()=>{
    process.env.NEXT_PUBLIC_BILLING_ENABLED="true";
    let opts:any;
    mockHandleProCheckout.mockImplementation(async(o:any)=>{opts=o});
    mockGetSession.mockResolvedValue({data:{session:{user:{id:"account-a"}}}});
    await mountPage();
    await act(async()=>{(container!.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement).click()});
    await act(async()=>{opts.onPending({orderId:"order_a",paymentId:"pay_a",retry:async()=>{}})});
    expect(container!.textContent).toContain("order_a");
    mockGetSession.mockResolvedValue({data:{session:{user:{id:"account-b"}}}});
    await act(async()=>{window.dispatchEvent(new Event("careermonke_auth_updated"));await Promise.resolve();await Promise.resolve()});
    expect(container!.textContent).not.toContain("order_a");
    await act(async()=>{opts.onPending({orderId:"order_a_stale",paymentId:"pay_a",retry:async()=>{}})});
    expect(container!.textContent).not.toContain("order_a_stale");
    expect(sessionStorage.getItem("cm_pending_payment:account-b")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("cm_pending_payment:account-a")!).orderId).toBe("order_a");
  });

  it("does not allow immediate Buy while cold auth/recovery initialization is unresolved",async()=>{
    process.env.NEXT_PUBLIC_BILLING_ENABLED="true";
    sessionStorage.setItem("cm_pending_payment:cold-user",JSON.stringify({orderId:"order_cold",paymentId:"pay_cold"}));
    let finish!: (v:any)=>void;
    mockGetSession.mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockResolvedValue({data:{session:{user:{id:"cold-user"}}}});
    await mountPage();
    const buy=container!.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement;
    expect(buy.disabled).toBe(true);
    await act(async()=>{buy.click()});expect(mockHandleProCheckout).not.toHaveBeenCalled();
    await act(async()=>{finish({data:{session:{user:{id:"cold-user"}}}});await Promise.resolve()});
    expect(container!.textContent).toContain("order_cold");expect(buy.disabled).toBe(true);
    expect(mockHandleProCheckout).not.toHaveBeenCalled();
  });

  describe("Flag OFF (Payments strictly OFF)", () => {
    it("keeps plan cards disabled with 'Upgrade' text and a payments-unavailable note when flag is undefined", async () => {
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

      // One payments-unavailable note per card, and no "coming soon" wording anywhere
      expect(container?.textContent?.split("Payments are currently unavailable.").length).toBe(4);
      expect(container?.textContent).not.toMatch(/coming soon|opening soon|open soon/i);

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
      expect(container?.textContent).toContain("Payments are currently unavailable.");
      expect(container?.textContent).not.toMatch(/coming soon|opening soon|open soon/i);
    });
  });

  describe("Flag ON (Payments ON: NEXT_PUBLIC_BILLING_ENABLED=true)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
    });

    it("renders active Buy buttons for all plans (Buy Weekly, Buy Monthly, Buy Quarterly) and only job-listing content", async () => {
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const buyButtons = container ? Array.from(container.querySelectorAll("button[data-plan-code]")) : [];
      // One responsive card grid: one Buy button per plan
      expect(buyButtons.length).toBe(3);

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

      const text = container?.textContent || "";
      expect(text).not.toContain("Payments are currently unavailable.");
      expect(text).not.toMatch(/coming soon|opening soon|open soon/i);

      // Only job-listing content: no add-ons, comparison table, Free strip or AI tool rows
      expect(container?.querySelectorAll("button[data-addon-code]").length).toBe(0);
      for (const removed of ["Add-on Packs", "All features included in Premium", "Free Plan", "AI resume", "cover letter", "match score"]) {
        expect(text).not.toContain(removed);
      }
      expect(container?.querySelectorAll("[data-plan-card]").length).toBe(3);
      expect(text.split("Unlimited browsing of verified unindexed remote jobs").length).toBe(4);
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
      expect(planButtons.length).toBe(3);
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

    it("shared lock stays held after handleProCheckout resolves until dismiss/success fires, then buttons re-enable", async () => {
      let capturedCallbacks: { onSuccess?: () => void; onDismiss?: () => void; onError?: (err: string) => void } = {};

      // Real contract: handleProCheckout resolves as soon as rzp.open() is called,
      // passing lifecycle callbacks to the modal.
      mockHandleProCheckout.mockImplementation(async (options: any) => {
        capturedCallbacks = {
          onSuccess: options.onSuccess,
          onDismiss: options.onDismiss,
          onError: options.onError,
        };
        return Promise.resolve(); // Resolves immediately after modal opens
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
      const weeklyBtn = container?.querySelector("button[data-plan-code='weekly']") as HTMLButtonElement;
      const quarterlyBtn = container?.querySelector("button[data-plan-code='quarterly']") as HTMLButtonElement;

      expect(monthlyBtn).toBeTruthy();
      expect(weeklyBtn).toBeTruthy();
      expect(quarterlyBtn).toBeTruthy();

      // Click 1: Buy Monthly
      await act(async () => {
        monthlyBtn.click();
      });

      // handleProCheckout has resolved (returned)
      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);

      // Even though handleProCheckout resolved, modal is still open, so lock must REMAIN held
      // and ALL plan buy buttons must remain disabled!
      expect(monthlyBtn.disabled).toBe(true);
      expect(weeklyBtn.disabled).toBe(true);
      expect(quarterlyBtn.disabled).toBe(true);

      // Click 2: Click Buy Quarterly while modal is open (after helper resolved)
      await act(async () => {
        quarterlyBtn.click();
      });

      // Starts nothing! handleProCheckout still called only once
      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);
      expect(monthlyBtn.disabled).toBe(true);
      expect(weeklyBtn.disabled).toBe(true);
      expect(quarterlyBtn.disabled).toBe(true);

      // Click 3: Click weekly button while modal is open
      await act(async () => {
        weeklyBtn.click();
      });
      expect(mockHandleProCheckout).toHaveBeenCalledTimes(1);

      // Now terminal callback fires: user dismisses modal (or payment finishes)
      await act(async () => {
        capturedCallbacks.onDismiss?.();
      });

      // Lock is released and all buttons re-enable!
      expect(monthlyBtn.disabled).toBe(false);
      expect(weeklyBtn.disabled).toBe(false);
      expect(quarterlyBtn.disabled).toBe(false);
    });

    it("releases lock on early-exit errors (thrown exceptions before modal opens, order failures, and signed-out visitors)", async () => {
      // 1. Error thrown before modal opens
      mockHandleProCheckout.mockRejectedValueOnce(new Error("503 Service Unavailable"));
      mockGetSession.mockResolvedValue({
        data: {
          session: {
            user: { id: "test-user-id", email: "candidate@gmail.com" },
          },
        },
      });

      await mountPage();

      const monthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      const quarterlyBtn = container?.querySelector("button[data-plan-code='quarterly']") as HTMLButtonElement;

      await act(async () => {
        monthlyBtn.click();
      });

      // Thrown exception caught in catch block -> lock is released
      expect(monthlyBtn.disabled).toBe(false);
      expect(quarterlyBtn.disabled).toBe(false);

      // 2. Order failure via onError callback
      mockHandleProCheckout.mockImplementationOnce(async (options: any) => {
        options.onError?.("403 Account Suspended");
        return Promise.resolve();
      });

      await act(async () => {
        monthlyBtn.click();
      });

      // onError callback releases the lock
      expect(monthlyBtn.disabled).toBe(false);
      expect(quarterlyBtn.disabled).toBe(false);

      // 3. Signed-out visitor early exit: remount with unauthenticated session
      mockGetSession.mockResolvedValue({
        data: { session: null },
      });

      await mountPage();

      const unauthMonthlyBtn = container?.querySelector("button[data-plan-code='monthly']") as HTMLButtonElement;
      const unauthQuarterlyBtn = container?.querySelector("button[data-plan-code='quarterly']") as HTMLButtonElement;

      await act(async () => {
        unauthMonthlyBtn.click();
      });

      // Unauthenticated early exit releases the lock
      expect(unauthMonthlyBtn.disabled).toBe(false);
      expect(unauthQuarterlyBtn.disabled).toBe(false);
    });
  });
});
