"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import Footer from "@/components/Footer";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLANS,
  PAID_PLANS_DISPLAY_ORDER,
  formatPriceINR,
  PREPAID_PRICE_SUMMARY,
  PLAN_PRICING,
} from "@/config/plans";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { BreadcrumbJsonLd } from "@/components/seo/BreadcrumbJsonLd";
import { handleProCheckout, openRazorpaySubscription } from "@/lib/billing/checkout";
import { toast } from "react-toastify";

// Every plan unlocks the same product: full access to job listings.
const JOB_LISTING_FEATURES = [
  "Unlimited browsing of verified unindexed remote jobs",
  "Filters for role, location and job type",
  "Salary data where available",
  "Direct apply links to employer career pages",
];

const policyLinks = [
  { href: "/terms-and-conditions", label: "Terms & Conditions" },
  { href: "/refund-policy", label: "Cancellation & Refund Policy" },
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/contact", label: "Contact Us" },
];

export default function PricingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);

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
  const isAutoRenewEnabled = process.env.NEXT_PUBLIC_AUTORENEW_ENABLED === "true";
  const [autoRenewConsent, setAutoRenewConsent] = useState(false);
  // Mobile plan picker: Monthly (middle tier) preselected; selecting never starts checkout.
  const [selectedPlan, setSelectedPlan] = useState<string>("monthly");

  // Single synchronous purchase lock shared by all plan buttons
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

    if (planCode === "monthly" && isAutoRenewEnabled) {
      if (!autoRenewConsent) {
        resetLock();
        toast.error("Please authorize auto-renewal before subscribing.");
        return;
      }

      const consentRecord = {
        agreed: true,
        version: "2026-11-autorenew-v1",
        timestamp: new Date().toISOString(),
      };

      try {
        await openRazorpaySubscription({
          planCode: "monthly",
          consent: consentRecord,
          redirectTarget: "/pricing",
          onError: (errMsg) => {
            resetLock();
            toast.error(errMsg || "Subscription processing failed. Please try again.");
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
        toast.error(err?.message || "Failed to initiate subscription checkout.");
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

  const paidPlansToDisplay = PAID_PLANS_DISPLAY_ORDER.map(
    (id) => PLANS.find((p) => p.id === id)!
  );

  const faqItems: Array<{ q: string; a: React.ReactNode }> = [
    {
      q: "What do I get?",
      a: "Full access to Career Monke job listings: every verified unindexed remote job, with filters, salary data where the employer publishes it, and direct apply links.",
    },
    {
      q: "Does my plan renew automatically?",
      a: isAutoRenewEnabled ? (
        <>
          The Monthly plan auto-renews at flat ₹499/month until cancelled. You can cancel anytime from Settings &gt; Billing. Weekly and Quarterly plans are prepaid for a fixed duration and do not auto-renew.
        </>
      ) : (
        <>
          No. Plans are prepaid for a fixed duration and do not auto-renew. You pay once ({PREPAID_PRICE_SUMMARY}) and
          access ends when the period is over unless you choose to buy again.
        </>
      ),
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
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-20 flex flex-col gap-16 sm:gap-20">
      {/* Header */}
      <header className="text-center max-w-2xl mx-auto">
        <h1 className="text-3xl sm:text-5xl font-semibold text-[#090E34] dark:text-white tracking-tight leading-tight">
          Plans and pricing
        </h1>
        <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-400 leading-relaxed">
          <span className="sm:block">Full access to verified unindexed remote job listings.</span>{" "}
          <span className="block whitespace-normal break-words sm:whitespace-nowrap">
            {isAutoRenewEnabled ? "Flat ₹499/mo monthly auto-renew, cancel anytime." : "One-time payment, no auto-renewal."}
          </span>
        </p>
      </header>

      {/* Mobile (<md): one radio group picks the plan; only the selected card (and its Buy button) shows.
          md+: the three cards side by side, unchanged. */}
      <fieldset data-testid="mobile-plan-picker" className="md:hidden -mb-10 sm:-mb-14">
        <legend className="sr-only">Choose a plan</legend>
        <div className="grid grid-cols-3 gap-2">
          {paidPlansToDisplay.map((plan) => (
            <label
              key={plan.id}
              className={cnTokens(
                "min-h-[64px] rounded-xl border px-2 py-2 flex flex-col items-center justify-center text-center cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#2563EB] has-[:focus-visible]:ring-offset-2",
                selectedPlan === plan.id
                  ? "border-2 border-[#2563EB] bg-blue-50 text-[#090E34] dark:bg-slate-900 dark:text-white"
                  : "border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
              )}
            >
              <input
                type="radio"
                name="mobile-plan"
                value={plan.id}
                checked={selectedPlan === plan.id}
                onChange={() => setSelectedPlan(plan.id)}
                className="sr-only"
              />
              <span className="text-sm font-semibold">{plan.name}</span>
              <span className="text-xs">{formatPriceINR(plan.price)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-label="Plans" className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-6 items-stretch">
        {paidPlansToDisplay.map((plan) => {
          const isPopular = plan.id === "monthly";
          const durationDays = PLAN_PRICING[plan.id].duration_days;

          return (
            <article
              key={plan.id}
              data-plan-card={plan.id}
              className={cnTokens(
                "flex flex-col rounded-2xl p-6 sm:p-8 bg-white dark:bg-slate-950 min-w-0",
                selectedPlan !== plan.id && "max-md:hidden",
                isPopular
                  ? "border-2 border-[#2563EB] shadow-lg shadow-blue-600/10"
                  : "border border-slate-200 dark:border-slate-800"
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

              <div className="mt-6 flex items-baseline gap-2">
                <span className="text-4xl font-semibold text-[#090E34] dark:text-white tracking-tight">
                  {formatPriceINR(plan.price)}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {isPopular && isAutoRenewEnabled ? "/month" : "one-time"}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {isPopular && isAutoRenewEnabled ? "Auto-renews monthly" : `${durationDays} days access`}
              </p>

              <ul className="mt-8 space-y-3 text-sm text-slate-700 dark:text-slate-300 flex-1">
                {JOB_LISTING_FEATURES.map((feature) => (
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

              <div className="mt-8">
                {isPopular && isAutoRenewEnabled && isBillingEnabled && (
                  <div className="mb-4">
                    <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        data-testid="autorenew-consent-checkbox"
                        aria-label="Authorize monthly auto-renewal"
                        checked={autoRenewConsent}
                        onChange={(e) => setAutoRenewConsent(e.target.checked)}
                        className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                      <span>
                        I authorize Career Monke to charge ₹499/month until cancelled. I can cancel anytime from Settings.
                      </span>
                    </label>
                  </div>
                )}
                {isBillingEnabled ? (
                  <button
                    type="button"
                    data-plan-code={plan.id}
                    disabled={isCheckoutLocked || (isPopular && isAutoRenewEnabled && !autoRenewConsent)}
                    onClick={() => handleBuyPlan(plan.id)}
                    className={cnTokens(
                      "w-full min-h-[48px] rounded-xl font-semibold text-sm flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed",
                      isPopular
                        ? "bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
                        : "bg-[#090E34] text-white hover:bg-slate-800 dark:bg-white dark:text-[#090E34] dark:hover:bg-slate-200"
                    )}
                  >
                    Buy {plan.name}
                  </button>
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
                    <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
                      Payments are currently unavailable.
                    </p>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </section>

      {/* FAQ */}
      <section aria-labelledby="pricing-faq-heading" className="w-full max-w-3xl mx-auto">
        <h2 id="pricing-faq-heading" className="text-xl sm:text-2xl font-semibold text-[#090E34] dark:text-white text-center">
          Frequently asked questions
        </h2>
        <div className="mt-8 divide-y divide-slate-200 dark:divide-slate-800 border-y border-slate-200 dark:border-slate-800">
          {faqItems.map((item) => (
            <details key={item.q} className="group py-5">
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

      {/* Final-sale note and policy links */}
      <div className="w-full max-w-3xl mx-auto text-center space-y-3 text-xs text-slate-500 dark:text-slate-400">
        <p className="font-semibold text-[#090E34] dark:text-white">All sales final · no refunds</p>
        <p>
          {isAutoRenewEnabled
            ? "Monthly plan auto-renews at flat ₹499/month until cancelled. Weekly and Quarterly plans are prepaid for a fixed duration."
            : `Plans are prepaid for a fixed duration and do not auto-renew. (${PREPAID_PRICE_SUMMARY}). Access ends automatically when the plan period expires.`}
        </p>
        <nav aria-label="Policies" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          {policyLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hover:text-[#2563EB] dark:hover:text-blue-400 underline underline-offset-2 transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
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
