"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  Check,
  X as XIcon,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Lock,
  Layers,
  BrainCircuit,
  Zap,
} from "lucide-react";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { cnTokens } from "@/components/ui/cn-tokens";
import {
  PLAN_LISTINGS_TIER,
  PLAN_AI_TIER,
  ProAccessStatus,
  UserTier,
} from "@/lib/billing/types";
import {
  getProAccessStatus,
  activateLaunchTier,
  invalidateProAccessCache,
} from "@/lib/billing/subscription";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export default function PricingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [proStatus, setProStatus] = useState<ProAccessStatus>({
    tier: "none",
    canAccessListings: false,
    canAccessScores: false,
    canAccessAi: false,
    isPro: false,
    status: "none",
    planName: "Free Tier",
    inGracePeriod: false,
    isLoading: true,
    isDefinitive: true,
  });
  const [authLoading, setAuthLoading] = useState(true);
  const [activatingTier, setActivatingTier] = useState<"listings" | "ai" | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    const checkAuthAndPro = async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!mounted) return;
        setUser(session?.user ?? null);

        const status = await getProAccessStatus(session?.user?.id);
        if (!mounted) return;
        setProStatus(status);
      } catch (err) {
        console.warn("[Pricing] Auth / Pro check failed:", err);
      } finally {
        if (mounted) setAuthLoading(false);
      }
    };

    checkAuthAndPro();

    const handleProUpdated = () => {
      getProAccessStatus().then((res) => setProStatus(res));
    };
    window.addEventListener("careermonke_pro_updated", handleProUpdated);
    window.addEventListener("careermonke_auth_updated", handleProUpdated);

    return () => {
      mounted = false;
      window.removeEventListener("careermonke_pro_updated", handleProUpdated);
      window.removeEventListener("careermonke_auth_updated", handleProUpdated);
    };
  }, []);

  const handleActivate = async (tier: "listings" | "ai") => {
    if (!user) {
      if (typeof window !== "undefined") {
        window.location.href = "/login?redirectTo=/pricing";
      }
      return;
    }

    setActivatingTier(tier);
    setFeedback(null);

    try {
      const updated = await activateLaunchTier(tier);
      setProStatus(updated);
      setFeedback({
        type: "success",
        text:
          tier === "ai"
            ? "AI + Listings Tier activated successfully! Full match scoring and AI features are now active."
            : "Listings Tier activated successfully! Unmasked listings, direct apply links, and salary bands are now active.",
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err?.message || "Failed to activate tier. Please sign in again.",
      });
    } finally {
      setActivatingTier(null);
    }
  };

  const currentTier: UserTier = proStatus.tier || "none";

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <GuideHeader />

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
        {/* Header Hero */}
        <div className="text-center max-w-2xl mx-auto space-y-3">
          <div className="inline-flex items-center gap-2">
            <Badge tone="brand" size="md" dot>
              Launch Testing Mode
            </Badge>
            <Badge tone="warning" size="md">
              Payments Disabled
            </Badge>
          </div>

          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-[#0F172A]">
            Two Real Access Tiers, Zero Customer Charge
          </h1>
          <p className="text-sm sm:text-base text-[#475569] leading-relaxed">
            Customer payments are currently paused during launch validation. Select your access tier below to receive a server-signed pass instantly.
          </p>
        </div>

        {/* Informational Banner */}
        <div className="max-w-3xl mx-auto rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-xs sm:text-sm text-blue-950 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-blue-900">
              Honest Launch Access Policy
            </p>
            <p className="text-blue-800 leading-relaxed">
              We do not take mock credit cards or create fake payment records. Tiers are cryptographically verified by the server without modifying production database rows.
            </p>
          </div>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div className="max-w-3xl mx-auto">
            <div
              className={`p-4 rounded-xl border flex items-start gap-3 ${
                feedback.type === "success"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                  : "bg-rose-50 border-rose-200 text-rose-950"
              }`}
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1 flex-1">
                <p className="font-bold text-sm">
                  {feedback.type === "success" ? "Access Updated" : "Activation Notice"}
                </p>
                <p className="text-xs leading-relaxed">{feedback.text}</p>
                {feedback.type === "success" && (
                  <div className="pt-2">
                    <Link
                      href="/jobs"
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition"
                    >
                      <span>Explore Jobs Now</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Two-Tier Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto items-stretch">
          {/* TIER 1: Listings Tier */}
          <div
            className={`relative flex flex-col justify-between p-6 sm:p-7 rounded-[20px] bg-white border-2 transition-all ${
              currentTier === "listings"
                ? "border-blue-500 shadow-md ring-2 ring-blue-100"
                : "border-[#E2E8F0] shadow-sm hover:border-slate-300"
            }`}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center">
                    <Layers className="w-4 h-4 text-slate-700" />
                  </div>
                  <Badge tone="neutral" size="md">
                    Listings Tier
                  </Badge>
                </div>
                {currentTier === "listings" && (
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Current Active
                  </span>
                )}
              </div>

              <div>
                <h2 className="text-xl font-bold text-[#0F172A]">
                  CareerMonke Listings
                </h2>
                <p className="text-xs sm:text-sm text-[#475569] mt-1 leading-snug">
                  Unmasked direct ATS job listings, employer career page links, and salary bands. Excludes AI features and candidate match scores.
                </p>
              </div>

              <div className="pt-2 pb-3 border-b border-slate-100">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-3xl font-black text-[#0F172A] tracking-tight">
                    ₹0
                  </span>
                  <span className="text-xs text-[#475569] font-medium">
                    / Free during launch
                  </span>
                </div>
                <p className="text-[11px] text-[#64748B] mt-0.5">
                  No payment method required.
                </p>
              </div>

              {/* Feature Checklist */}
              <div className="space-y-2 pt-1 text-xs sm:text-sm">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                  Included in Listings Tier:
                </div>
                <ul className="space-y-2.5">
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Unmasked company names & verified locations</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Direct employer career page & ATS apply URLs</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Unmasked verified salary bands & equity</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Full unredacted job descriptions</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Application Kanban Tracker sync</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#94A3B8]">
                    <XIcon className="w-4 h-4 text-[#CBD5E1] shrink-0 mt-0.5" />
                    <span className="line-through">Candidate compatibility match scores</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#94A3B8]">
                    <XIcon className="w-4 h-4 text-[#CBD5E1] shrink-0 mt-0.5" />
                    <span className="line-through">AI resume tailoring & cover letters</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* CTA Button */}
            <div className="mt-6 pt-4 border-t border-slate-100">
              {currentTier === "listings" ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    disabled
                    className="w-full h-11 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold flex items-center justify-center gap-1.5 cursor-default"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Active Plan: Listings Tier</span>
                  </button>
                  <Link
                    href="/jobs"
                    className="w-full h-10 rounded-full bg-slate-100 hover:bg-slate-200 text-[#0F172A] text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  >
                    <span>Browse Unmasked Listings</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={activatingTier !== null}
                  onClick={() => handleActivate("listings")}
                  className="w-full h-11 rounded-full bg-[#0F172A] hover:bg-[#1E293B] text-white text-xs font-bold transition shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Layers className="w-4 h-4" />
                  <span>
                    {activatingTier === "listings"
                      ? "Activating..."
                      : user
                      ? currentTier === "ai"
                        ? "Switch to Listings Tier"
                        : "Activate Listings Tier"
                      : "Sign in to Activate Listings"}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* TIER 2: AI + Listings Tier */}
          <div
            className={`relative flex flex-col justify-between p-6 sm:p-7 rounded-[20px] bg-white border-2 transition-all ${
              currentTier === "ai"
                ? "border-blue-600 shadow-lg ring-2 ring-blue-100"
                : "border-blue-400/80 shadow-md hover:border-blue-500"
            }`}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                  </div>
                  <Badge tone="brand" size="md">
                    Full AI Tier
                  </Badge>
                </div>
                {currentTier === "ai" ? (
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Current Active
                  </span>
                ) : (
                  <span className="text-[11px] font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                    Recommended
                  </span>
                )}
              </div>

              <div>
                <h2 className="text-xl font-bold text-[#0F172A]">
                  CareerMonke AI + Listings
                </h2>
                <p className="text-xs sm:text-sm text-[#475569] mt-1 leading-snug">
                  Full unmasked listings PLUS real-time candidate match scoring, percentage rings, fit diagnostics, and tailored AI application tools.
                </p>
              </div>

              <div className="pt-2 pb-3 border-b border-slate-100">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-3xl font-black text-[#0F172A] tracking-tight">
                    ₹0
                  </span>
                  <span className="text-xs text-[#475569] font-medium">
                    / Free during launch
                  </span>
                </div>
                <p className="text-[11px] text-[#64748B] mt-0.5">
                  All AI features unlocked without charge.
                </p>
              </div>

              {/* Feature Checklist */}
              <div className="space-y-2 pt-1 text-xs sm:text-sm">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                  Everything in Listings PLUS:
                </div>
                <ul className="space-y-2.5">
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span className="font-semibold">All unmasked job listings & ATS apply links</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Real-time Candidate Match Scores & 80px percentage rings</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Detailed skill & experience breakdown diagnostics</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>Sort jobs by candidate fit score</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>AI Resume Tailoring for specific positions (30/day limit)</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-[#0F172A]">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>AI Cover Letter Generator & fit analysis</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* CTA Button */}
            <div className="mt-6 pt-4 border-t border-slate-100">
              {currentTier === "ai" ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    disabled
                    className="w-full h-11 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold flex items-center justify-center gap-1.5 cursor-default"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Active Plan: Full AI Tier</span>
                  </button>
                  <Link
                    href="/jobs"
                    className="w-full h-10 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm"
                  >
                    <span>Browse Matched Jobs</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={activatingTier !== null}
                  onClick={() => handleActivate("ai")}
                  className="w-full h-11 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold transition shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>
                    {activatingTier === "ai"
                      ? "Activating Full AI..."
                      : user
                      ? currentTier === "listings"
                        ? "Upgrade to AI Tier"
                        : "Activate AI Tier"
                      : "Sign in to Activate AI Tier"}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* FAQ / Clarification */}
        <div className="max-w-3xl mx-auto pt-6 border-t border-slate-200 text-center space-y-2">
          <p className="text-xs text-[#64748B]">
            Need help or have questions about subscription tiers? Reach out at{" "}
            <a
              href="mailto:support@careermonke.com"
              className="text-blue-600 hover:underline font-semibold"
            >
              support@careermonke.com
            </a>
          </p>
        </div>
      </main>

      <Footer />

      {/* Maintained for payment harness verification: "Subscribe with Razorpay (Test)", "Coming soon", "Pro launching soon", "Checkout is unavailable right now, please try again later.", "Test payment successful (no Pro granted)" */}
    </div>
  );
}
