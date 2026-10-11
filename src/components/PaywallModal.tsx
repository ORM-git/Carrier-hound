"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  X,
  Check,
  ShieldCheck,
  Zap,
  Sparkles,
  Lock,
  ArrowRight,
  CheckCircle2,
  LogIn,
  ExternalLink,
  CreditCard,
  QrCode,
  Globe,
  Loader2,
} from "lucide-react";
import BrandIcon from "./BrandIcon";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL } from "@/lib/billing/types";
import { openRazorpayCheckout } from "@/lib/billing/razorpay";
import { redirectToStripeCheckout } from "@/lib/billing/stripe";
import { toast } from "react-toastify";
import { setLocalProActive } from "@/lib/billing/subscription";
import { handleProCheckout } from "@/lib/billing/checkout";

interface PaywallModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  subtitle?: string;
  featureTitle?: string;
  user?: User | null;
  onSuccess?: () => void;
  redirectUrl?: string;
}

export default function PaywallModal({
  open,
  onOpenChange,
  title = "Unlock CareerMonke Pro Access",
  subtitle = "Direct access to unlisted company career endpoints, verified compensation bands, and ATS links.",
  featureTitle,
  user: initialUser,
  onSuccess,
  redirectUrl,
}: PaywallModalProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(initialUser ?? null);
  const [selectedPlanId, setSelectedPlanId] = useState<"domestic" | "intl">("domestic");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (initialUser) {
      setCurrentUser(initialUser);
      if (initialUser?.email) setEmail(initialUser.email);
    } else {
      const localEmail =
        typeof window !== "undefined"
          ? localStorage.getItem("careermonke_user_email")
          : null;
      if (localEmail) {
        const u = {
          id: "local-user",
          email: localEmail,
          user_metadata: {},
        } as User;
        setCurrentUser(u);
        setEmail(localEmail);
      } else {
        const supabase = createClient();
        supabase.auth.getUser().then(({ data }: any) => {
          setCurrentUser(data?.user || null);
          if (data?.user?.email) setEmail(data.user.email);
        });
      }
    }
  }, [initialUser, open]);

  const selectedPlan = selectedPlanId === "domestic" ? PLAN_DOMESTIC : PLAN_INTERNATIONAL;

  const handleCheckout = async () => {
    setIsProcessing(true);
    await handleProCheckout(selectedPlan, {
      redirectTarget: loginNextUrl,
      onError: (err) => {
        toast.error(err);
        setIsProcessing(false);
      },
      onSuccess: () => {
        setIsSuccess(true);
        setIsProcessing(false);
        onSuccess?.();
      },
    });
  };

  if (!open) return null;

  const loginNextUrl =
    redirectUrl ||
    (typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/radar");

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-lg bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden border border-gray-100 animate-slideUp sm:animate-scaleUp max-h-[94dvh] sm:max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Drag Indicator Handle */}
        <div className="w-full flex items-center justify-center pt-2.5 pb-1 sm:hidden bg-blue-900/90 shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/40" />
        </div>

        {/* Close Button */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute top-3 right-3 sm:top-3.5 sm:right-3.5 z-20 w-11 h-11 rounded-full bg-black/20 sm:bg-white/20 hover:bg-black/40 sm:hover:bg-white/30 text-white flex items-center justify-center transition-colors cursor-pointer min-h-[44px] min-w-[44px]"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>

        {isSuccess ? (
          /* Success Screen */
          <div className="p-6 sm:p-10 text-center space-y-5 overflow-y-auto pb-10 sm:pb-10">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center shadow-inner">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-bold text-gray-900">CareerMonke Pro Unlocked</h3>
              <p className="text-sm text-gray-600 max-w-md mx-auto">
                Full direct ATS access has been granted for <strong className="text-gray-900">{email || "your account"}</strong>. You can now view all unmasked salary bands, direct company links, and locations.
              </p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsSuccess(false);
                  onOpenChange(false);
                  if (typeof window !== "undefined") {
                    window.location.reload();
                  }
                }}
                className="w-full min-h-[44px] bg-[#2563EB] hover:bg-[#1D4ED8] text-white py-3 rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center cursor-pointer"
              >
                Continue & See Everything Behind Paywall
              </button>
            </div>
          </div>
        ) : (
          /* Pro Upgrade Screen */
          <div className="overflow-y-auto flex-1 min-h-0 overscroll-contain">
            {/* Header in Brand Blue (#2563EB) */}
            <div className="bg-gradient-to-br from-[#1E40AF] via-[#2563EB] to-[#3B82F6] text-white p-6 sm:p-7 relative">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-white/20 text-white backdrop-blur-xs">
                  <Sparkles className="w-3.5 h-3.5 text-yellow-300" /> Pro Member Access
                </span>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-400/20 text-emerald-200">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" /> Verified Direct
                </span>
              </div>
              <h3 className="text-xl sm:text-2xl font-black text-white tracking-tight leading-snug">
                {title}
              </h3>
              <p className="text-white/85 text-xs sm:text-sm mt-1.5 leading-relaxed">
                {subtitle}
              </p>
            </div>

            {/* Content Body */}
            <div className="p-6 sm:p-7 space-y-5 pb-8 sm:pb-7 pb-[max(2rem,env(safe-area-inset-bottom))]">
              {/* Billing Plan Selector: Razorpay vs Stripe */}
              <div className="space-y-2">
                <span className="text-xs font-bold text-gray-700 uppercase tracking-wider block">
                  Select Billing Option:
                </span>
                <div className="grid grid-cols-2 gap-3">
                  {/* Domestic Razorpay Option */}
                  <div
                    onClick={() => setSelectedPlanId("domestic")}
                    className={`p-3.5 rounded-xl border-2 transition-all cursor-pointer ${
                      selectedPlanId === "domestic"
                        ? "border-[#2563EB] bg-blue-50/70 shadow-xs"
                        : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-blue-900 flex items-center gap-1">
                        <QrCode className="w-3.5 h-3.5 text-blue-600" />
                        India Domestic
                      </span>
                      {selectedPlanId === "domestic" && (
                        <span className="w-2 h-2 rounded-full bg-[#2563EB]" />
                      )}
                    </div>
                    <div className="text-lg font-black text-gray-900 leading-none">
                      {PLAN_DOMESTIC.formattedPrice}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">
                      UPI, RuPay, NetBanking & Cards (Razorpay)
                    </p>
                  </div>

                  {/* International Stripe Option */}
                  <div
                    onClick={() => setSelectedPlanId("intl")}
                    className={`p-3.5 rounded-xl border-2 transition-all cursor-pointer ${
                      selectedPlanId === "intl"
                        ? "border-[#2563EB] bg-blue-50/70 shadow-xs"
                        : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-slate-900 flex items-center gap-1">
                        <Globe className="w-3.5 h-3.5 text-slate-700" />
                        International
                      </span>
                      {selectedPlanId === "intl" && (
                        <span className="w-2 h-2 rounded-full bg-[#2563EB]" />
                      )}
                    </div>
                    <div className="text-lg font-black text-gray-900 leading-none">
                      {PLAN_INTERNATIONAL.formattedPrice}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">
                      Global Credit Cards & Apple Pay (Stripe)
                    </p>
                  </div>
                </div>
              </div>

              {/* Value Proposition Highlights */}
              <div className="bg-blue-50/60 p-4 rounded-xl border border-blue-100/80">
                <div className="text-xs font-bold text-blue-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-[#2563EB]" />
                  Included in Your Membership:
                </div>
                <ul className="space-y-1.5 text-xs text-gray-700">
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-gray-900">Direct ATS Endpoints:</strong> Apply directly on official Greenhouse, Lever, and Ashby portals.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-gray-900">Unmasked Compensation:</strong> View verified salary bands and equity packages from real listings.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-gray-900">7-Day Renewal Grace Period:</strong> Uninterrupted radar telemetry access even if bank card renews late.
                    </span>
                  </li>
                </ul>
              </div>

              {/* Action State: Honest Disabled Coming Soon State */}
              {!currentUser ? (
                /* Visitor is NOT signed in: show disabled Coming Soon state with option to sign in */
                <div className="space-y-3 pt-1">
                  <button
                    type="button"
                    disabled
                    className="w-full min-h-[48px] bg-slate-200 text-slate-500 py-3.5 rounded-xl font-bold text-sm sm:text-base border border-slate-300/80 cursor-not-allowed select-none transition-all flex items-center justify-center gap-2 shadow-none"
                  >
                    <Lock className="w-4 h-4 text-slate-400" />
                    <span>Payments Coming Soon</span>
                  </button>
                  <p className="text-[11px] text-center text-slate-500 font-medium">
                    Payments launching soon
                  </p>

                  <div className="text-center pt-1">
                    <Link
                      href={`/login?next=${encodeURIComponent(loginNextUrl)}`}
                      onClick={() => onOpenChange(false)}
                      className="text-xs text-blue-600 hover:text-blue-800 font-semibold inline-flex items-center gap-1"
                    >
                      <LogIn className="w-3.5 h-3.5" />
                      <span>Sign in with existing account</span>
                    </Link>
                  </div>
                </div>
              ) : (
                /* User IS signed in: show disabled Coming Soon state */
                <div className="space-y-3 pt-1">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                    <span className="text-slate-500 font-medium">Logged in account:</span>
                    <span className="font-semibold text-slate-800 font-mono truncate max-w-[200px]">
                      {email || "Authenticated User"}
                    </span>
                  </div>

                  <button
                    type="button"
                    disabled
                    className="w-full min-h-[48px] bg-slate-200 text-slate-500 py-3.5 rounded-xl font-bold text-sm sm:text-base border border-slate-300/80 cursor-not-allowed select-none transition-all flex items-center justify-center gap-2 shadow-none"
                  >
                    <Lock className="w-4 h-4 text-slate-400" />
                    <span>Payments Coming Soon</span>
                  </button>
                  <p className="text-[11px] text-center text-slate-500 font-medium">
                    Payments launching soon
                  </p>
                </div>
              )}

              {/* Trust Footer Links */}
              <div className="flex items-center justify-center gap-4 text-[11px] text-gray-500 pt-1 border-t border-gray-100">
                <Link
                  href="/terms-and-conditions"
                  target="_blank"
                  className="hover:text-gray-900 transition-colors"
                >
                  Terms of Service
                </Link>
                <span>•</span>
                <Link
                  href="/privacy-policy"
                  target="_blank"
                  className="hover:text-gray-900 transition-colors"
                >
                  Privacy Policy
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
