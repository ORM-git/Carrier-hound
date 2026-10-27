"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  X,
  Check,
  ShieldCheck,
  Sparkles,
  Lock,
  ArrowRight,
  CheckCircle2,
  LogIn,
  QrCode,
  Globe,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL } from "@/lib/billing/types";

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
  const [currentUser, setCurrentUser] = useState<User | null>(initialUser ?? null);
  const [selectedPlanId, setSelectedPlanId] = useState<"domestic" | "intl">("domestic");
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

  if (!open) return null;

  const loginNextUrl =
    redirectUrl ||
    (typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/pricing");

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-[#0F172A]/60 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-lg bg-surface rounded-t-[20px] sm:rounded-[20px] shadow-popover overflow-hidden border border-line animate-slideUp sm:animate-scaleUp max-h-[94dvh] sm:max-h-[90vh] flex flex-col text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Drag Indicator Handle */}
        <div className="w-full flex items-center justify-center pt-2.5 pb-1 sm:hidden bg-brand-900/90 shrink-0">
          <div className="w-10 h-1 rounded-tk-full bg-surface/40" />
        </div>

        {/* Close Button */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute top-3 right-3 sm:top-3.5 sm:right-3.5 z-20 w-11 h-11 rounded-tk-full bg-surface-subtle hover:bg-surface-muted border border-line text-ink-muted hover:text-ink flex items-center justify-center transition-colors cursor-pointer min-h-[44px] min-w-[44px]"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Pro Upgrade Content */}
        <div className="overflow-y-auto flex-1 min-h-0 overscroll-contain">
          {/* Header */}
          <div className="bg-surface border-b border-line p-4 sm:p-4 relative pr-14">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-tk-full text-xs font-bold uppercase tracking-wider bg-brand-50 text-brand-700 border border-brand-200">
                <Sparkles className="w-3.5 h-3.5 text-brand-600" /> Pro Member Access
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-tk-full text-xs font-semibold bg-success-50 text-success-700 border border-success-200">
                <ShieldCheck className="w-3.5 h-3.5 text-success-600" /> Verified Direct
              </span>
            </div>
            <h3 className="text-xl sm:text-2xl font-black text-ink tracking-tight leading-snug">
              {title}
            </h3>
            <p className="text-ink-muted text-xs sm:text-sm mt-1.5 leading-relaxed">
              {subtitle}
            </p>
          </div>

          {/* Content Body */}
          <div className="p-4 sm:p-4 space-y-3 pb-8 sm:pb-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
            {/* Billing Plan Selector: India vs International */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-ink-muted uppercase tracking-wider block">
                Select Billing Option:
              </span>
              <div className="grid grid-cols-2 gap-3">
                {/* Domestic Razorpay Option */}
                <div
                  onClick={() => setSelectedPlanId("domestic")}
                  className={`p-3.5 rounded-tk-xl border-2 transition-all cursor-pointer ${
                    selectedPlanId === "domestic"
                      ? "border-brand-500 bg-brand-50/50 shadow-tk-xs"
                      : "border-line hover:border-line-strong bg-surface"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-brand-900 flex items-center gap-1">
                      <QrCode className="w-3.5 h-3.5 text-brand-600" />
                      India Domestic
                    </span>
                    {selectedPlanId === "domestic" && (
                      <span className="w-2 h-2 rounded-tk-full bg-brand-600" />
                    )}
                  </div>
                  <div className="text-lg font-black text-ink leading-none">
                    {PLAN_DOMESTIC.formattedPrice}
                  </div>
                  <p className="text-xs text-ink-muted mt-1">
                    UPI, RuPay, NetBanking & Cards
                  </p>
                </div>

                {/* International Stripe Option */}
                <div
                  onClick={() => setSelectedPlanId("intl")}
                  className={`p-3.5 rounded-tk-xl border-2 transition-all cursor-pointer ${
                    selectedPlanId === "intl"
                      ? "border-brand-500 bg-brand-50/50 shadow-tk-xs"
                      : "border-line hover:border-line-strong bg-surface"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-ink flex items-center gap-1">
                      <Globe className="w-3.5 h-3.5 text-ink-muted" />
                      International
                    </span>
                    {selectedPlanId === "intl" && (
                      <span className="w-2 h-2 rounded-tk-full bg-brand-600" />
                    )}
                  </div>
                  <div className="text-lg font-black text-ink leading-none">
                    {PLAN_INTERNATIONAL.formattedPrice}
                  </div>
                  <p className="text-xs text-ink-muted mt-1">
                    Global Cards & Apple Pay
                  </p>
                </div>
              </div>
            </div>

            {/* Value Proposition Highlights */}
            <div className="bg-surface-subtle p-4 rounded-tk-xl border border-line">
              <div className="text-xs font-bold text-ink uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-brand-600" />
                Included in Your Membership:
              </div>
              <ul className="space-y-1.5 text-xs text-ink-muted">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-ink">Direct ATS Endpoints:</strong> Apply directly on official Greenhouse, Lever, and Ashby portals.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-ink">Unmasked Compensation:</strong> View verified salary bands and equity packages from real listings.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-ink">7-Day Renewal Grace Period:</strong> Uninterrupted radar telemetry access even if bank card renews late.
                  </span>
                </li>
              </ul>
            </div>

            {/* Primary Action Button: Links directly to /pricing */}
            <div className="space-y-2 pt-1">
              <Link
                href="/pricing"
                onClick={() => onOpenChange(false)}
                className="w-full h-12 rounded-tk-lg bg-brand-600 hover:bg-brand-700 text-ink-inverse font-semibold flex items-center justify-center gap-2 shadow-tk-sm transition-colors cursor-pointer text-sm sm:text-base min-h-[48px]"
              >
                <span>See Pro Plans - ₹199/mo</span>
                <ArrowRight className="w-4 h-4" />
              </Link>

              {currentUser ? (
                <div className="p-2.5 rounded-tk-lg bg-surface-subtle border border-line flex items-center justify-between text-xs">
                  <span className="text-ink-muted">Signed in:</span>
                  <span className="font-semibold text-ink font-mono truncate max-w-[200px]">
                    {email || "Authenticated User"}
                  </span>
                </div>
              ) : (
                <div className="text-center pt-1">
                  <Link
                    href={`/login?returnTo=${encodeURIComponent(loginNextUrl)}`}
                    onClick={() => onOpenChange(false)}
                    className="text-xs text-brand-600 hover:text-brand-700 font-semibold inline-flex items-center gap-1"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>Sign in to save preference</span>
                  </Link>
                </div>
              )}
            </div>

            {/* Trust Footer Links */}
            <div className="flex items-center justify-center gap-4 text-xs text-ink-muted pt-2 border-t border-line">
              <Link
                href="/terms-and-conditions"
                target="_blank"
                className="hover:text-ink transition-colors"
              >
                Terms of Service
              </Link>
              <span>•</span>
              <Link
                href="/privacy-policy"
                target="_blank"
                className="hover:text-ink transition-colors"
              >
                Privacy Policy
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
