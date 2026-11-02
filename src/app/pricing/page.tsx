"use client";

import React, { useState, useEffect } from "react";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import Footer from "@/components/Footer";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLANS,
  type PlanConfig,
  getPlanBillingLabel,
  getPlanPerWeekText,
  ADD_ON_PACKS_NOTE,
  REFUND_POLICY_NOTE,
  FAIR_USE_LIMIT_NOTE,
  PER_WEEK_NOTE,
  UPGRADE_BUTTON_LABEL,
} from "@/config/plans";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

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

  const handleKeyDownPlan = (
    e: React.KeyboardEvent<HTMLDivElement>,
    planId: PlanConfig["id"]
  ) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setSelectedPlanId(planId);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const currentIndex = PLANS.findIndex((p) => p.id === planId);
      const nextPlan = PLANS[(currentIndex + 1) % PLANS.length];
      setSelectedPlanId(nextPlan.id);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const currentIndex = PLANS.findIndex((p) => p.id === planId);
      const prevPlan = PLANS[(currentIndex - 1 + PLANS.length) % PLANS.length];
      setSelectedPlanId(prevPlan.id);
    }
  };

  const pricingContent = (
    <div className="max-w-content mx-auto w-full px-3.5 sm:px-6 py-8 sm:py-12 flex flex-col items-center">
      <div className="w-full max-w-[480px]">
        {/* Main Plan Picker Card */}
        <div className="bg-surface rounded-2xl border border-line p-5 sm:p-7 shadow-tk-sm">
          {/* Card Header: Title & Subtitle */}
          <div className="text-center space-y-1.5 mb-6">
            <h1 className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
              Pick your plan
            </h1>
            <p className="text-xs sm:text-sm text-ink-muted leading-relaxed">
              Accelerate your job search with AI resume tailoring and cover letters.
            </p>
          </div>

          {/* 3 Radio Plan Rows */}
          <div
            role="radiogroup"
            aria-label="Subscription plans"
            className="space-y-3"
          >
            {PLANS.map((plan) => {
              const isSelected = selectedPlanId === plan.id;
              const billingLabel = getPlanBillingLabel(plan);
              const perWeekText = getPlanPerWeekText(plan);

              return (
                <div
                  key={plan.id}
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={0}
                  onClick={() => handleSelectPlan(plan.id)}
                  onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
                  className={cnTokens(
                    "relative w-full text-left rounded-xl p-3.5 sm:p-4 transition-all cursor-pointer min-h-[56px] select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2",
                    isSelected
                      ? "border-2 border-[#2563EB] bg-brand-50/50 dark:bg-brand-950/20 shadow-xs"
                      : "border border-line bg-surface hover:border-slate-300 dark:hover:border-slate-700"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: Radio Circle + Title & Subline */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {/* Radio Circle */}
                      <div
                        className={cnTokens(
                          "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 transition-colors",
                          isSelected
                            ? "border-[#2563EB] bg-[#2563EB]"
                            : "border-slate-300 dark:border-slate-600 bg-surface"
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && (
                          <div className="w-2 h-2 rounded-full bg-white" />
                        )}
                      </div>

                      {/* Text content */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center flex-wrap gap-1.5 sm:gap-2">
                          <span className="text-sm sm:text-base font-bold text-ink">
                            {billingLabel}
                          </span>
                          {plan.badge && (
                            <span className="inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full bg-brand-100 text-[#2563EB] border border-brand-200 dark:bg-brand-900/40 dark:text-blue-300 dark:border-blue-800">
                              {plan.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-muted mt-0.5 leading-normal">
                          {plan.subLine}
                        </p>
                      </div>
                    </div>

                    {/* Right: Per-week figure */}
                    <div className="text-right shrink-0 pt-0.5">
                      <span
                        className={cnTokens(
                          "text-sm sm:text-base font-bold tracking-tight whitespace-nowrap",
                          isSelected ? "text-[#2563EB]" : "text-ink"
                        )}
                      >
                        {perWeekText}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* One Big Upgrade Button (Disabled-looking but readable) */}
          <div className="mt-6">
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="w-full min-h-[48px] h-12 rounded-xl bg-[#2563EB]/75 text-white font-bold text-base flex items-center justify-center shadow-tk-xs cursor-not-allowed select-none transition-colors"
            >
              {UPGRADE_BUTTON_LABEL}
            </button>
          </div>
        </div>

        {/* Below the Card: Add-on packs row */}
        <div className="mt-4 px-2 text-center">
          <p className="text-xs text-ink-muted font-medium leading-relaxed">
            {ADD_ON_PACKS_NOTE}
          </p>
        </div>

        {/* Footer notes */}
        <div className="mt-6 pt-4 border-t border-line text-center space-y-1.5 text-xs text-ink-subtle">
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
