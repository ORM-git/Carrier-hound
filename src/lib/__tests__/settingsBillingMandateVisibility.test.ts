import { describe, it, expect } from "vitest";

// Extracted exact predicate logic matching src/app/settings/page.tsx
function evaluateSettingsBillingState(subscription: any) {
  const mandateSubId =
    subscription?.subscriptionId ||
    (subscription?.metadata as any)?.provider_subscription_id ||
    (subscription?.metadata as any)?.pending_subscription_id;

  const isRecurringMandate =
    subscription?.provider === "razorpay" &&
    typeof mandateSubId === "string" &&
    mandateSubId.startsWith("sub_") &&
    !mandateSubId.startsWith("sub_pending_");

  const isPro = subscription?.status === "active";

  const subStatus = (subscription?.status as string) || "";
  const hasActiveMandateWithoutPro = Boolean(
    !isPro &&
    isRecurringMandate &&
    !subscription?.cancelAtPeriodEnd &&
    subStatus !== "canceled" &&
    subStatus !== "expired" &&
    subStatus !== "none" &&
    (subStatus === "past_due" ||
      subStatus === "unpaid" ||
      subStatus === "incomplete" ||
      subStatus === "created")
  );

  const showMandateSection = isPro || hasActiveMandateWithoutPro;
  const showCancelButton =
    showMandateSection &&
    ((isPro && isRecurringMandate) || hasActiveMandateWithoutPro) &&
    !subscription?.cancelAtPeriodEnd;

  let mandateStatusText: string | null = null;
  if (showMandateSection) {
    if (isPro) {
      if (subscription?.currentPeriodEnd) {
        mandateStatusText = isRecurringMandate
          ? subscription?.cancelAtPeriodEnd
            ? " (auto-renew canceled)"
            : " (auto-renews)"
          : " (does not auto-renew)";
      } else {
        mandateStatusText = isRecurringMandate
          ? subscription?.cancelAtPeriodEnd
            ? " (auto-renew canceled)"
            : " (auto-renews)"
          : " (does not auto-renew)";
      }
    } else {
      if (subscription?.status === "past_due") {
        mandateStatusText = `Payment past due${subscription?.cancelAtPeriodEnd ? " (auto-renew canceled)" : " (auto-renews)"}`;
      } else if (subscription?.status === "unpaid") {
        mandateStatusText = `Payment unpaid${subscription?.cancelAtPeriodEnd ? " (auto-renew canceled)" : " (auto-renews)"}`;
      } else {
        mandateStatusText = `Mandate pending confirmation${subscription?.cancelAtPeriodEnd ? " (auto-renew canceled)" : " (auto-renews)"}`;
      }
    }
  }

  return {
    isPro,
    isRecurringMandate,
    hasActiveMandateWithoutPro,
    showMandateSection,
    showCancelButton,
    mandateStatusText,
  };
}

describe("Settings > Billing & Plans Mandate Visibility Guard", () => {
  it("hides status line and cancel button for Free-plan user with null subscription", () => {
    const res = evaluateSettingsBillingState(null);
    expect(res.isPro).toBe(false);
    expect(res.showMandateSection).toBe(false);
    expect(res.showCancelButton).toBe(false);
    expect(res.mandateStatusText).toBe(null);
  });

  it("hides status line and cancel button for Free-plan user with canceled subscription", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_1",
      provider: "razorpay",
      subscriptionId: "sub_rzp_prior_canceled_123",
      status: "canceled",
      cancelAtPeriodEnd: true,
    });
    expect(res.isPro).toBe(false);
    expect(res.showMandateSection).toBe(false);
    expect(res.showCancelButton).toBe(false);
    expect(res.mandateStatusText).toBe(null);
  });

  it("hides status line and cancel button for Free-plan user with expired subscription", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_2",
      provider: "razorpay",
      subscriptionId: "sub_rzp_expired_123",
      status: "expired",
      cancelAtPeriodEnd: false,
    });
    expect(res.isPro).toBe(false);
    expect(res.showMandateSection).toBe(false);
    expect(res.showCancelButton).toBe(false);
  });

  it("hides status line and cancel button for Free-plan user with status none", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_3",
      provider: "manual",
      status: "none",
    });
    expect(res.isPro).toBe(false);
    expect(res.showMandateSection).toBe(false);
    expect(res.showCancelButton).toBe(false);
  });

  it("shows status line and cancel button for Free-plan user with REAL active pending mandate", () => {
    const res = evaluateSettingsBillingState({
      id: "order_row_1",
      provider: "razorpay",
      subscriptionId: "sub_rzp_real_active_mandate_456",
      status: "incomplete",
      cancelAtPeriodEnd: false,
    });
    expect(res.isPro).toBe(false);
    expect(res.hasActiveMandateWithoutPro).toBe(true);
    expect(res.showMandateSection).toBe(true);
    expect(res.showCancelButton).toBe(true);
    expect(res.mandateStatusText).toBe("Mandate pending confirmation (auto-renews)");
  });

  it("shows status line and cancel button for Free-plan user with past_due active mandate", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_4",
      provider: "razorpay",
      subscriptionId: "sub_rzp_past_due_mandate_789",
      status: "past_due",
      cancelAtPeriodEnd: false,
    });
    expect(res.isPro).toBe(false);
    expect(res.hasActiveMandateWithoutPro).toBe(true);
    expect(res.showMandateSection).toBe(true);
    expect(res.showCancelButton).toBe(true);
    expect(res.mandateStatusText).toBe("Payment past due (auto-renews)");
  });

  it("preserves prepaid Pro layout with does not auto-renew and no cancel button", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_5",
      provider: "razorpay",
      subscriptionId: "order_rzp_prepaid_999",
      status: "active",
      currentPeriodEnd: "2026-12-15T00:00:00.000Z",
    });
    expect(res.isPro).toBe(true);
    expect(res.showMandateSection).toBe(true);
    expect(res.showCancelButton).toBe(false);
    expect(res.mandateStatusText).toBe(" (does not auto-renew)");
  });

  it("preserves recurring active Pro layout with auto-renews and active cancel button", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_6",
      provider: "razorpay",
      subscriptionId: "sub_rzp_recurring_active_888",
      status: "active",
      currentPeriodEnd: "2026-12-15T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    });
    expect(res.isPro).toBe(true);
    expect(res.showMandateSection).toBe(true);
    expect(res.showCancelButton).toBe(true);
    expect(res.mandateStatusText).toBe(" (auto-renews)");
  });

  it("preserves canceled recurring Pro layout with auto-renew canceled and no cancel button", () => {
    const res = evaluateSettingsBillingState({
      id: "sub_row_7",
      provider: "razorpay",
      subscriptionId: "sub_rzp_recurring_canceled_777",
      status: "active",
      currentPeriodEnd: "2026-12-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    });
    expect(res.isPro).toBe(true);
    expect(res.showMandateSection).toBe(true);
    expect(res.showCancelButton).toBe(false);
    expect(res.mandateStatusText).toBe(" (auto-renew canceled)");
  });
});
