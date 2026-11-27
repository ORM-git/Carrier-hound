// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "fs";
import BillingAccessSummary from "../BillingAccessSummary";
afterEach(cleanup);
it("describes active access without claiming a payment, price or recurring interval", () => {
  render(<BillingAccessSummary isPro />);
  const summary = screen.getByTestId("billing-access-summary");
  expect(summary.textContent).toContain("Pro access is active");
  expect(summary.textContent).toContain("Payment amounts and confirmation status are shown in Payment history");
  expect(summary.textContent).not.toMatch(/₹|INR|\$|paid|\/\s*(week|month|quarter)|renews/i);
});
it("keeps the existing Free tier explanation", () => {
  render(<BillingAccessSummary isPro={false} />);
  expect(screen.getByTestId("billing-access-summary").textContent).toBe("Standard title browsing, 5 tracker slots, 1 ATS resume export.");
});
it("Settings uses access-only summary without deriving prices from subscription or catalog and retains history", () => {
  const settings = readFileSync("src/app/settings/page.tsx", "utf8");
  expect(settings).toContain("<BillingAccessSummary isPro={isPro} />");
  expect(settings).toContain("<PaymentHistory userId={user.id} />");
  for (const removed of ["formattedPlanText", "planPriceNumber", "subscription?.amount", "PLAN_DEFINITIONS", "planInterval"]) expect(settings).not.toContain(removed);
});
