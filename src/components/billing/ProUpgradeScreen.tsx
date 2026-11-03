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
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface ProUpgradeScreenProps {
  title?: string;
  subtitle?: string;
}

export default function ProUpgradeScreen({
  title = "Unlock CareerMonke Pro",
  subtitle = "Complete your membership to access full job details, match scores, and AI application tools.",
}: ProUpgradeScreenProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<"weekly" | "monthly" | "quarterly">("monthly");

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
      <div className="w-full max-w-xl bg-surface rounded-tk-2xl border border-line p-6 sm:p-8 shadow-tk-xl space-y-6 text-center text-ink">
        {/* Lock Badge */}
        <div className="w-14 h-14 rounded-tk-2xl bg-brand-50 border border-brand-200 text-brand-600 flex items-center justify-center mx-auto shadow-tk-xs">
          <Lock className="w-7 h-7" />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
            {title}
          </h1>
          <p className="text-xs sm:text-sm text-ink-muted max-w-md mx-auto leading-relaxed">
            {subtitle}
          </p>
        </div>

        {/* Plan Switcher */}
        <div className="grid grid-cols-3 gap-2 p-1 bg-surface-muted rounded-tk-xl border border-line">
          <button
            type="button"
            onClick={() => setSelectedPlanId("weekly")}
            className={`py-2 px-2 rounded-tk-lg text-xs font-bold transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
              selectedPlanId === "weekly"
                ? "bg-surface text-brand-600 shadow-tk-xs border border-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span>Weekly</span>
            <span className="text-[11px] font-semibold text-ink-muted">₹692 / wk</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectedPlanId("monthly")}
            className={`py-2 px-2 rounded-tk-lg text-xs font-bold transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
              selectedPlanId === "monthly"
                ? "bg-surface text-brand-600 shadow-tk-xs border border-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span>Monthly</span>
            <span className="text-[11px] font-semibold text-ink-muted">₹1,499 / mo</span>
          </button>
          <button
            type="button"
            onClick={() => setSelectedPlanId("quarterly")}
            className={`py-2 px-2 rounded-tk-lg text-xs font-bold transition cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
              selectedPlanId === "quarterly"
                ? "bg-surface text-brand-600 shadow-tk-xs border border-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span>Quarterly</span>
            <span className="text-[11px] font-semibold text-ink-muted">₹3,999 / 3mo</span>
          </button>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 gap-2.5 text-left">
          {proFeatures.map((feat) => {
            const Icon = feat.icon;
            return (
              <div
                key={feat.title}
                className="flex items-start gap-3 p-3.5 rounded-tk-xl bg-surface-subtle border border-line hover:border-line-strong transition"
              >
                <div className="p-2 rounded-tk-lg bg-surface text-brand-600 border border-line shrink-0">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="space-y-0.5 min-w-0">
                  <h3 className="text-xs sm:text-sm font-bold text-ink flex items-center gap-1.5">
                    <span>{feat.title}</span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-success-600" />
                  </h3>
                  <p className="text-xs text-ink-muted leading-normal">
                    {feat.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Primary Action Button: Links to /pricing */}
        <div className="pt-2 space-y-2">
          <Link
            href="/pricing"
            className="w-full h-12 rounded-tk-lg bg-brand-600 hover:bg-brand-700 text-ink-inverse font-semibold flex items-center justify-center gap-2 shadow-tk-sm transition-colors cursor-pointer text-sm sm:text-base min-h-[48px]"
          >
            <span>View Pro Plans</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
          <p className="text-xs text-ink-muted font-medium">
            UPI, RuPay, NetBanking & Cards
          </p>
        </div>

        {/* Secondary Navigation */}
        <div className="pt-4 border-t border-line flex items-center justify-between text-xs text-ink-muted">
          <Link href="/" className="hover:text-brand-600 font-medium">
            ← Back to Home
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="hover:text-danger-600 font-medium inline-flex items-center gap-1 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
