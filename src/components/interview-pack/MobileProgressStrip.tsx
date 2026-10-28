"use client";

import React from "react";
import { Moon, Database, ChevronDown } from "lucide-react";
import type { DossierSection } from "./DossierRail";

interface MobileProgressStripProps {
  activeSection: DossierSection;
  onSelectSection: (section: DossierSection) => void;
  isLastNightMode: boolean;
  onToggleLastNightMode: () => void;
  onOpenSources: () => void;
  totalCards: number;
}

export default function MobileProgressStrip({
  activeSection,
  onSelectSection,
  isLastNightMode,
  onToggleLastNightMode,
  onOpenSources,
}: MobileProgressStripProps) {
  const SECTIONS: { id: DossierSection; label: string }[] = [
    { id: "brief", label: "Brief" },
    { id: "process", label: "Process" },
    { id: "questions", label: "Cards" },
    { id: "answers", label: "Answers" },
    { id: "gaps", label: "Gaps" },
    { id: "askThem", label: "Ask them" },
    { id: "quiz", label: "Quiz" },
  ];

  return (
    <div className="lg:hidden sticky top-14 z-20 bg-[#09151E] text-slate-200 border-b border-slate-800 shadow-md">
      {/* Top micro strip: Last Night Toggle & Sources */}
      <div className="px-4 py-2 border-b border-slate-800/80 flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={onToggleLastNightMode}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold transition cursor-pointer ${
            isLastNightMode
              ? "bg-[#2563EB] text-white"
              : "bg-slate-800 text-slate-300 hover:text-white"
          }`}
        >
          <Moon className="w-3 h-3 text-cyan-400" />
          <span>Last-night mode</span>
        </button>

        <button
          type="button"
          onClick={onOpenSources}
          className="text-[11px] font-semibold text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
        >
          <Database className="w-3 h-3 text-cyan-400" />
          <span>Sources</span>
        </button>
      </div>

      {/* Horizontal Scrollable Tabs */}
      <nav
        aria-label="Mobile sections"
        className="flex items-center overflow-x-auto no-scrollbar px-3 py-1.5 gap-1.5"
      >
        {SECTIONS.map((sec) => {
          const isActive = activeSection === sec.id && !isLastNightMode;
          return (
            <button
              key={sec.id}
              type="button"
              onClick={() => {
                if (isLastNightMode) onToggleLastNightMode();
                onSelectSection(sec.id);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 transition cursor-pointer ${
                isActive
                  ? "bg-[#2563EB] text-white shadow-xs"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
            >
              {sec.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
