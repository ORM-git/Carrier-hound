"use client";

import React, { useState, useEffect } from "react";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import Footer from "@/components/Footer";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLANS,
  type PlanConfig,
  PAID_PLANS_DISPLAY_ORDER,
  FREE_TIER_CONFIG,
  PLAN_COMPARISON_ROWS,
  getPlanBillingLabel,
  getPlanPerWeekText,
  formatPriceINR,
  ADD_ON_PACKS_NOTE,
  REFUND_POLICY_NOTE,
  FAIR_USE_LIMIT_NOTE,
  PER_WEEK_NOTE,
  UPGRADE_BUTTON_LABEL,
} from "@/config/plans";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { Check, X } from "lucide-react";

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
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 flex flex-col items-center">
      {/* 1. Centered Page Header */}
      <div className="text-center space-y-2 mb-6 sm:mb-10 max-w-3xl mx-auto">
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-ink tracking-tight">
          Get Direct Unindexed Remote Roles with{" "}
          <span className="text-[#00C4FE]">CAREERMONKE PREMIUM</span>
        </h1>
        <p className="text-sm sm:text-base text-ink-muted leading-relaxed max-w-2xl mx-auto">
          Accelerate your remote job search with unmasked direct employer listings + Tailored resumes + Cover letters
        </p>
      </div>

      {/* 2. Main Jobright-Style Unified Pricing Panel */}
      <div className="w-full bg-[#F8F9FA] dark:bg-slate-900/60 rounded-[32px] border border-slate-200/90 dark:border-slate-800 p-4 sm:p-6 lg:p-8 shadow-xs">
        
        {/* DESKTOP VIEW: Unified Table Layout matching the Jobright Reference */}
        <div className="hidden lg:block w-full">
          <table className="w-full border-separate border-spacing-0">
            <tbody>
              {/* TOP ROW: 3 Paid Cards (inside white panel on left) + Free Plan Header (on right) */}
              <tr>
                {/* Left Cell: White rounded top container for the 3 paid cards */}
                <td className="w-[74%] bg-white dark:bg-slate-950 rounded-t-2xl border-t border-l border-r border-slate-200/90 dark:border-slate-800 p-6 sm:p-7 align-top shadow-xs">
                  {/* Top Pill / Subtitle */}
                  <div className="flex items-center justify-between mb-5">
                    <div className="inline-flex items-center p-1 rounded-full bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-semibold">
                      <span className="px-4 py-1 rounded-full bg-black text-white shadow-xs">Standard</span>
                      <span className="px-4 py-1 text-slate-500">Pick your plan</span>
                    </div>
                    {isPro && (
                      <span className="inline-flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300">
                        Current Plan
                      </span>
                    )}
                  </div>

                  {/* 3 Paid Cards in One Desktop Row */}
                  <div
                    role="radiogroup"
                    aria-label="Subscription plans"
                    className="grid grid-cols-3 gap-3.5"
                  >
                    {paidPlansToDisplay.map((plan) => {
                      const isSelected = selectedPlanId === plan.id;
                      const perWeekText = getPlanPerWeekText(plan);
                      const billingLabel = getPlanBillingLabel(plan);

                      return (
                        <div
                          key={plan.id}
                          role="radio"
                          aria-checked={isSelected}
                          tabIndex={0}
                          onClick={() => handleSelectPlan(plan.id)}
                          onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
                          className={cnTokens(
                            "relative flex flex-col justify-between rounded-xl p-4 sm:p-5 transition-all cursor-pointer select-none min-h-[220px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2",
                            isSelected
                              ? "border-2 border-slate-900 dark:border-slate-100 ring-2 ring-slate-900/10 shadow-sm bg-slate-50/50 dark:bg-slate-900/40"
                              : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 hover:border-slate-300 dark:hover:border-slate-700"
                          )}
                        >
                          <div>
                            {/* Card Top: Plan Name & Badge */}
                            <div className="flex items-center justify-between gap-1.5 mb-2">
                              <span className="text-base font-bold text-slate-900 dark:text-slate-100">
                                {plan.name}
                              </span>
                              <div className="flex items-center gap-1">
                                {plan.savingsBadge && (
                                  <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-slate-200 dark:border-slate-800 text-slate-500 bg-slate-50 dark:bg-slate-900">
                                    {plan.savingsBadge}
                                  </span>
                                )}
                                {plan.badge && (
                                  <span className="inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900">
                                    {plan.badge}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Strike-through Reference Price */}
                            <div className="min-h-[18px]">
                              {plan.originalPrice ? (
                                <span className="line-through text-slate-400 text-xs font-medium">
                                  {formatPriceINR(plan.originalPrice)}
                                  {plan.interval === "week" ? "/week" : plan.interval === "month" ? "/1 month" : "/3 months"}
                                </span>
                              ) : (
                                <span className="text-slate-400 text-xs font-medium">
                                  Standard rate
                                </span>
                              )}
                            </div>

                            {/* Main Billed Price */}
                            <div className="my-1.5">
                              <div className="flex items-baseline gap-1">
                                <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-slate-100 tracking-tight">
                                  {formatPriceINR(plan.price)}
                                </span>
                                <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                                  /{plan.interval === "week" ? "week" : plan.interval === "month" ? "1 month" : "3 months"}
                                </span>
                              </div>
                              <p className="sr-only">{billingLabel}</p>
                            </div>

                            {/* Equivalent weekly comparison */}
                            {plan.interval !== "week" ? (
                              <div className="mb-1">
                                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                  {perWeekText}
                                </span>
                              </div>
                            ) : (
                              <div className="mb-1">
                                <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                                  {perWeekText}
                                </span>
                              </div>
                            )}

                            {/* Plan Subline / Terms */}
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                              {plan.subLine}
                            </p>
                          </div>

                          {/* Action Button inside Card */}
                          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                            <button
                              type="button"
                              disabled
                              aria-disabled="true"
                              className={cnTokens(
                                "w-full min-h-[48px] h-10 rounded-lg font-semibold text-xs flex items-center justify-center transition-colors cursor-not-allowed select-none",
                                isSelected
                                  ? "bg-black text-white hover:bg-neutral-800 dark:bg-slate-100 dark:text-slate-950"
                                  : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                              )}
                            >
                              {UPGRADE_BUTTON_LABEL}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Section Heading below Cards */}
                  <div className="mt-8 mb-2 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                      Compare Plans: All features included in{" "}
                      <span className="text-[#00C4FE] font-black">CAREERMONKE PREMIUM</span>
                    </h2>
                  </div>
                </td>

                {/* Right Cell: Free Plan Header directly on grey container */}
                <td className="w-[26%] align-top p-6 pl-8">
                  <div className="flex items-center justify-between gap-1.5 mb-1">
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">Free Plan</h2>
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-600 dark:text-slate-300 font-bold" aria-hidden="true">
                        i
                      </span>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Basic Tier
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mb-3">{FREE_TIER_CONFIG.name}</p>

                  {/* Price */}
                  <div className="my-3">
                    <span className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-slate-100">
                      ₹0.00
                    </span>
                  </div>

                  {/* Button */}
                  <div className="mb-4">
                    <span className="block w-full py-2 px-3 text-center rounded-lg bg-[#D1FADF] text-[#027A48] font-bold text-xs sm:text-sm">
                      {!isPro ? "Your Current Plan" : "Basic Tier Included"}
                    </span>
                  </div>
                </td>
              </tr>

              {/* ROWS 1..N: Feature Comparison Rows */}
              {PLAN_COMPARISON_ROWS.map((row, idx) => {
                const isLast = idx === PLAN_COMPARISON_ROWS.length - 1;
                return (
                  <tr key={idx}>
                    {/* Left Cell: Inside the continuous white card */}
                    <td
                      className={cnTokens(
                        "w-[74%] bg-white dark:bg-slate-950 border-l border-r border-slate-200/90 dark:border-slate-800 px-6 sm:px-7 py-3 align-middle",
                        isLast
                          ? "rounded-b-2xl border-b border-slate-200/90 dark:border-slate-800 shadow-xs"
                          : "border-b border-slate-100 dark:border-slate-800/60"
                      )}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 shrink-0">
                            {row.feature}
                          </span>
                          <span className="text-xs text-slate-400 dark:text-slate-500 truncate flex items-center gap-1">
                            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-300 dark:border-slate-700 text-[10px] text-slate-400">
                              i
                            </span>
                            {row.description}
                          </span>
                        </div>
                        <div className="shrink-0">
                          <span
                            className={cnTokens(
                              "inline-flex items-center justify-center px-3 py-1 rounded-full text-xs font-bold",
                              row.isUpcoming
                                ? "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300"
                                : "bg-[#D1FADF] text-[#027A48] dark:bg-emerald-950/60 dark:text-emerald-300"
                            )}
                          >
                            {row.isUpcoming ? (
                              "Coming soon"
                            ) : row.premium === true ? (
                              "✓"
                            ) : (
                              row.premium
                            )}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Right Cell: Free Plan Value aligned with the row */}
                    <td className="w-[26%] px-6 pl-8 py-3 align-middle border-b border-slate-200/50 dark:border-slate-800/50">
                      {row.free === true ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">
                          ✓
                        </span>
                      ) : row.free === false ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-100/70 text-rose-500 text-xs font-bold">
                          ✕
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                          {row.free}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* MOBILE VIEW (< 1024px): Stacked Paid Cards + Free Card + Responsive Table */}
        <div className="block lg:hidden w-full space-y-6">
          {/* Top Pill / Subtitle */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Pick your plan
            </span>
            {isPro && (
              <span className="inline-flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                Current Plan
              </span>
            )}
          </div>

          {/* Paid Plan Cards Stacked */}
          <div
            role="radiogroup"
            aria-label="Subscription plans"
            className="space-y-3.5"
          >
            {paidPlansToDisplay.map((plan) => {
              const isSelected = selectedPlanId === plan.id;
              const perWeekText = getPlanPerWeekText(plan);
              const billingLabel = getPlanBillingLabel(plan);

              return (
                <div
                  key={plan.id}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  onClick={() => handleSelectPlan(plan.id)}
                  onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
                  className={cnTokens(
                    "flex flex-col justify-between rounded-2xl p-5 transition-all cursor-pointer select-none bg-white dark:bg-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]",
                    isSelected
                      ? "border-2 border-slate-900 dark:border-slate-100 shadow-sm ring-1 ring-slate-900/10"
                      : "border border-slate-200 dark:border-slate-800"
                  )}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-lg font-bold text-slate-900 dark:text-slate-100">
                        {plan.name}
                      </span>
                      <div className="flex items-center gap-1">
                        {plan.savingsBadge && (
                          <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-slate-200 text-slate-500 bg-slate-50">
                            {plan.savingsBadge}
                          </span>
                        )}
                        {plan.badge && (
                          <span className="inline-flex items-center text-xs font-bold px-2 py-0.5 rounded-full border border-slate-300 text-slate-800 bg-white">
                            {plan.badge}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-baseline gap-1 my-1">
                      <span className="text-3xl font-black text-slate-900 dark:text-slate-100 tracking-tight">
                        {formatPriceINR(plan.price)}
                      </span>
                      <span className="text-xs text-slate-500 font-medium">
                        /{plan.interval === "week" ? "week" : plan.interval === "month" ? "1 month" : "3 months"}
                      </span>
                    </div>

                    <p className="sr-only">{billingLabel}</p>

                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                        {perWeekText}
                      </span>
                      <span className="text-xs text-slate-400">•</span>
                      <span className="text-xs text-slate-500">
                        {plan.subLine}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="w-full min-h-[48px] h-11 rounded-lg bg-black text-white font-semibold text-sm flex items-center justify-center cursor-not-allowed select-none"
                    >
                      {UPGRADE_BUTTON_LABEL}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Free Tier Card on Mobile */}
          <div className="bg-white dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-base font-bold text-slate-900 dark:text-slate-100">
                {FREE_TIER_CONFIG.name}
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Basic Tier
              </span>
            </div>
            <div className="my-2">
              <span className="text-3xl font-black text-slate-900 dark:text-slate-100">
                ₹0.00
              </span>
            </div>
            <span className="block w-full py-2 px-3 text-center rounded-lg bg-[#D1FADF] text-[#027A48] font-bold text-xs">
              {!isPro ? "Your Current Plan" : "Basic Tier Included"}
            </span>
          </div>

          {/* Mobile Comparison Table with Horizontal Scroll */}
          <div className="bg-white dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs">
            <div className="mb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Compare Plans: All features included in{" "}
                <span className="text-[#00C4FE] font-black">CAREERMONKE PREMIUM</span>
              </h2>
            </div>

            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full text-left border-collapse min-w-[520px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="py-2.5 px-3">Feature</th>
                    <th className="py-2.5 px-3 text-center">Free</th>
                    <th className="py-2.5 px-3 text-center">CareerMonke Premium</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {PLAN_COMPARISON_ROWS.map((row, idx) => (
                    <tr key={idx}>
                      <td className="py-2.5 px-3">
                        <span className="font-semibold text-slate-900 dark:text-slate-100 block">
                          {row.feature}
                        </span>
                        <span className="text-[11px] text-slate-400 block mt-0.5">
                          {row.description}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle">
                        {row.free === true ? (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">
                            ✓
                          </span>
                        ) : row.free === false ? (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-100/70 text-rose-500 text-[10px] font-bold">
                            ✕
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-500">{row.free}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center align-middle">
                        <span
                          className={cnTokens(
                            "inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[11px] font-bold",
                            row.isUpcoming
                              ? "bg-amber-100 text-amber-800"
                              : "bg-[#D1FADF] text-[#027A48]"
                          )}
                        >
                          {row.isUpcoming ? "Coming soon" : row.premium === true ? "✓" : row.premium}
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

      {/* 3. Approved Add-on Packs Note & Policy Footer Notes */}
      <div className="w-full max-w-3xl mx-auto mt-8 px-4 text-center space-y-4">
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800">
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
            {ADD_ON_PACKS_NOTE}
          </p>
        </div>

        <div className="pt-2 text-center space-y-1.5 text-xs text-slate-400 dark:text-slate-500">
          <p>{PER_WEEK_NOTE}</p>
          <p>{FAIR_USE_LIMIT_NOTE}</p>
          <p className="font-semibold text-slate-600 dark:text-slate-400">{REFUND_POLICY_NOTE}</p>
        </div>
      </div>
    </div>
  );

  return (
    <LoggedInAppShell pageLabel="PRICING" user={user} isPro={isPro}>
      {pricingContent}
      <Footer />
    </LoggedInAppShell>
  );
}
