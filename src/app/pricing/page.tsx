"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  Sparkles,
  ShieldCheck,
  CreditCard,
  QrCode,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Lock,
  RefreshCw,
  HelpCircle,
  ExternalLink,
} from "lucide-react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { cnTokens } from "@/components/ui/cn-tokens";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL } from "@/lib/billing/types";
import { loadRazorpayScript } from "@/lib/billing/razorpay";
import {
  getProAccessStatus,
  invalidateProAccessCache,
} from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

type PaymentStatus =
  | "idle"
  | "loading_auth"
  | "creating_order"
  | "awaiting_payment"
  | "verifying"
  | "success"
  | "dismissed"
  | "error";

interface PaymentState {
  status: PaymentStatus;
  errorMessage?: string;
  paymentId?: string;
  orderId?: string;
  testMode?: boolean;
}

export default function PricingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [paymentState, setPaymentState] = useState<PaymentState>({
    status: "idle",
  });

  const billingEnabled = process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";

  useEffect(() => {
    let mounted = true;
    const checkAuthAndPro = async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!mounted) return;

        if (!session?.user) {
          router.replace("/login?returnTo=/pricing");
          return;
        }

        setUser(session.user);

        const proStatus = await getProAccessStatus(session?.user?.id);
        if (!mounted) return;
        setIsPro(proStatus.isPro);
      } catch (err) {
        console.warn("[Pricing] Auth / Pro check failed:", err);
      } finally {
        if (mounted) setAuthLoading(false);
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

  const handleIndiaCheckout = async () => {
    // 1. Require logged in user
    if (!user) {
      if (typeof window !== "undefined") {
        window.location.href = "/login?returnTo=/pricing";
      }
      return;
    }

    // 2. If already Pro, skip
    if (isPro) {
      return;
    }

    setPaymentState({ status: "creating_order" });

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error("Your session expired. Please sign in again.");
      }

      // Call order creation endpoint
      const orderRes = await fetch("/api/billing/razorpay/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          planId: PLAN_DOMESTIC.id,
        }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok) {
        const msg =
          orderData.error ||
          "Checkout is unavailable right now, please try again later.";
        setPaymentState({
          status: "error",
          errorMessage: msg,
        });
        return;
      }

      const { orderId, amount, currency, keyId } = orderData;

      // 3. Load Razorpay checkout.js
      setPaymentState({ status: "awaiting_payment", orderId });
      const loaded = await loadRazorpayScript();
      if (!loaded) {
        throw new Error(
          "Failed to load Razorpay checkout script. Check your network or ad-blocker."
        );
      }

      if (typeof window === "undefined" || !(window as any).Razorpay) {
        throw new Error("Razorpay SDK is not available.");
      }

      // 4. Open Razorpay Standard Checkout
      const effectiveKey =
        keyId || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;

      const rzpOptions = {
        key: effectiveKey,
        amount,
        currency,
        name: "CareerMonke",
        description: `${PLAN_DOMESTIC.name} (Test Mode)`,
        order_id: orderId,
        prefill: {
          name: (user.user_metadata as any)?.full_name || "",
          email: user.email || "",
        },
        theme: {
          color: "#2563EB",
        },
        modal: {
          ondismiss: () => {
            setPaymentState({
              status: "dismissed",
              errorMessage:
                "Checkout modal closed before completing payment. You have not been charged.",
            });
          },
        },
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          setPaymentState({ status: "verifying" });
          try {
            const verifyRes = await fetch("/api/billing/razorpay/verify", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id || orderId,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });

            const verifyData = await verifyRes.json();

            if (!verifyRes.ok || !verifyData.success) {
              throw new Error(
                verifyData.error || "Payment verification failed on server."
              );
            }

            if (verifyData.testMode) {
              // Test mode safety: never activate Pro
              setPaymentState({
                status: "success",
                paymentId: response.razorpay_payment_id,
                testMode: true,
              });
            } else {
              // Refresh Pro status across application on live verified payment
              invalidateProAccessCache();
              if (typeof window !== "undefined") {
                window.dispatchEvent(new Event("careermonke_pro_updated"));
              }
              setIsPro(true);
              setPaymentState({
                status: "success",
                paymentId: response.razorpay_payment_id,
                testMode: false,
              });
            }
          } catch (verifyErr: any) {
            setPaymentState({
              status: "error",
              errorMessage:
                verifyErr?.message ||
                "Failed to verify signature with the server.",
            });
          }
        },
      };

      const rzp = new (window as any).Razorpay(rzpOptions);
      rzp.on("payment.failed", (resp: any) => {
        setPaymentState({
          status: "error",
          errorMessage:
            resp?.error?.description ||
            resp?.error?.reason ||
            "Payment failed in checkout.",
        });
      });
      rzp.open();
    } catch (err: any) {
      setPaymentState({
        status: "error",
        errorMessage: err?.message || "An unexpected error occurred.",
      });
    }
  };

  const isCheckingOut =
    paymentState.status === "creating_order" ||
    paymentState.status === "awaiting_payment" ||
    paymentState.status === "verifying";

  return (
    <div className="min-h-screen flex flex-col bg-surface-subtle text-ink">
      <GuideHeader />

      <main className="flex-1 max-w-content mx-auto w-full px-4 sm:px-6 py-tk-6 sm:py-tk-8">
        {!billingEnabled ? (
          /* Billing Disabled: Pro launching soon State */
          <div className="max-w-xl mx-auto my-tk-8 text-center space-y-tk-4">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-tk-full bg-brand-50 text-brand-600 mx-auto">
              <Sparkles className="w-7 h-7" />
            </div>
            <div className="space-y-2">
              <Badge tone="brand" size="md">
                CareerMonke Pro
              </Badge>
              <h1 className="text-tk-display font-black tracking-tight text-ink sm:text-4xl">
                Pro launching soon
              </h1>
              <p className="text-tk-body text-ink-muted leading-relaxed">
                We are putting the final touches on CareerMonke Pro memberships. Check back soon for direct ATS links, verified salary bands, and AI match diagnostics.
              </p>
            </div>
            <div className="pt-tk-2">
              <Link
                href="/jobs"
                className={buttonClasses({
                  variant: "primary",
                  size: "lg",
                })}
              >
                Back to Jobs
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Header Hero */}
            <div className="text-center max-w-2xl mx-auto space-y-tk-2">
              <div className="inline-flex items-center gap-2">
                <Badge tone="brand" size="md" dot>
                  Transparent Pricing
                </Badge>
                <Badge tone="warning" size="md">
                  Razorpay Test Mode
                </Badge>
              </div>

              <h1 className="text-tk-display font-black tracking-tight text-ink sm:text-4xl">
                Direct Career Radar, Zero Fluff
              </h1>
              <p className="text-tk-body text-ink-muted leading-relaxed">
                Unmask verified compensation bands, bypass aggregators with direct ATS
                endpoints, and unlock tailored AI application tools.
              </p>
            </div>

            {/* Global Notifications: Dismissed / Error / Success States */}
            {paymentState.status === "success" && (
              <div className="max-w-2xl mx-auto mt-tk-4">
                <Card
                  variant="elevated"
                  className="p-tk-3 sm:p-tk-4 border-success-200 bg-success-50/60 text-ink"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-tk-full bg-success-100 text-success-700 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-6 h-6" />
                    </div>
                    <div className="space-y-1 flex-1">
                      <h2 className="text-tk-heading-sm font-bold text-success-900">
                        {paymentState.testMode
                          ? "Test payment successful (no Pro granted)"
                          : "Pro Membership Activated!"}
                      </h2>
                      <p className="text-tk-body-sm text-ink-muted">
                        {paymentState.testMode
                          ? "Your test payment was verified successfully in sandbox mode. Because this was a test transaction, Pro access was not granted."
                          : "Your payment was verified successfully. Direct ATS links, full descriptions, and salary bands are now unlocked."}
                      </p>
                      {paymentState.paymentId && (
                        <p className="text-tk-caption text-ink-subtle font-mono pt-1">
                          Payment ID: {paymentState.paymentId}
                        </p>
                      )}
                      <div className="pt-tk-2 flex flex-wrap gap-2">
                        <Link
                          href="/jobs"
                          className={buttonClasses({
                            variant: "primary",
                            size: "sm",
                          })}
                        >
                          Browse Jobs
                        </Link>
                        {!paymentState.testMode && (
                          <Link
                            href="/dashboard"
                            className={buttonClasses({
                              variant: "ghost",
                              size: "sm",
                            })}
                          >
                            Go to Dashboard
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            )}

            {paymentState.status === "dismissed" && (
              <div className="max-w-2xl mx-auto mt-tk-4">
                <Card
                  variant="surface"
                  className="p-tk-2.5 sm:p-tk-3 border-line bg-surface text-ink flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5 text-tk-body-sm text-ink-muted">
                    <AlertCircle className="w-4 h-4 text-ink-subtle shrink-0" />
                    <span>{paymentState.errorMessage}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPaymentState({ status: "idle" })}
                  >
                    Dismiss
                  </Button>
                </Card>
              </div>
            )}

            {paymentState.status === "error" && (
              <div className="max-w-2xl mx-auto mt-tk-4">
                <Card
                  variant="surface"
                  className="p-tk-3 border-danger-200 bg-danger-50/60 text-ink space-y-2"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-5 h-5 text-danger-600 shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <h3 className="text-tk-body-sm font-bold text-danger-900">
                        Payment could not be completed
                      </h3>
                      <p className="text-tk-caption text-danger-800">
                        {paymentState.errorMessage || "An unexpected error occurred."}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPaymentState({ status: "idle" })}
                    >
                      Try Again
                    </Button>
                  </div>
                </Card>
              </div>
            )}

            {/* Current Pro Status Banner if already Pro */}
            {isPro && paymentState.status !== "success" && (
              <div className="max-w-2xl mx-auto mt-tk-4">
                <Card
                  variant="surface"
                  className="p-tk-2.5 sm:p-tk-3 border-brand-200 bg-brand-50/50 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5">
                    <Sparkles className="w-4 h-4 text-brand-600 shrink-0" />
                    <p className="text-tk-body-sm text-brand-900 font-medium">
                      You are currently on an active <strong>CareerMonke Pro</strong> membership.
                    </p>
                  </div>
                  <Link
                    href="/dashboard"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    Dashboard
                  </Link>
                </Card>
              </div>
            )}

            {/* Plan Cards Grid */}
            <div className="mt-tk-6 grid grid-cols-1 md:grid-cols-2 gap-tk-4 max-w-4xl mx-auto">
              {/* Card 1: India Domestic Plan (Razorpay Standard Checkout Test Mode) */}
              <Card
                variant="elevated"
                className={cnTokens(
                  "relative flex flex-col justify-between p-tk-4 sm:p-tk-5 border-2 transition-all",
                  "border-brand-500 shadow-tk-md bg-surface"
                )}
              >
                <div className="space-y-tk-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="brand" size="md">
                      Most Popular · India
                    </Badge>
                    <div className="flex items-center gap-1 text-xs font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-tk-full">
                      <QrCode className="w-3.5 h-3.5" />
                      <span>UPI & Cards</span>
                    </div>
                  </div>

                  <div>
                    <h2 className="text-tk-heading font-black text-ink">
                      {PLAN_DOMESTIC.name}
                    </h2>
                    <p className="text-tk-body-sm text-ink-muted mt-1">
                      {PLAN_DOMESTIC.description}
                    </p>
                  </div>

                  <div className="pt-tk-1 pb-tk-2 border-b border-line">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl sm:text-4xl font-black text-ink tracking-tight">
                        ₹{PLAN_DOMESTIC.price}
                      </span>
                      <span className="text-tk-body-sm text-ink-muted font-medium">
                        / {PLAN_DOMESTIC.period}
                      </span>
                    </div>
                    <p className="text-tk-caption text-ink-subtle mt-1">
                      Billed monthly.
                    </p>
                  </div>

                  {/* Features List */}
                  <div className="space-y-2 pt-1">
                    <div className="text-tk-caption font-bold uppercase tracking-wider text-ink-subtle">
                      Included with Pro:
                    </div>
                    <ul className="space-y-2">
                      {PLAN_DOMESTIC.features.map((feature, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-2.5 text-tk-body-sm text-ink"
                        >
                          <Check className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* India CTA Button */}
                <div className="mt-tk-5 pt-tk-3 border-t border-line space-y-2">
                  {isPro ? (
                    <Button
                      variant="primary"
                      size="lg"
                      fullWidth
                      disabled
                      className="bg-success-600 hover:bg-success-600"
                    >
                      <CheckCircle2 className="w-4 h-4 mr-1" />
                      Current Active Plan
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="lg"
                      fullWidth
                      loading={isCheckingOut}
                      loadingLabel={
                        paymentState.status === "creating_order"
                          ? "Creating order..."
                          : paymentState.status === "verifying"
                          ? "Verifying payment..."
                          : "Opening Razorpay..."
                      }
                      onClick={handleIndiaCheckout}
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Subscribe with Razorpay (Test)</span>
                    </Button>
                  )}

                  <p className="text-xs text-center text-ink-subtle">
                    {!user
                      ? "Sign in required to associate your subscription."
                      : "Test Sandbox: No real money is charged during testing."}
                  </p>
                </div>
              </Card>

              {/* Card 2: Global International Plan (Stripe - Coming Soon) */}
              <Card
                variant="surface"
                className="relative flex flex-col justify-between p-tk-4 sm:p-tk-5 border-line bg-surface opacity-90"
              >
                <div className="space-y-tk-3">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="neutral" size="md">
                      Global Pass
                    </Badge>
                    <div className="flex items-center gap-1 text-xs font-medium text-ink-muted bg-surface-muted px-2 py-0.5 rounded-tk-full">
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>Stripe Worldwide</span>
                    </div>
                  </div>

                  <div>
                    <h2 className="text-tk-heading font-black text-ink">
                      {PLAN_INTERNATIONAL.name}
                    </h2>
                    <p className="text-tk-body-sm text-ink-muted mt-1">
                      {PLAN_INTERNATIONAL.description}
                    </p>
                  </div>

                  <div className="pt-tk-1 pb-tk-2 border-b border-line">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl sm:text-4xl font-black text-ink tracking-tight">
                        ${PLAN_INTERNATIONAL.price}
                      </span>
                      <span className="text-tk-body-sm text-ink-muted font-medium">
                        / {PLAN_INTERNATIONAL.period}
                      </span>
                    </div>
                    <p className="text-tk-caption text-ink-subtle mt-1">
                      Billed monthly in USD across 37 global tech hubs.
                    </p>
                  </div>

                  {/* Features List */}
                  <div className="space-y-2 pt-1">
                    <div className="text-tk-caption font-bold uppercase tracking-wider text-ink-subtle">
                      Included with Pro:
                    </div>
                    <ul className="space-y-2">
                      {PLAN_INTERNATIONAL.features.map((feature, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-2.5 text-tk-body-sm text-ink-muted"
                        >
                          <Check className="w-4 h-4 text-ink-subtle shrink-0 mt-0.5" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* International CTA Button (Coming Soon) */}
                <div className="mt-tk-5 pt-tk-3 border-t border-line space-y-2">
                  <button
                    type="button"
                    disabled
                    className={cnTokens(
                      buttonClasses({ variant: "ghost", size: "lg", fullWidth: true }),
                      "border border-line bg-surface-muted text-ink-subtle cursor-not-allowed hover:bg-surface-muted"
                    )}
                  >
                    <span>Coming soon</span>
                  </button>
                  <p className="text-xs text-center text-ink-subtle">
                    International payment gateway integration is currently in rollout.
                  </p>
                </div>
              </Card>
            </div>

            {/* Reassurance & Value Props */}
            <div className="mt-tk-8 pt-tk-6 border-t border-line max-w-4xl mx-auto">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-tk-3 text-center sm:text-left">
                <div className="p-tk-2.5 rounded-tk-lg bg-surface border border-line space-y-1">
                  <div className="flex items-center gap-2 justify-center sm:justify-start text-brand-600 font-bold text-tk-body-sm">
                    <ShieldCheck className="w-4 h-4" />
                    <span>100% Direct ATS Links</span>
                  </div>
                  <p className="text-tk-caption text-ink-muted">
                    Every role links directly to official Greenhouse, Lever, Ashby, or Workday
                    postings. Never stale aggregator listings.
                  </p>
                </div>

                <div className="p-tk-2.5 rounded-tk-lg bg-surface border border-line space-y-1">
                  <div className="flex items-center gap-2 justify-center sm:justify-start text-brand-600 font-bold text-tk-body-sm">
                    <Lock className="w-4 h-4" />
                    <span>Verified Salary Bands</span>
                  </div>
                  <p className="text-tk-caption text-ink-muted">
                    Unmask transparent compensation brackets, equity allocations, and regional
                    geographic restrictions for all listings.
                  </p>
                </div>

                <div className="p-tk-2.5 rounded-tk-lg bg-surface border border-line space-y-1">
                  <div className="flex items-center gap-2 justify-center sm:justify-start text-brand-600 font-bold text-tk-body-sm">
                    <Sparkles className="w-4 h-4" />
                    <span>AI Match Diagnostics</span>
                  </div>
                  <p className="text-tk-caption text-ink-muted">
                    Tailor your resume and generate grounded cover letters tailored to
                    specific remote engineering and product specs.
                  </p>
                </div>
              </div>
            </div>

            {/* FAQ Section */}
            <div className="mt-tk-8 max-w-3xl mx-auto space-y-tk-4">
              <div className="text-center space-y-1">
                <h2 className="text-tk-heading font-black text-ink">
                  Frequently Asked Questions
                </h2>
                <p className="text-tk-body-sm text-ink-muted">
                  Everything you need to know about CareerMonke Pro and payments.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-tk-3">
                <Card variant="surface" className="p-tk-3 space-y-1">
                  <h3 className="text-tk-body-sm font-bold text-ink">
                    How does Razorpay Test mode work?
                  </h3>
                  <p className="text-tk-caption text-ink-muted leading-relaxed">
                    In test mode, no real card or bank account is debited. Razorpay provides
                    mock UPI and test card options so you can safely verify the Pro unlock
                    workflow.
                  </p>
                </Card>

                <Card variant="surface" className="p-tk-3 space-y-1">
                  <h3 className="text-tk-body-sm font-bold text-ink">
                    Can I cancel my subscription?
                  </h3>
                  <p className="text-tk-caption text-ink-muted leading-relaxed">
                    Yes. You can manage or cancel your subscription at any time under your
                    Account Billing settings with zero fees or retention locks.
                  </p>
                </Card>

                <Card variant="surface" className="p-tk-3 space-y-1">
                  <h3 className="text-tk-body-sm font-bold text-ink">
                    How fast is Pro access granted?
                  </h3>
                  <p className="text-tk-caption text-ink-muted leading-relaxed">
                    Immediately. As soon as your Razorpay live payment is verified, your
                    account subscription updates instantly and all paywalled fields unlock.
                  </p>
                </Card>

                <Card variant="surface" className="p-tk-3 space-y-1">
                  <h3 className="text-tk-body-sm font-bold text-ink">
                    Are jobs aggregated from job boards?
                  </h3>
                  <p className="text-tk-caption text-ink-muted leading-relaxed">
                    No. Our radar monitors company career pages directly. You apply before
                    roles are indexed by massive third-party job aggregators.
                  </p>
                </Card>
              </div>
            </div>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
