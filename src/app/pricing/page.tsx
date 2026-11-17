"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import Footer from "@/components/Footer";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLANS,
  type PlanConfig,
  PAID_PLANS_DISPLAY_ORDER,
  getPlanBillingLabel,
  getPlanPerWeekText,
  formatPriceINR,
  ADD_ON_PACKS,
  ADD_ON_PACKS_NOTE,
  FAIR_USE_LIMIT_NOTE,
  PLAN_QUOTA_SUMMARY_NOTE,
  PER_WEEK_NOTE,
  UPGRADE_BUTTON_LABEL,
  PREPAID_PRICE_SUMMARY,
  PLAN_PRICING,
} from "@/config/plans";
import { PLAN_FEATURE_ROWS } from "@/config/plan-features";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { handleProCheckout } from "@/lib/billing/checkout";
import { toast } from "react-toastify";

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

  const isBillingEnabled = process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";

  // Single synchronous purchase lock shared by plan and add-on purchases
  const checkoutLockRef = useRef<boolean>(false);
  const [loadingCheckout, setLoadingCheckout] = useState<string | null>(null);
  const isCheckoutLocked = checkoutLockRef.current || loadingCheckout !== null;

  const handleBuyPlan = async (planCode: string) => {
    if (!isBillingEnabled) {
      toast.error("Payments not enabled. Billing is currently disabled.");
      return;
    }
    // Synchronous in-flight guard: acquired before any auth await
    if (checkoutLockRef.current || loadingCheckout !== null) {
      return;
    }
    checkoutLockRef.current = true;
    setLoadingCheckout(planCode);

    const resetLock = () => {
      checkoutLockRef.current = false;
      setLoadingCheckout(null);
    };

    let currentUser = user;
    if (!currentUser) {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        currentUser = session?.user || null;
      } catch {}
    }

    if (!currentUser) {
      resetLock();
      const loginUrl = `/login?returnTo=${encodeURIComponent("/pricing")}`;
      if (typeof window !== "undefined") {
        window.location.href = loginUrl;
      }
      return;
    }

    try {
      await handleProCheckout({
        planCode,
        redirectTarget: "/pricing",
        onError: (errMsg) => {
          resetLock();
          toast.error(errMsg || "Payment processing failed. Please try again.");
        },
        onSuccess: () => {
          resetLock();
        },
        onDismiss: () => {
          resetLock();
        },
      });
    } catch (err: any) {
      resetLock();
      toast.error(err?.message || "Failed to initiate plan checkout.");
    }
  };

  const handleBuyAddon = async (addonCode: string) => {
    if (!isBillingEnabled) {
      toast.error("Payments not enabled. Billing is currently disabled.");
      return;
    }
    // Synchronous in-flight guard: acquired before any auth await
    if (checkoutLockRef.current || loadingCheckout !== null) {
      return;
    }
    checkoutLockRef.current = true;
    setLoadingCheckout(addonCode);

    const resetLock = () => {
      checkoutLockRef.current = false;
      setLoadingCheckout(null);
    };

    let currentUser = user;
    if (!currentUser) {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        currentUser = session?.user || null;
      } catch {}
    }

    if (!currentUser) {
      resetLock();
      const loginUrl = `/login?returnTo=${encodeURIComponent("/pricing")}`;
      if (typeof window !== "undefined") {
        window.location.href = loginUrl;
      }
      return;
    }

    try {
      await handleProCheckout({
        addonCode,
        redirectTarget: "/pricing",
        onError: (errMsg) => {
          resetLock();
          toast.error(errMsg || "Payment processing failed. Please try again.");
        },
        onSuccess: () => {
          resetLock();
        },
        onDismiss: () => {
          resetLock();
        },
      });
    } catch (err: any) {
      resetLock();
      toast.error(err?.message || "Failed to initiate add-on checkout.");
    }
  };

  const handleSelectPlan = (
    planId: PlanConfig["id"] | string,
    options?: { addonCode?: string; planCode?: string }
  ) => {
    if (options?.addonCode || (typeof planId === "string" && planId.startsWith("addon_"))) {
      const addonCode = options?.addonCode || planId;
      handleBuyAddon(addonCode);
      return;
    }
    if (options?.planCode) {
      setSelectedPlanId(planId as PlanConfig["id"]);
      handleBuyPlan(options.planCode);
      return;
    }
    setSelectedPlanId(planId as PlanConfig["id"]);
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


  // Short per-card feature lists. Quota numbers come from the central plan config.
  const getPlanFeatures = (plan: PlanConfig): string[] => [
    `AI resume tailoring + cover letters: ${plan.quotaPeriodText}`,
    "Employer names, logos and verified salary bands",
    "Direct ATS apply links on company career pages",
    "Top 10 high-compatibility job matches",
  ];

  const faqItems: Array<{ q: string; a: React.ReactNode }> = [
    {
      q: "Does my plan renew automatically?",
      a: (
        <>
          No. Plans are prepaid for a fixed duration and do not auto-renew. You pay once ({PREPAID_PRICE_SUMMARY}) and
          premium access ends when the period is over unless you choose to buy again.
        </>
      ),
    },
    {
      q: "How much AI usage do I get?",
      a: (
        <>
          {PLAN_QUOTA_SUMMARY_NOTE} {FAIR_USE_LIMIT_NOTE}
        </>
      ),
    },
    {
      q: "What happens when my plan ends?",
      a: "Premium features and remaining plan quotas expire automatically. Your account, profile, resumes and saved jobs stay available on the free plan.",
    },
    {
      q: "Can I get a refund?",
      a: (
        <>
          All sales are final. Only a duplicate or failed-but-debited payment is reviewed and refunded. See the{" "}
          <Link href="/refund-policy" className="underline underline-offset-2 hover:text-[#2563EB]">
            Cancellation &amp; Refund Policy
          </Link>
          .
        </>
      ),
    },
    {
      q: "How can I pay?",
      a: "Payments are processed in Indian Rupees through Razorpay, with UPI, NetBanking and cards supported.",
    },
  ];

  const pricingContent = (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16 flex flex-col items-center p-tk-4 sm:p-tk-3 gap-tk-4 sm:gap-tk-3 space-y-tk-4 sm:space-y-tk-3">
      {/* 1. Header */}
      <div className="text-center max-w-2xl mx-auto space-y-3 mb-8 sm:mb-12">
        <h1 className="text-3xl sm:text-5xl font-semibold text-[#090E34] dark:text-white tracking-tight leading-tight">
          Get more interviews with CareerMonke Premium
        </h1>
        <p className="text-base sm:text-lg text-slate-600 dark:text-slate-400 leading-relaxed">
          Stronger resumes + faster applications tailored to verified unindexed remote roles.
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          One-time payment. No subscription, no auto-renewal.
        </p>
        {/* Same footprint in both billing states so the header does not shift */}
        <div className="pt-2">
          {isBillingEnabled ? (
            <span
              className="invisible inline-flex items-center px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-semibold border border-transparent select-none"
              aria-hidden="true"
            >
              &nbsp;
            </span>
          ) : (
            <span className="inline-flex items-center px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-semibold bg-blue-50 text-[#2563EB] dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              Payments will open soon.
            </span>
          )}
        </div>
      </div>

      {/* 2. Plan cards: one responsive grid, stacked on mobile */}
      <div
        role="radiogroup"
        aria-label="Subscription plans"
        className="w-full grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6 items-stretch"
      >
        {paidPlansToDisplay.map((plan) => {
          const isSelected = selectedPlanId === plan.id;
          const isPopular = plan.id === "monthly";
          const durationDays = PLAN_PRICING[plan.id].duration_days;

          return (
            <div
              key={plan.id}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              onClick={() => handleSelectPlan(plan.id)}
              onKeyDown={(e) => handleKeyDownPlan(e, plan.id)}
              className={cnTokens(
                "relative flex flex-col rounded-2xl p-6 sm:p-7 bg-white dark:bg-slate-950 transition-shadow cursor-pointer select-none min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2",
                isSelected
                  ? "border-2 border-[#2563EB] shadow-lg shadow-blue-600/10"
                  : "border border-slate-200 dark:border-slate-800 hover:shadow-md"
              )}
            >
              <div className="flex items-center justify-between gap-2 min-h-[28px]">
                <h2 className="text-xl font-semibold text-[#090E34] dark:text-white">{plan.name}</h2>
                {isPopular && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#2563EB] text-white">
                    Most popular
                  </span>
                )}
              </div>

              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{plan.subLine}</p>

              <div className="mt-6 flex items-baseline gap-1.5">
                <span className="text-4xl font-semibold text-[#090E34] dark:text-white tracking-tight">
                  {formatPriceINR(plan.price)}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">/ {durationDays} days</span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {plan.billingText} · <span className="text-[#2563EB] dark:text-blue-400 font-medium">{getPlanPerWeekText(plan)}</span>
              </p>
              <p className="sr-only">{getPlanBillingLabel(plan)}</p>

              <div className="mt-6">
                {isBillingEnabled ? (
                  <button
                    type="button"
                    data-plan-code={plan.id}
                    disabled={isCheckoutLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectPlan(plan.id, { planCode: plan.id });
                    }}
                    className={cnTokens(
                      "w-full min-h-[48px] rounded-xl font-semibold text-sm flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed",
                      isPopular || isSelected
                        ? "bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
                        : "bg-[#090E34] text-white hover:bg-slate-800 dark:bg-white dark:text-[#090E34] dark:hover:bg-slate-200"
                    )}
                  >
                    Buy {plan.name}
                  </button>
                ) : null}
                {isBillingEnabled ? (
                  <div className="flex justify-center mt-2" aria-hidden="true">
                    <span className="invisible inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-transparent select-none">
                      &nbsp;
                    </span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="w-full min-h-[48px] rounded-xl font-semibold text-sm flex items-center justify-center cursor-not-allowed bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    >
                      Upgrade
                    </button>
                    <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">{UPGRADE_BUTTON_LABEL}</p>
                  </>
                )}
              </div>

              <ul className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800 space-y-3 text-sm text-slate-700 dark:text-slate-300">
                {getPlanFeatures(plan).map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#2563EB]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                    >
                      <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="min-w-0">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="w-full text-[11px] text-slate-400 dark:text-slate-500 mt-3 leading-normal text-center">
        {PER_WEEK_NOTE}
      </p>

      {/* 3. Free plan strip */}
      <div className="w-full mt-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-[#F8F9FA] dark:bg-slate-900/60 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-[#090E34] dark:text-white">Free Plan</span>
            <span className="text-base font-semibold text-[#090E34] dark:text-white">₹0.00</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">Free forever</span>
          </div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Basic search &amp; masked previews · 0 AI application sets · Unlimited job browsing
          </p>
        </div>
        <div className="shrink-0 min-h-[44px] px-4 rounded-xl text-sm font-medium flex items-center justify-center bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300">
          Your current plan
        </div>
      </div>

      {/* 4. Feature comparison */}
      <section aria-labelledby="premium-features-heading" className="w-full mt-12">
        <h2 id="premium-features-heading" className="text-xl sm:text-2xl font-semibold text-[#090E34] dark:text-white">
          All features included in Premium
        </h2>
        <ul className="mt-4 divide-y divide-slate-100 dark:divide-slate-800 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
          {PLAN_FEATURE_ROWS.map((row) => (
            <li key={row.name} className="px-4 sm:px-6 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-6">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#090E34] dark:text-white">{row.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{row.info}</p>
              </div>
              <div className="text-xs sm:text-right sm:shrink-0 sm:max-w-[45%]">
                <span className="font-medium text-[#2563EB] dark:text-blue-400">{row.premium}</span>
                <span className="text-slate-400 dark:text-slate-500"> · Free: {row.free}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 5. Add-on Packs */}
      <section aria-labelledby="addon-packs-heading" className="w-full mt-12">
        <h2 id="addon-packs-heading" className="text-xl sm:text-2xl font-semibold text-[#090E34] dark:text-white">
          Add-on Packs
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          Need extra capacity during your plan? 10 / 30 / 60 extra generations are used only after your plan quota is exhausted, respect the 30/day fair-use limit, and expire together with the subscription.
        </p>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {ADD_ON_PACKS.map((pack) => {
            const addonCode = pack.code || (pack.sets === 10 ? "addon_10" : pack.sets === 30 ? "addon_30" : "addon_60");

            return (
              <div
                key={pack.sets}
                className="flex flex-col justify-between rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-5"
              >
                <div>
                  <span className="text-xs font-medium text-[#2563EB] dark:text-blue-400">One-time add-on</span>
                  <div className="mt-1 text-2xl font-semibold text-[#090E34] dark:text-white tracking-tight">
                    {formatPriceINR(pack.price)}
                  </div>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{pack.sets} extra generations</p>
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Used after plan quota · Expires together with your subscription
                  </p>
                </div>

                <button
                  type="button"
                  data-addon-code={addonCode}
                  disabled={isCheckoutLocked || !isBillingEnabled}
                  aria-disabled={!isBillingEnabled ? "true" : undefined}
                  onClick={() => handleSelectPlan(addonCode, { addonCode })}
                  className={cnTokens(
                    "mt-4 w-full min-h-[44px] rounded-xl font-semibold text-sm flex items-center justify-center transition-colors border border-slate-300 dark:border-slate-700 text-[#090E34] dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 disabled:opacity-60",
                    !isBillingEnabled ? "cursor-not-allowed" : "hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer"
                  )}
                >Buy</button>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{ADD_ON_PACKS_NOTE}</p>
      </section>

      {/* 6. FAQ */}
      <section aria-labelledby="pricing-faq-heading" className="w-full max-w-3xl mx-auto mt-14">
        <h2 id="pricing-faq-heading" className="text-xl sm:text-2xl font-semibold text-[#090E34] dark:text-white text-center">
          Frequently asked questions
        </h2>
        <div className="mt-6 divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
          {faqItems.map((item) => (
            <details key={item.q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm sm:text-base font-medium text-[#090E34] dark:text-white [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">{item.q}</span>
                <span aria-hidden="true" className="shrink-0 text-slate-400 transition-transform group-open:rotate-45 text-xl leading-none">
                  +
                </span>
              </summary>
              <div className="mt-3 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{item.a}</div>
            </details>
          ))}
        </div>
      </section>

      {/* 7. Final-sale note and policy links */}
      <div className="w-full max-w-3xl mx-auto mt-8 text-center space-y-2 text-xs text-slate-500 dark:text-slate-400">
        <p className="font-semibold text-[#090E34] dark:text-white">All sales final · no refunds</p>
        <p>
          Plans are prepaid for a fixed duration and do not auto-renew. ({PREPAID_PRICE_SUMMARY}). Premium access ends automatically when the plan period expires. Add-on packs expire together with the subscription.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <Link href="/about" className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors">
            About Us
          </Link>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
          <Link href="/terms-and-conditions" className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors">
            Terms &amp; Conditions
          </Link>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
          <Link href="/privacy-policy" className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors">
            Privacy Policy
          </Link>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
          <Link href="/refund-policy" className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors">
            Cancellation &amp; Refund Policy
          </Link>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
          <Link href="/contact" className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors">
            Contact Us
          </Link>
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
