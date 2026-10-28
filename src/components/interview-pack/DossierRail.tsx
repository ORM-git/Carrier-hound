"use client";

import React from "react";
import {
  Building2,
  GitBranch,
  Layers,
  MessageSquareQuote,
  GitCompare,
  HelpCircle,
  FileCheck2,
  Database,
  Moon,
  Sparkles,
  ArrowLeft,
} from "lucide-react";

export type DossierSection =
  | "brief"
  | "process"
  | "questions"
  | "answers"
  | "gaps"
  | "askThem"
  | "quiz";

interface DossierRailProps {
  activeSection: DossierSection;
  onSelectSection: (section: DossierSection) => void;
  isLastNightMode: boolean;
  onToggleLastNightMode: () => void;
  onOpenSources: () => void;
  sourcesCount: number;
  companyName: string;
  onBackToJobs?: () => void;
}

export default function DossierRail({
  activeSection,
  onSelectSection,
  isLastNightMode,
  onToggleLastNightMode,
  onOpenSources,
  sourcesCount,
  companyName,
  onBackToJobs,
}: DossierRailProps) {
  const SECTIONS: {
    id: DossierSection;
    label: string;
    icon: typeof Building2;
    tag?: string;
  }[] = [
    { id: "brief", label: "Brief", icon: Building2 },
    { id: "process", label: "Process", icon: GitBranch },
    { id: "questions", label: "Questions", icon: Layers, tag: "Cards" },
    { id: "answers", label: "Your answers", icon: MessageSquareQuote },
    { id: "gaps", label: "Gaps (JD vs Resume)", icon: GitCompare },
    { id: "askThem", label: "Ask them", icon: HelpCircle },
    { id: "quiz", label: "Quick quiz", icon: FileCheck2 },
  ];

  return (
    <aside
      aria-label="Interview Dossier Sections"
      className="w-64 shrink-0 bg-[#09151E] text-slate-300 rounded-2xl p-4 flex flex-col justify-between shadow-xl ring-1 ring-blue-950/40 sticky top-20 self-start max-h-[calc(100vh-100px)] overflow-y-auto"
    >
      <div className="space-y-6">
        {/* Back Link & Brand Header */}
        <div className="space-y-3 pb-3 border-b border-slate-800/80">
          {onBackToJobs && (
            <button
              type="button"
              onClick={onBackToJobs}
              className="text-xs font-semibold text-slate-400 hover:text-white flex items-center gap-1.5 transition cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Job</span>
            </button>
          )}

          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-cyan-400 uppercase tracking-wider">
              <Sparkles className="w-3 h-3" />
              <span>Interview Dossier</span>
            </div>
            <h2 className="text-[16px] font-extrabold text-white truncate" title={companyName}>
              {companyName}
            </h2>
          </div>
        </div>

        {/* Last-Night Mode Toggle */}
        <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
              <Moon className="w-3.5 h-3.5 text-cyan-400" />
              <span>Last-Night Mode</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isLastNightMode}
              aria-label="Toggle last-night mode"
              onClick={onToggleLastNightMode}
              className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors cursor-pointer ${
                isLastNightMode ? "bg-[#2563EB]" : "bg-slate-700"
              }`}
            >
              <div
                className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                  isLastNightMode ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Filters to the 5 must-know cards + pre-interview checklist.
          </p>
        </div>

        {/* Section Navigation Links */}
        <nav className="space-y-1">
          <span className="px-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">
            Dossier Sections
          </span>

          {SECTIONS.map((sec) => {
            const isActive = activeSection === sec.id && !isLastNightMode;
            const Icon = sec.icon;

            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => {
                  if (isLastNightMode) onToggleLastNightMode();
                  onSelectSection(sec.id);
                }}
                className={`w-full text-left px-3 py-2.5 rounded-xl font-semibold text-[14px] flex items-center justify-between transition cursor-pointer ${
                  isActive
                    ? "bg-[#2563EB] text-white shadow-sm font-bold"
                    : "text-slate-300 hover:text-white hover:bg-slate-800/60"
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? "text-white" : "text-slate-400"
                    }`}
                  />
                  <span className="truncate">{sec.label}</span>
                </div>

                {sec.tag && (
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      isActive
                        ? "bg-blue-800 text-white"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {sec.tag}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Sources Drawer Link Button at bottom of rail */}
      <div className="pt-4 mt-6 border-t border-slate-800/80">
        <button
          type="button"
          onClick={onOpenSources}
          className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800/80 text-xs font-semibold text-slate-300 hover:text-white transition flex items-center justify-between cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-cyan-400" />
            <span>Sources directory</span>
          </div>
          <span className="text-[11px] font-bold bg-slate-800 text-cyan-300 px-1.5 py-0.5 rounded">
            {sourcesCount} links
          </span>
        </button>
      </div>
    </aside>
  );
}
