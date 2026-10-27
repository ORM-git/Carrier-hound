"use client";

import React from "react";
import { Building2, Compass, Newspaper, ShieldAlert, Sparkles, ExternalLink } from "lucide-react";
import type { InterviewPackData } from "@/data/interviewPackFixture";

interface BriefSectionProps {
  brief: InterviewPackData["brief"];
  companyName: string;
}

export default function BriefSection({ brief, companyName }: BriefSectionProps) {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
          <Building2 className="w-4 h-4" />
          <span>Section 1 · Executive Dossier</span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          Company Brief & Intel for {companyName}
        </h2>
        <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
          High-level operational context, recent strategic press, and verified culture signals so you speak their internal language.
        </p>
      </div>

      {/* Overview & Mission Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#0F172A]">
            <Compass className="w-4 h-4 text-[#2563EB]" />
            <span>Mission & Purpose</span>
          </div>
          <p className="text-[15px] text-[#334155] leading-relaxed font-medium">
            &ldquo;{brief.mission}&rdquo;
          </p>
        </div>

        <div className="p-6 rounded-2xl bg-white ring-1 ring-[#E2E8F0] shadow-xs space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#0F172A]">
            <Sparkles className="w-4 h-4 text-[#2563EB]" />
            <span>Market Positioning</span>
          </div>
          <p className="text-[15px] text-[#334155] leading-relaxed font-medium">
            {brief.marketContext}
          </p>
        </div>
      </div>

      {/* Summary */}
      <div className="p-6 rounded-2xl bg-[#F8FAFC] ring-1 ring-[#E2E8F0] space-y-2">
        <h3 className="text-sm font-bold text-[#0F172A] uppercase tracking-wider">
          Company Overview
        </h3>
        <p className="text-[15px] text-[#334155] leading-relaxed">
          {brief.summary}
        </p>
      </div>

      {/* Recent Public News */}
      <div className="space-y-4">
        <h3 className="text-lg font-bold text-[#0F172A] flex items-center gap-2">
          <Newspaper className="w-5 h-5 text-[#2563EB]" />
          <span>Recent News & Product Launches (Drop these in conversation)</span>
        </h3>

        <div className="space-y-3">
          {brief.recentNews.map((news, idx) => (
            <div
              key={idx}
              className="p-5 rounded-xl bg-white ring-1 ring-[#E2E8F0] hover:ring-[#93C5FD] transition space-y-2"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <a
                  href={news.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[16px] font-bold text-[#0F172A] hover:text-[#2563EB] inline-flex items-center gap-1.5 transition"
                >
                  <span>{news.title}</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#2563EB]" />
                </a>
                <span className="text-xs font-semibold text-[#64748B]">
                  {news.source} · {news.date}
                </span>
              </div>
              <p className="text-[14px] sm:text-[15px] text-[#475569] leading-relaxed">
                {news.snippet}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Culture Signals */}
      <div className="space-y-4">
        <h3 className="text-lg font-bold text-[#0F172A] flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-[#2563EB]" />
          <span>Culture Signals & Behavioral Norms</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {brief.cultureSignals.map((sig, idx) => (
            <div
              key={idx}
              className="p-5 rounded-xl bg-white ring-1 ring-[#E2E8F0] space-y-2 flex flex-col justify-between"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      sig.sentiment === "positive"
                        ? "bg-emerald-500"
                        : sig.sentiment === "caution"
                        ? "bg-amber-500"
                        : "bg-blue-500"
                    }`}
                  />
                  <h4 className="text-[15px] font-bold text-[#0F172A]">
                    {sig.title}
                  </h4>
                </div>
                <p className="text-[14px] text-[#475569] leading-relaxed">
                  {sig.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
