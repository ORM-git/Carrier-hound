"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import Footer from "@/components/Footer";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLANS,
  type PlanConfig,
  PAID_PLANS_DISPLAY_ORDER,
  FREE_TIER_CONFIG,
  getPlanBillingLabel,
  getPlanPerWeekText,
  formatPriceINR,
  ADD_ON_PACKS_NOTE,
  REFUND_POLICY_NOTE,
  FAIR_USE_LIMIT_NOTE,
  PER_WEEK_NOTE,
  UPGRADE_BUTTON_LABEL,
} from "@/config/plans";
import { PLAN_FEATURE_ROWS } from "@/config/plan-features";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";

export default function PricingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<PlanConfig["id"]>("monthly");

  useEffect(() => {
    let mounted = true;
    const checkAuthAndPro = async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!mounted) return;

        if (session?.user) {
          setUser(session.user);
          const proStatus = await getProAccessStatus(session.user.id);
          if (!mounted) return;
          setIsPro(proStatus.isPro);
        }
      } catch (err) {
        console.warn("[Pricing] Auth / Pro check failed:", err);
      }
    };

    checkAuthAndPro();

    const handleProUpdated = () => {
      getProAccessStatus().then((res) => setIsPro(res.isPro));
    };
    window.addEventListener("careermonke_pro_updated", handleProUpdated);
    window.addEventListener("careermonke_auth_updated", handleProUpdated);

    return () => {
      mounted = false;
      window.removeEventListener("careermonke_pro_updated", handleProUpdated);
      window.removeEventListener("careermonke_auth_updated", handleProUpdated);
    };
  }, []);

  // Razorpay order verification handler (payments stay strictly OFF)
  const handleInitiateCheckout = async () => {
    // Payments stay strictly OFF until stage 2 live activation
    const isBillingEnabled = process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";
    if (!isBillingEnabled) {
      console.log("[Pricing] Pro launching soon - payments are disabled.");
      return;
    }

    try {
      const res = await fetch("/api/billing/razorpay/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: selectedPlanId }),
      });
      if (!res.ok) {
        throw new Error("Checkout is unavailable right now, please try again later.");
      }
      console.log("Test payment successful (no Pro granted)");
    } catch (err) {
      console.error(err);
    }
  };

  const handleSelectPlan = (planId: PlanConfig["id"]) => {
    setSelectedPlanId(planId);
  };

  const paidPlansToDisplay = PAID_PLANS_DISPLAY_ORDER.map(
    (id) => PLANS.find((p) => p.id === id)!
  );

  const handleKeyDownPlan = (
    e: React.KeyboardEvent<HTMLDivElement>,
    planId: PlanConfig["id"]
  ) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setSelectedPlanId(planId);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const currentIndex = paidPlansToDisplay.findIndex((p) => p.id === planId);
      const nextPlan = paidPlansToDisplay[(currentIndex + 1) % paidPlansToDisplay.length];
      setSelectedPlanId(nextPlan.id);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const currentIndex = paidPlansToDisplay.findIndex((p) => p.id === planId);
      const prevPlan = paidPlansToDisplay[(currentIndex - 1 + paidPlansToDisplay.length) % paidPlansToDisplay.length];
      setSelectedPlanId(prevPlan.id);
    }
  };

  const pricingContent = (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 flex flex-col items-center p-tk-4 sm:p-tk-3 gap-tk-4 sm:gap-tk-3 space-y-tk-4 sm:space-y-tk-3">
      {/* 1. Centered Page Header */}
      <div className="text-center space-y-2 mb-6 sm:mb-10 max-w-3xl mx-auto">
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-[#090E34] dark:text-white tracking-tight">
          Get more interviews with CareerMonke Premium
        </h1>
        <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed max-w-2xl mx-auto">
          Stronger resumes + faster applications tailored to verified unindexed remote roles.
        </p>

      </div>

      {/* 2 & 3. Main Jobright-Turbo-Style Layout: Left Big Rounded Card (3 Tiles + Table) + Right Grey Panel */}
      <div className="w-full">
        {/* DESKTOP VIEW: Unified Table Layout guaranteeing row-by-row alignment */}
        <div className="hidden lg:block w-full">
          <table className="w-full border-separate border-spacing-0">
            <tbody>
              {/* TOP ROW: Left White Card Top (3 Tiles + Title) & Right Grey Free Plan Header */}
              <tr>
                {/* Left Cell: White rounded card containing the three plan tiles */}
                <td className="w-[74%] bg-white dark:bg-slate-950 rounded-t-2xl border-t border-l border-r border-slate-200 dark:border-slate-800 p-6 sm:p-7 align-top shadow-xs">
                  {/* Three Plan Tiles Side-by-Side: Weekly, Monthly, Quarterly */}
                  <div
                    role="radiogroup"
                    aria-label="Subscription plans"
                    className="grid grid-cols-3 gap-3.5"
                  >
                    {paidPlansToDisplay.map((plan) => {
                      const isSelected = selectedPlanId === plan.id;
                      const perWeekText = getPlanPerWeekText(plan);
                      const billingLine =
                        plan.interval === "month"
                          ? "billed monthly"
                          : plan.interval === "quarter"
                          ? "billed every 3 months"
                          : "billed weekly";

                      return (
                        <div
                          key={plan.id}
                          role="radio"
                          aria-checked={isSelected}
                          tabIndex={0}
                          onClick={() => handleSelectPlan(plan.id)}
                          onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
                          className={cnTokens(
                            "relative flex flex-col justify-between rounded-xl p-4 sm:p-5 transition-colors cursor-pointer select-none min-h-[220px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2",
                            isSelected
                              ? "border-2 border-[#2563EB] bg-blue-50/20 dark:bg-blue-950/20 shadow-xs"
                              : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-slate-300 dark:hover:border-slate-700"
                          )}
                        >
                          <div>
                            {/* Plan Name */}
                            <div className="mb-2">
                              <span className="text-lg font-bold text-[#090E34] dark:text-white">
                                {plan.name}
                              </span>
                            </div>

                            {/* Big Price from Config */}
                            <div className="my-1">
                              <span className="text-3xl font-black text-[#090E34] dark:text-white tracking-tight">
                                {formatPriceINR(plan.price)}
                              </span>
                            </div>

                            {/* Billing Line */}
                            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                              {billingLine}
                            </p>

                            {/* Per-week Figure */}
                            <p className="text-xs font-semibold text-[#2563EB] dark:text-blue-400 mt-1">
                              {perWeekText}
                            </p>

                            <p className="sr-only">{getPlanBillingLabel(plan)}</p>
                            <p className="sr-only">{plan.subLine}</p>
                          </div>

                          {/* Upgrade Button */}
                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                            {user ? (
                              <button
                                type="button"
                                disabled
                                aria-disabled="true"
                                onClick={handleInitiateCheckout}
                                className={cnTokens(
                                  "w-full min-h-[48px] h-11 rounded-lg font-semibold text-sm flex items-center justify-center transition-colors cursor-not-allowed select-none",
                                  isSelected
                                    ? "bg-[#2563EB] text-white hover:bg-blue-700 shadow-xs"
                                    : "bg-black text-white hover:bg-neutral-800 dark:bg-slate-100 dark:text-slate-900"
                                )}
                              >
                                Upgrade
                              </button>
                            ) : (
                              <Link
                                href="/login"
                                className={cnTokens(
                                  "w-full min-h-[48px] h-11 rounded-lg font-semibold text-sm flex items-center justify-center transition-colors select-none",
                                  isSelected
                                    ? "bg-[#2563EB] text-white hover:bg-blue-700 shadow-xs"
                                    : "bg-black text-white hover:bg-neutral-800 dark:bg-slate-100 dark:text-slate-900"
                                )}
                              >
                                Upgrade
                              </Link>
                            )}
                            <div className="flex justify-center mt-2">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                                {UPGRADE_BUTTON_LABEL}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Footnote right below cards */}
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-3 leading-normal">
                    {PER_WEEK_NOTE}
                  </p>

                  {/* Heading below tiles */}
                  <div className="mt-6 mb-2">
                    <h2 className="text-lg font-bold text-[#090E34] dark:text-white">
                      All features included in Premium
                    </h2>
                  </div>
                </td>

                {/* Right Cell: Grey Free Plan Panel Header */}
                <td className="w-[26%] bg-[#F8F9FA] dark:bg-slate-900/60 rounded-t-2xl border-t border-r border-slate-200 dark:border-slate-800 p-6 sm:p-7 align-top">
                  <div className="flex flex-col justify-between rounded-xl p-4 sm:p-5 border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-xs min-h-[220px]">
                    <div>
                      {/* Plan Name */}
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-lg font-bold text-[#090E34] dark:text-white">
                          Free Plan
                        </span>
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-slate-300 font-bold" aria-hidden="true">
                          i
                        </span>
                      </div>

                      {/* Big Price */}
                      <div className="my-1">
                        <span className="text-3xl font-black text-[#090E34] dark:text-white tracking-tight">
                          ₹0.00
                        </span>
                      </div>

                      {/* Billing Line */}
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                        Free forever
                      </p>

                      {/* Subline */}
                      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">
                        Basic search & masked previews
                      </p>
                    </div>

                    {/* Button container matching paid cards */}
                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                      <div className="w-full min-h-[48px] h-11 rounded-lg font-semibold text-sm flex items-center justify-center select-none bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                        Your current plan
                      </div>
                      <div className="flex justify-center mt-2 invisible" aria-hidden="true">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium">
                          placeholder
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>

              {/* 4. Table Rows: Sourced from Config */}
              {PLAN_FEATURE_ROWS.map((row, idx) => {
                const isLast = idx === PLAN_FEATURE_ROWS.length - 1;

                return (
                  <tr key={idx}>
                    {/* Left Cell: Inside the white card */}
                    <td
                      className={cnTokens(
                        "w-[74%] bg-white dark:bg-slate-950 border-l border-r border-slate-200 dark:border-slate-800 px-6 sm:px-7 py-3 align-middle",
                        isLast
                          ? "rounded-b-2xl border-b border-slate-200 dark:border-slate-800 shadow-xs"
                          : "border-b border-slate-100 dark:border-slate-800/60"
                      )}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm text-[#090E34] dark:text-white shrink-0">
                            {row.name}
                          </span>
                          <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex items-center gap-1">
                            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-300 dark:border-slate-700 text-[10px] text-slate-400">
                              i
                            </span>
                            {row.info}
                          </span>
                        </div>
                        <div className="shrink-0">
                          <span className="inline-flex items-center justify-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-[#2563EB] dark:bg-blue-950/60 dark:text-blue-300 border border-blue-100 dark:border-blue-900/40">
                            {row.premium}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Right Cell: Inside the grey Free Plan panel */}
                    <td
                      className={cnTokens(
                        "w-[26%] bg-[#F8F9FA] dark:bg-slate-900/60 border-r border-slate-200 dark:border-slate-800 px-6 pl-8 py-3 align-middle",
                        isLast
                          ? "rounded-b-2xl border-b border-slate-200 dark:border-slate-800"
                          : "border-b border-slate-200/50 dark:border-slate-800/50"
                      )}
                    >
                      <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                        {row.free}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* MOBILE VIEW (< 1024px): Stacked Tiles + Free Card + Responsive Comparison */}
        <div className="block lg:hidden w-full space-y-6">
          {/* Stacked Plan Tiles */}
          <div
            role="radiogroup"
            aria-label="Subscription plans"
            className="space-y-3.5"
          >
            {paidPlansToDisplay.map((plan) => {
              const isSelected = selectedPlanId === plan.id;
              const perWeekText = getPlanPerWeekText(plan);
              const billingLine =
                plan.interval === "month"
                  ? "billed monthly"
                  : plan.interval === "quarter"
                  ? "billed every 3 months"
                  : "billed weekly";

              return (
                <div
                  key={plan.id}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  onClick={() => handleSelectPlan(plan.id)}
                  onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
                  className={cnTokens(
                    "flex flex-col justify-between rounded-2xl p-5 transition-colors cursor-pointer select-none bg-white dark:bg-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]",
                    isSelected
                      ? "border-2 border-[#2563EB] shadow-xs"
                      : "border border-slate-200 dark:border-slate-800"
                  )}
                >
                  <div>
                    <div className="mb-1">
                      <span className="text-lg font-bold text-[#090E34] dark:text-white">
                        {plan.name}
                      </span>
                    </div>

                    <div className="my-1">
                      <span className="text-3xl font-black text-[#090E34] dark:text-white tracking-tight">
                        {formatPriceINR(plan.price)}
                      </span>
                    </div>

                    <p className="text-xs text-slate-500 font-medium">{billingLine}</p>

                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-semibold text-[#2563EB] dark:text-blue-400">
                        {perWeekText}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                    {user ? (
                      <button
                        type="button"
                        disabled
                        aria-disabled="true"
                        className="w-full min-h-[48px] h-11 rounded-lg bg-[#2563EB] text-white font-semibold text-sm flex items-center justify-center cursor-not-allowed select-none"
                      >
                        Upgrade
                      </button>
                    ) : (
                      <Link
                        href="/login"
                        className="w-full min-h-[48px] h-11 rounded-lg bg-[#2563EB] text-white font-semibold text-sm flex items-center justify-center select-none"
                      >
                        Upgrade
                      </Link>
                    )}
                    <div className="flex justify-center mt-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        {UPGRADE_BUTTON_LABEL}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footnote right below cards */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-2 leading-normal text-center">
            {PER_WEEK_NOTE}
          </p>

          {/* Free Tier Card on Mobile */}
          <div className="flex flex-col justify-between rounded-2xl p-5 bg-[#F8F9FA] dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-xs">
            <div>
              <div className="mb-1">
                <span className="text-lg font-bold text-[#090E34] dark:text-white">
                  Free Plan
                </span>
              </div>

              <div className="my-1">
                <span className="text-3xl font-black text-[#090E34] dark:text-white tracking-tight">
                  ₹0.00
                </span>
              </div>

              <p className="text-xs text-slate-500 font-medium">Free forever</p>

              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Basic search & masked previews
                </span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
              <div className="w-full min-h-[48px] h-11 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-semibold text-sm flex items-center justify-center select-none">
                Your current plan
              </div>
            </div>
          </div>

          {/* Mobile Comparison Table */}
          <div className="bg-white dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs">
            <div className="mb-3">
              <h2 className="text-base font-bold text-[#090E34] dark:text-white">
                All features included in Premium
              </h2>
            </div>

            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full text-left border-collapse min-w-[500px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="py-2.5 px-3">Feature</th>
                    <th className="py-2.5 px-3 text-center">Free</th>
                    <th className="py-2.5 px-3 text-center">Premium</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {PLAN_FEATURE_ROWS.map((row, idx) => (
                    <tr key={idx}>
                      <td className="py-2.5 px-3">
                        <span className="font-semibold text-[#090E34] dark:text-white block">
                          {row.name}
                        </span>
                        <span className="text-[11px] text-slate-500 block mt-0.5">
                          {row.info}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle text-slate-600">
                        {row.free}
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle">
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-[#2563EB]">
                          {row.premium}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Under the table: Notes, Final-sale, and Footnote */}
      <div className="w-full max-w-3xl mx-auto mt-8 px-4 text-center space-y-4">
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800">
          <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 font-medium leading-relaxed">
            Add-on packs ₹149/₹399/₹699 · 10/30/60 extra generations. Extra generations on any plan: burn only after the plan quota is used, 60-day validity, daily limit still applies. Final-sale.
          </p>
        </div>

        <div className="pt-2 text-center space-y-2 text-xs text-slate-500 dark:text-slate-400">
          <p className="font-bold text-[#090E34] dark:text-white">All sales final · no refunds</p>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <Link
              href="/terms-and-conditions"
              className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors"
            >
              Terms &amp; Conditions
            </Link>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
            <Link
              href="/privacy-policy"
              className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors"
            >
              Privacy Policy
            </Link>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
            <Link
              href="/refund-policy"
              className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors"
            >
              Cancellation &amp; Refund Policy
            </Link>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
            <Link
              href="/contact"
              className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <LoggedInAppShell pageLabel="PRICING" user={user} isPro={isPro}>
  <BreadcrumbJsonLd trail={[{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }]} />
      {pricingContent}
      <Footer />
    </LoggedInAppShell>
  );
}
