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
      <div className="text-center space-y-2 mb-8 sm:mb-12 max-w-2xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-ink tracking-tight">
          CareerMonke Premium
        </h1>
        <p className="text-sm sm:text-base text-ink-muted leading-relaxed">
          Accelerate your remote job search with unmasked direct employer listings and job-tailored applications.
        </p>
      </div>

      {/* 2 & 3. Main Side-by-Side Section: Free Column + Paid Premium Panel */}
      <div className="w-full flex flex-col lg:flex-row items-stretch gap-6">
        {/* Free Comparison Column */}
        <div className="w-full lg:w-[280px] lg:max-w-[280px] shrink-0 bg-surface rounded-2xl border border-line p-5 sm:p-6 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-ink-subtle">
                Basic Tier
              </span>
              {!isPro && (
                <span className="inline-flex items-center text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  Current Plan
                </span>
              )}
            </div>
            <h2 className="text-xl font-bold text-ink">
              {FREE_TIER_CONFIG.name}
            </h2>
            <p className="text-xs text-ink-muted mt-1 leading-normal">
              {FREE_TIER_CONFIG.subLine}
            </p>

            {/* Price display */}
            <div className="my-6">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-black text-ink">₹0</span>
                <span className="text-xs text-ink-muted font-medium">
                  /{FREE_TIER_CONFIG.billingText}
                </span>
              </div>
            </div>

            {/* Action / State Indicator */}
            <div className="mb-6">
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="w-full min-h-[44px] rounded-xl border border-line bg-surface-muted text-ink font-semibold text-sm flex items-center justify-center cursor-default select-none transition-colors"
              >
                {!isPro ? "Current Plan" : "Basic Tier Included"}
              </button>
            </div>

            {/* Free Inclusions list */}
            <div className="space-y-2.5 text-xs pt-4 border-t border-line/70">
              <p className="font-semibold text-ink text-[11px] uppercase tracking-wider">
                What's included:
              </p>
              <ul className="space-y-2 text-ink-muted">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>Direct employer job search & filters</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>Verified direct source badges</span>
                </li>
                <li className="flex items-start gap-2 text-ink-subtle">
                  <X className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>Masked company names & logos</span>
                </li>
                <li className="flex items-start gap-2 text-ink-subtle">
                  <X className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>Direct ATS apply links hidden</span>
                </li>
                <li className="flex items-start gap-2 text-ink-subtle">
                  <X className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>Masked verified salary compensation</span>
                </li>
                <li className="flex items-start gap-2 text-ink-subtle">
                  <X className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>0 AI application sets</span>
                </li>
                <li className="flex items-start gap-2 text-ink-subtle">
                  <X className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>0 Top 10 match unlocks</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Paid Premium Panel */}
        <div className="flex-1 min-w-0 bg-surface rounded-2xl border-2 border-line p-5 sm:p-7 shadow-xs flex flex-col justify-between">
          <div>
            {/* Top row inside panel */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-ink-subtle">
                    Pick your plan
                  </span>
                  {isPro && (
                    <span className="inline-flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300">
                      Current Plan
                    </span>
                  )}
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-ink mt-0.5">
                  CareerMonke Premium Plans
                </h2>
                <p className="text-xs sm:text-sm text-ink-muted mt-1 leading-normal">
                  Unlock unmasked direct listings, direct ATS application links, and monthly AI application sets.
                </p>
              </div>
            </div>

            {/* 3 Paid Plan Cards in one desktop row (Monthly, Quarterly, Weekly) */}
            <div
              role="radiogroup"
              aria-label="Subscription plans"
              className="grid grid-cols-1 md:grid-cols-3 gap-3.5 my-6"
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
                      "relative flex flex-col justify-between rounded-xl p-4 sm:p-5 transition-all cursor-pointer select-none min-h-[170px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2",
                      isSelected
                        ? "border-2 border-emerald-600 dark:border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20 shadow-xs ring-1 ring-emerald-600/20"
                        : "border border-line bg-surface hover:border-slate-300 dark:hover:border-slate-700"
                    )}
                  >
                    <div>
                      {/* Top row: Plan Name + Badge */}
                      <div className="flex items-center justify-between gap-1.5 mb-2">
                        <span className="text-base font-bold text-ink">
                          {plan.name}
                        </span>
                        {plan.badge && (
                          <span
                            className={cnTokens(
                              "inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border",
                              plan.badge === "Recommended"
                                ? "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300"
                                : "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300"
                            )}
                          >
                            {plan.badge}
                          </span>
                        )}
                      </div>

                      {/* Prominent Billed Total */}
                      <div className="my-2">
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                            {formatPriceINR(plan.price)}
                          </span>
                          <span className="text-xs text-ink-muted font-medium">
                            /{plan.interval === "week" ? "week" : plan.interval === "month" ? "month" : "3 months"}
                          </span>
                        </div>
                        <p className="text-[11px] text-ink-subtle font-medium">
                          {billingLabel}
                        </p>
                      </div>

                      {/* Smaller Equivalent Weekly Price Comparison */}
                      {plan.interval !== "week" && (
                        <div className="mt-1">
                          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            {perWeekText}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Subline / quota terms */}
                    <div className="mt-4 pt-3 border-t border-line/60">
                      <p className="text-xs text-ink-muted leading-relaxed font-medium">
                        {plan.subLine}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Upgrade Action Button (Disabled / Inert) */}
            <div className="mt-6 space-y-2">
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="w-full min-h-[48px] h-12 rounded-xl bg-emerald-600/80 hover:bg-emerald-600/80 text-white font-bold text-base flex items-center justify-center shadow-xs cursor-not-allowed select-none transition-colors"
              >
                {UPGRADE_BUTTON_LABEL}
              </button>
              <p className="text-center text-xs text-ink-subtle">
                Selection does not trigger charges. Payments and activation opening soon.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Aligned Free vs Premium Feature Comparison Table */}
      <div className="w-full max-w-6xl mx-auto mt-12 sm:mt-16">
        <div className="text-center sm:text-left mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-ink tracking-tight">
            Compare Plans & Capabilities
          </h2>
          <p className="text-xs sm:text-sm text-ink-muted mt-1">
            Verified breakdown of features between Free and CareerMonke Premium.
          </p>
        </div>

        <div className="bg-surface rounded-2xl border border-line shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[620px]">
              <thead>
                <tr className="border-b border-line bg-surface-subtle">
                  <th className="py-3.5 px-4 sm:px-6 text-xs font-bold uppercase tracking-wider text-ink-subtle w-1/2">
                    Feature & Capability
                  </th>
                  <th className="py-3.5 px-4 sm:px-6 text-xs font-bold uppercase tracking-wider text-ink-subtle text-center w-1/4">
                    CareerMonke Free
                  </th>
                  <th className="py-3.5 px-4 sm:px-6 text-xs font-bold uppercase tracking-wider text-ink-subtle text-center w-1/4 bg-emerald-50/30 dark:bg-emerald-950/10">
                    CareerMonke Premium
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-xs sm:text-sm">
                {PLAN_COMPARISON_ROWS.map((row, idx) => (
                  <tr key={idx} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="py-3 px-4 sm:px-6">
                      <span className="font-semibold text-ink block">{row.feature}</span>
                      <span className="text-xs text-ink-muted block mt-0.5 leading-normal">{row.description}</span>
                    </td>
                    <td className="py-3 px-4 sm:px-6 text-center">
                      {row.free === true ? (
                        <Check className="w-5 h-5 text-emerald-600 mx-auto" aria-label="Included in Free" />
                      ) : row.free === false ? (
                        <X className="w-5 h-5 text-slate-300 dark:text-slate-600 mx-auto" aria-label="Not included in Free" />
                      ) : (
                        <span className="text-xs text-ink-muted font-medium">{row.free}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 sm:px-6 text-center bg-emerald-50/20 dark:bg-emerald-950/10">
                      {row.isUpcoming ? (
                        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300">
                          Coming soon
                        </span>
                      ) : row.premium === true ? (
                        <Check className="w-5 h-5 text-emerald-600 mx-auto" aria-label="Included in Premium" />
                      ) : row.premium === false ? (
                        <X className="w-5 h-5 text-slate-300 dark:text-slate-600 mx-auto" aria-label="Not included in Premium" />
                      ) : (
                        <span className="text-xs text-emerald-700 dark:text-emerald-400 font-bold">{row.premium}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 6. Approved Add-on Packs Note & Policy Footer Notes */}
      <div className="w-full max-w-3xl mx-auto mt-8 px-4 text-center space-y-4">
        <div className="p-4 rounded-xl bg-surface-subtle border border-line">
          <p className="text-xs sm:text-sm text-ink-muted font-medium leading-relaxed">
            {ADD_ON_PACKS_NOTE}
          </p>
        </div>

        <div className="pt-2 text-center space-y-1.5 text-xs text-ink-subtle">
          <p>{PER_WEEK_NOTE}</p>
          <p>{FAIR_USE_LIMIT_NOTE}</p>
          <p className="font-semibold text-ink-muted">{REFUND_POLICY_NOTE}</p>
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
