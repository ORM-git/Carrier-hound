"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Lock,
  Sparkles,
  Building2,
  TrendingUp,
  FileText,
  FileCheck2,
  CheckCircle2,
  LogOut,
  Loader2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL, BillingPlan } from "@/lib/billing/types";
import { handleProCheckout } from "@/lib/billing/checkout";

interface ProUpgradeScreenProps {
  title?: string;
  subtitle?: string;
}

export default function ProUpgradeScreen({
  title = "Unlock CareerMonke Pro",
  subtitle = "Complete your membership to access full job details, match scores, and AI application tools.",
}: ProUpgradeScreenProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<"domestic" | "intl">("domestic");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPlan = selectedPlanId === "domestic" ? PLAN_DOMESTIC : PLAN_INTERNATIONAL;

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);
    await handleProCheckout(selectedPlan, {
      redirectTarget: typeof window !== "undefined" ? window.location.pathname + window.location.search : "/dashboard",
      onError: (err) => {
        setError(err);
        setLoading(false);
      },
      onSuccess: () => {
        setLoading(false);
      },
    });
  };

  const handleSignOut = async () => {
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch {}
  };

  const proFeatures = [
    {
      icon: Building2,
      title: "Full Job Details",
      desc: "Verified employer names, salaries, remote scope, and direct ATS apply links.",
    },
    {
      icon: TrendingUp,
      title: "Compatibility Scores",
      desc: "Instant fit percentages computed from your verified skills and experience.",
    },
    {
      icon: Sparkles,
      title: "Your Top 10 Jobs",
      desc: "The 10 highest-matching roles ranked across our full live dataset.",
    },
    {
      icon: FileCheck2,
      title: "AI-Powered Resume Tools",
      desc: "Highlights and formats relevant skills for each opening.",
    },
    {
      icon: FileText,
      title: "Tailored Cover Letters",
      desc: "Generates role-specific cover letters grounded in your profile facts.",
    },
  ];

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4 sm:p-6 animate-fadeIn">
      <div className="w-full max-w-xl bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xl space-y-6 text-center">
        {/* Lock Badge */}
        <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center mx-auto shadow-xs">
          <Lock className="w-7 h-7" />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
            {title}
          </h1>
          <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
            {subtitle}
          </p>
        </div>

        {/* Plan Switcher */}
        <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-2xl">
          <button
            type="button"
            onClick={() => setSelectedPlanId("domestic")}
            className={`py-2 px-3 rounded-xl text-xs font-bold transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
              selectedPlanId === "domestic"
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>India Domestic</span>
            <span className="text-[11px] font-semibold text-slate-500">₹199 / month</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectedPlanId("intl")}
            className={`py-2 px-3 rounded-xl text-xs font-bold transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
              selectedPlanId === "intl"
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>International</span>
            <span className="text-[11px] font-semibold text-slate-500">$9 / month</span>
          </button>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 gap-2.5 text-left">
          {proFeatures.map((feat) => {
            const Icon = feat.icon;
            return (
              <div
                key={feat.title}
                className="flex items-start gap-3 p-3.5 rounded-2xl bg-slate-50 border border-slate-100 hover:border-slate-200 transition"
              >
                <div className="p-2 rounded-xl bg-white text-blue-600 border border-slate-200 shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="space-y-0.5 min-w-0">
                  <h3 className="text-xs sm:text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>{feat.title}</span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  </h3>
                  <p className="text-xs text-slate-500 leading-normal">
                    {feat.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 text-center">
            {error}
          </div>
        )}

        {/* Upgrade Action Button: Disabled Coming Soon State */}
        <div className="pt-2 space-y-2">
          <button
            type="button"
            disabled
            className="w-full py-3.5 px-6 rounded-2xl bg-slate-200 text-slate-500 font-bold text-sm border border-slate-300/80 cursor-not-allowed select-none transition flex items-center justify-center gap-2 shadow-none"
          >
            <Lock className="w-4 h-4 text-slate-400" />
            <span>Payments Coming Soon</span>
          </button>
          <p className="text-[11px] text-slate-500 font-medium">
            Payments launching soon
          </p>
        </div>

        {/* Secondary Navigation */}
        <div className="pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <Link href="/" className="hover:text-blue-600 font-medium">
            ← Back to Home
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="hover:text-red-600 font-medium inline-flex items-center gap-1 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
