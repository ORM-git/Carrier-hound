"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  X,
  ChevronDown,
  ChevronUp,
  Check,
  Search,
  Lock,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { JobFilterValues } from "./JobFilterBar";

interface MobileFilterSheetProps {
  isOpen: boolean;
  onClose: () => void;
  filters: JobFilterValues;
  onApply: (updated: JobFilterValues) => void;
  onResetAll: () => void;
  activeCount: number;
  hiddenCount: number;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function MobileFilterSheet({
  isOpen,
  onClose,
  filters,
  onApply,
  onResetAll,
  activeCount,
  hiddenCount,
  triggerRef,
}: MobileFilterSheetProps) {
  const [draft, setDraft] = useState<JobFilterValues>(filters);
  const [basicExpanded, setBasicExpanded] = useState(true);
  const [industryExpanded, setIndustryExpanded] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDraft({ ...filters });
    }
  }, [isOpen, filters]);

  // Trap focus, handle Escape key, and lock body overflow
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        triggerRef?.current?.focus();
        return;
      }
      if (e.key === "Tab" && sheetRef.current) {
        const focusable = sheetRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = origOverflow;
    };
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  const toggleMulti = (key: "level" | "jobType" | "workModel", item: string) => {
    setDraft((prev) => {
      const current = prev[key] ? prev[key].split(",").map((s) => s.trim()).filter(Boolean) : [];
      const lower = item.toLowerCase();
      const existingIdx = current.findIndex((c) => c.toLowerCase() === lower);
      let updated: string[];
      if (existingIdx >= 0) {
        updated = current.filter((_, idx) => idx !== existingIdx);
      } else {
        updated = [...current, item];
      }
      return { ...prev, [key]: updated.join(", ") };
    });
  };

  const isSelected = (key: "level" | "jobType" | "workModel", item: string): boolean => {
    if (!draft[key]) return false;
    const current = draft[key].split(",").map((s) => s.trim().toLowerCase());
    return current.includes(item.toLowerCase());
  };

  const draftActiveCount = [
    draft.location,
    draft.category,
    draft.level,
    draft.jobType,
    draft.workModel,
    draft.datePosted,
    draft.industry,
    draft.experience,
    draft.hidden,
  ].filter((v) => Boolean(v && v !== "all")).length;

  const handleApply = () => {
    onApply(draft);
    onClose();
    triggerRef?.current?.focus();
  };

  const handleResetDraft = () => {
    setDraft({
      location: "",
      category: "",
      level: "",
      jobType: "",
      workModel: "",
      datePosted: "",
      industry: "",
      experience: "",
      hidden: false,
      sort: filters.sort,
    });
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[#0F172A]/60 z-[70] backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Bottom Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filter positions"
        className="fixed inset-x-0 bottom-0 max-h-[88vh] bg-white rounded-t-3xl shadow-2xl z-[71] flex flex-col font-sans animate-in slide-in-from-bottom duration-300"
      >
        {/* Handle bar indicator */}
        <div className="w-12 h-1.5 bg-slate-300 rounded-full mx-auto mt-3 mb-1 shrink-0" />

        {/* Sheet Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2E8F0] shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-[#0F172A]">Filters</h2>
            {draftActiveCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-[#2563EB] text-white text-[11px] font-bold">
                {draftActiveCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDraft}
              className="text-xs font-semibold text-[#64748B] hover:text-[#0F172A] px-2 py-1 min-h-[44px] flex items-center cursor-pointer"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="h-9 px-5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-xs font-bold shadow-sm transition min-h-[44px] flex items-center justify-center cursor-pointer"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close filter settings"
              className="w-9 h-9 min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Active Chips Strip */}
        {draftActiveCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] shrink-0 text-xs">
            {draft.location && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                <span>{draft.location}</span>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, location: "" }))}
                  aria-label={`Remove location ${draft.location}`}
                  className="hover:text-rose-600 transition"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            {draft.level &&
              draft.level.split(",").map((lvl) => (
                <span
                  key={lvl.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                  <span>{lvl.trim()}</span>
                  <button
                    type="button"
                    onClick={() => toggleMulti("level", lvl.trim())}
                    aria-label={`Remove level ${lvl.trim()}`}
                    className="hover:text-rose-600 transition"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            {draft.jobType &&
              draft.jobType.split(",").map((jt) => (
                <span
                  key={jt.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                  <span>{jt.trim()}</span>
                  <button
                    type="button"
                    onClick={() => toggleMulti("jobType", jt.trim())}
                    aria-label={`Remove job type ${jt.trim()}`}
                    className="hover:text-rose-600 transition"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            {draft.workModel &&
              draft.workModel.split(",").map((wm) => (
                <span
                  key={wm.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                  <span>{wm.trim()}</span>
                  <button
                    type="button"
                    onClick={() => toggleMulti("workModel", wm.trim())}
                    aria-label={`Remove work model ${wm.trim()}`}
                    className="hover:text-rose-600 transition"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            {draft.datePosted && draft.datePosted !== "all" && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                <span>{draft.datePosted}</span>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, datePosted: "" }))}
                  aria-label="Remove date posted"
                  className="hover:text-rose-600 transition"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            {draft.hidden && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] font-medium text-[11px]">
                <span>Hidden Jobs</span>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, hidden: false }))}
                  aria-label="Remove hidden jobs filter"
                  className="hover:text-rose-600 transition"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
          </div>
        )}

        {/* Scrollable Form Content */}
        <div className="overflow-y-auto p-5 space-y-6">
          {/* Section 1: Basic Job Criteria (Accordion) */}
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setBasicExpanded(!basicExpanded)}
              className="w-full flex items-center justify-between text-left py-2 border-b border-[#E2E8F0] cursor-pointer"
            >
              <div>
                <h3 className="text-sm font-bold text-[#0F172A]">Basic Job Criteria</h3>
                <p className="text-[11px] text-[#64748B]">Type, Model, Location, Level</p>
              </div>
              {basicExpanded ? <ChevronUp className="w-4 h-4 text-[#64748B]" /> : <ChevronDown className="w-4 h-4 text-[#64748B]" />}
            </button>

            {basicExpanded && (
              <div className="space-y-5 pt-1">
                {/* Job Type 2-column */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[#0F172A] block">Job Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "full-time", label: "Full-time" },
                      { id: "contract", label: "Contract" },
                      { id: "part-time", label: "Part-time" },
                      { id: "internship", label: "Internship" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold min-h-[44px] ${
                          isSelected("jobType", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected("jobType", item.id)}
                          onChange={() => toggleMulti("jobType", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Work Model 2-column */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[#0F172A] block">Work Model</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "remote", label: "Remote" },
                      { id: "hybrid", label: "Hybrid" },
                      { id: "onsite", label: "Onsite" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold min-h-[44px] ${
                          isSelected("workModel", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected("workModel", item.id)}
                          onChange={() => toggleMulti("workModel", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Location */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[#0F172A] block">Location & Country</label>
                  <select
                    value={draft.location.startsWith("Remote") ? "Remote" : draft.location}
                    onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                    aria-label="Select Country"
                    className="w-full h-11 px-3 rounded-xl border border-[#CBD5E1] bg-white text-xs font-medium text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD] min-h-[44px]"
                  >
                    <option value="">All Locations (Worldwide)</option>
                    <option value="United States">United States</option>
                    <option value="Canada">Canada</option>
                    <option value="United Kingdom">United Kingdom</option>
                    <option value="Europe">Europe (General)</option>
                    <option value="India">India</option>
                    <option value="Remote">Remote (Worldwide)</option>
                  </select>

                  <div className="relative">
                    <Search className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Or search city..."
                      value={draft.location}
                      onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#CBD5E1] text-xs focus:outline-none focus:ring-2 focus:ring-[#93C5FD] min-h-[44px]"
                    />
                  </div>
                </div>

                {/* Experience Level 2-column */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[#0F172A] block">Experience Level</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "intern", label: "Intern / Grad" },
                      { id: "entry", label: "Entry Level" },
                      { id: "mid", label: "Mid Level" },
                      { id: "senior", label: "Senior Level" },
                      { id: "lead", label: "Staff / Lead" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold min-h-[44px] ${
                          isSelected("level", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected("level", item.id)}
                          onChange={() => toggleMulti("level", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Date Posted */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-[#0F172A] block">Date Posted</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: "", label: "Any time" },
                      { id: "24h", label: "Past 24 hours" },
                      { id: "7d", label: "Past week" },
                      { id: "30d", label: "Past month" },
                    ].map((item) => (
                      <button
                        key={item.id || "any"}
                        type="button"
                        onClick={() => setDraft((p) => ({ ...p, datePosted: item.id }))}
                        className={`p-3 rounded-xl border text-xs font-semibold transition text-center cursor-pointer min-h-[44px] ${
                          draft.datePosted === item.id
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A]"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section 2: Industry (Accordion) */}
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setIndustryExpanded(!industryExpanded)}
              className="w-full flex items-center justify-between text-left py-2 border-b border-[#E2E8F0] cursor-pointer"
            >
              <div>
                <h3 className="text-sm font-bold text-[#0F172A]">Industry & Vertical</h3>
                <p className="text-[11px] text-[#64748B]">Tech, AI, Finance, Healthcare</p>
              </div>
              {industryExpanded ? <ChevronUp className="w-4 h-4 text-[#64748B]" /> : <ChevronDown className="w-4 h-4 text-[#64748B]" />}
            </button>

            {industryExpanded && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {[
                  { id: "tech", label: "Tech" },
                  { id: "ai", label: "AI / ML" },
                  { id: "finance", label: "Finance" },
                  { id: "healthcare", label: "Health" },
                  { id: "marketing", label: "Marketing" },
                  { id: "operations", label: "Operations" },
                ].map((ind) => (
                  <button
                    key={ind.id}
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, industry: p.industry === ind.id ? "" : ind.id }))}
                    className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold transition text-left cursor-pointer min-h-[44px] ${
                      draft.industry === ind.id
                        ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                        : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A]"
                    }`}
                  >
                    <span>{ind.label}</span>
                    {draft.industry === ind.id && <Check className="w-3.5 h-3.5 text-[#2563EB]" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Section 3: Hidden Positions Toggle */}
          <div className="p-4 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-[#0F172A]">View Hidden Positions</p>
              <p className="text-[10px] text-[#64748B]">
                {hiddenCount > 0 ? `${hiddenCount} jobs currently hidden` : "No jobs hidden yet"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDraft((p) => ({ ...p, hidden: !p.hidden }))}
              role="switch"
              aria-checked={draft.hidden}
              aria-label="View Hidden Positions"
              className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer min-h-[24px] ${
                draft.hidden ? "bg-[#2563EB]" : "bg-slate-300"
              }`}
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white shadow-xs transition-transform transform ${
                  draft.hidden ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
