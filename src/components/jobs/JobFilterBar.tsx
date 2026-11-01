"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import {
  MapPin,
  Briefcase,
  TrendingUp,
  Clock,
  Globe,
  Calendar,
  Building,
  Award,
  Lock,
  SlidersHorizontal,
  ArrowUpDown,
  ChevronDown,
  X,
  Check,
  Search,
  RotateCcw,
  Sparkles,
} from "lucide-react";

export interface JobFilterValues {
  countryCode?: string; // ISO 2-letter country code (US, GB, CA, DE, IN)
  location: string; // City or area text search
  category: string; // Job Category
  level: string; // Seniority Level heuristic (multi-select, comma-separated)
  jobType: string; // Job Type (multi-select, comma-separated)
  workModel: string; // Work Model heuristic (Remote, Hybrid, Onsite)
  datePosted: string; // Any time, 24h, 7d, 30d
  salaryMin?: string | number;
  sourceType?: string;
  company?: string;
  industry?: string; // GAP: unindexed in DB; omitted from active search predicates
  experience?: string; // GAP: unindexed in DB; omitted from active search predicates
  hidden: boolean;
  sort: "match" | "newest";
}

interface JobFilterBarProps {
  filters: JobFilterValues;
  onChange: (updated: Partial<JobFilterValues>) => void;
  onClearAll: () => void;
  activeCount: number;
  hiddenCount: number;
  onOpenAllFilters: () => void;
  onOpenMobileFilters: () => void;
  isMobileFiltersOpen: boolean;
  mobileFiltersTriggerRef: React.Ref<HTMLButtonElement>;
  allFiltersTriggerRef?: React.Ref<HTMLButtonElement>;
  hasConfirmedResume: boolean;
}

// Format multi-select label with (+N) extra count
function formatMultiLabel(val: string, defaultLabel: string): { label: string; extra: number } {
  if (!val || val === "all") return { label: defaultLabel, extra: 0 };
  const items = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return { label: defaultLabel, extra: 0 };
  const first = items[0];
  const extra = items.length - 1;
  return { label: first, extra };
}

export default function JobFilterBar({
  filters,
  onChange,
  onClearAll,
  activeCount,
  hiddenCount,
  onOpenAllFilters,
  onOpenMobileFilters,
  isMobileFiltersOpen,
  mobileFiltersTriggerRef,
  allFiltersTriggerRef,
  hasConfirmedResume,
}: JobFilterBarProps) {
  // Popover state
  const [activePopover, setActivePopover] = useState<string | null>(null);
  const [draftFilters, setDraftFilters] = useState<JobFilterValues>(filters);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Sync draft whenever opening a popover
  const handleOpenPopover = (id: string) => {
    if (activePopover === id) {
      setActivePopover(null);
    } else {
      setDraftFilters({ ...filters });
      setActivePopover(id);
    }
  };

  const handleClosePopover = useCallback(() => {
    const prev = activePopover;
    setActivePopover(null);
    if (prev && triggerRefs.current[prev]) {
      triggerRefs.current[prev]?.focus();
    }
  }, [activePopover]);

  // Handle outside click and Escape key for popovers
  useEffect(() => {
    if (!activePopover) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClosePopover();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        // Check if click was on the trigger button
        const isTrigger = Object.values(triggerRefs.current).some(
          (btn) => btn && btn.contains(e.target as Node)
        );
        if (!isTrigger) {
          handleClosePopover();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activePopover, handleClosePopover]);

  // Popover Confirm / Reset handlers
  const handleConfirm = (patch: Partial<JobFilterValues>) => {
    onChange(patch);
    handleClosePopover();
  };

  const handleReset = (key: keyof JobFilterValues, defaultValue: any) => {
    setDraftFilters((prev) => ({ ...prev, [key]: defaultValue }));
  };

  // Helper for multi-select array in draft state
  const toggleMultiSelect = (key: "level" | "jobType" | "workModel", item: string) => {
    setDraftFilters((prev) => {
      const current = prev[key] ? prev[key].split(",").map((s) => s.trim()).filter(Boolean) : [];
      const lowerItem = item.toLowerCase();
      const existingIdx = current.findIndex((c) => c.toLowerCase() === lowerItem);
      let updated: string[];
      if (existingIdx >= 0) {
        updated = current.filter((_, idx) => idx !== existingIdx);
      } else {
        updated = [...current, item];
      }
      return { ...prev, [key]: updated.join(", ") };
    });
  };

  const isSelectedInMulti = (key: "level" | "jobType" | "workModel", item: string): boolean => {
    if (!draftFilters[key]) return false;
    const current = draftFilters[key].split(",").map((s) => s.trim().toLowerCase());
    return current.includes(item.toLowerCase());
  };

  // Quick search filter inside Role Popover
  const [roleSearchQuery, setRoleSearchQuery] = useState("");
  const supportedRoles = [
    "Software Engineering",
    "Frontend & Full Stack",
    "Backend & Systems",
    "AI & Machine Learning",
    "DevOps & Cloud",
    "Data Science & Analytics",
    "Product Management",
    "Product Design (UI/UX)",
    "Marketing & Growth",
    "Finance & Fintech",
    "Cyber Security",
    "Customer Success",
  ];
  const filteredRoles = supportedRoles.filter((r) =>
    r.toLowerCase().includes(roleSearchQuery.toLowerCase().trim())
  );

  // Formatted labels for chips
  const levelInfo = formatMultiLabel(filters.level, "Level");
  const jobTypeInfo = formatMultiLabel(filters.jobType, "Job type");
  const workModelInfo = formatMultiLabel(filters.workModel, "Work model");

  return (
    <div className="sticky top-[56px] z-tk-sticky py-2 sm:py-0 bg-[#F8FAFC]/95 backdrop-blur-xs space-y-2">
      {/* =================================================================== */}
      {/* 1. MOBILE FILTER ROW (< 768px)                                      */}
      {/* =================================================================== */}
      <div className="flex md:hidden items-center justify-between w-full gap-2 px-1">
        <button
          ref={mobileFiltersTriggerRef}
          type="button"
          onClick={onOpenMobileFilters}
          aria-expanded={isMobileFiltersOpen}
          aria-label="Open filter settings"
          className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[44px] rounded-full border border-[#CBD5E1] bg-white text-[#0F172A] text-xs font-bold transition hover:bg-[#F1F5F9] active:scale-95 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#93C5FD] shadow-2xs"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-[#2563EB]" />
          <span>Filters</span>
          {activeCount > 0 && (
            <span className="w-5 h-5 rounded-full bg-[#2563EB] text-white text-[11px] font-bold flex items-center justify-center">
              {activeCount}
            </span>
          )}
        </button>

        {/* Mobile Sort Dropdown */}
        <div className="relative">
          <button
            type="button"
            ref={(el) => { triggerRefs.current["sort_mobile"] = el; }}
            onClick={() => handleOpenPopover("sort_mobile")}
            aria-label={`Sort by: ${filters.sort === "match" ? "Recommended" : "Newest"}`}
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full border border-[#CBD5E1] bg-white text-[#0F172A] text-xs font-semibold hover:bg-[#F1F5F9] transition cursor-pointer shadow-2xs"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-[#475569]" />
            <span>Sort: {filters.sort === "match" ? "Recommended" : "Newest"}</span>
            <ChevronDown className="w-3 h-3 text-[#475569]" />
          </button>
          {activePopover === "sort_mobile" && (
            <div
              ref={popoverRef}
              className="absolute right-0 mt-1.5 w-44 bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-1.5 z-50 space-y-0.5 text-xs"
            >
              <button
                type="button"
                onClick={() => {
                  onChange({ sort: "newest" });
                  handleClosePopover();
                }}
                className={`w-full text-left px-3 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                  filters.sort === "newest" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                Newest First
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange({ sort: "match" });
                  handleClosePopover();
                }}
                className={`w-full text-left px-3 py-2 min-h-[36px] rounded-lg font-medium transition cursor-pointer ${
                  filters.sort === "match" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                Recommended (Match)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* =================================================================== */}
      {/* 2. DESKTOP FILTER BAR (md and up) - Compact Open Chip Rows          */}
      {/* =================================================================== */}
      <div className="hidden md:flex flex-col gap-2">
        {/* ROW 1: Location, Function, Level, Job Type, Work Model, Date Posted, Sort */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 lg:gap-2">
          <div className="flex flex-wrap items-center gap-1.5 lg:gap-2 min-w-0">
            {/* 1. LOCATION CHIP & POPOVER */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["location"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("location")}
                aria-expanded={activePopover === "location"}
                aria-label={`Location filter: ${filters.countryCode ? `Country: ${filters.countryCode}` : (filters.location || "All")}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.location || filters.countryCode
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>{filters.countryCode ? `Country: ${filters.countryCode}` : (filters.location || "Location / Country")}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "location" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Location"
                  className="absolute left-0 mt-1.5 w-80 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <span className="font-bold text-[13px] text-[#0F172A]">Country / Region</span>
                    <button
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, countryCode: "", location: "" }))}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  {/* Real Country Selection (Filtering genuine country_code column) */}
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    <span className="text-[11px] font-semibold text-[#64748B] block mb-1">Country (Filters country_code):</span>
                    {SUPPORTED_COUNTRIES.map((c) => (
                      <label
                        key={c.code || "all"}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition text-[13px] ${
                          (draftFilters.countryCode || "") === c.code
                            ? "bg-[#EFF6FF] text-[#1D4ED8] font-semibold"
                            : "text-[#334155] hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="country_code_preset"
                          checked={(draftFilters.countryCode || "") === c.code}
                          onChange={() => setDraftFilters((prev) => ({ ...prev, countryCode: c.code }))}
                          className="w-3.5 h-3.5 text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{c.label}</span>
                      </label>
                    ))}
                  </div>

                  {/* City or Area Input */}
                  <div className="pt-2 border-t border-[#E2E8F0] space-y-1">
                    <label className="text-[11px] font-semibold text-[#475569]">Or search specific city / area</label>
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="e.g. San Francisco, London, Berlin"
                        value={draftFilters.location}
                        onChange={(e) => setDraftFilters((prev) => ({ ...prev, location: e.target.value }))}
                        className="w-full pl-8 pr-2.5 py-1.5 rounded-lg border border-[#CBD5E1] text-[12px] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                      />
                    </div>
                  </div>

                  {/* Popover Footer Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, countryCode: "", location: "" }))}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ countryCode: draftFilters.countryCode, location: draftFilters.location })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 2. FUNCTION / ROLE CHIP & POPOVER */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["role"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("role")}
                aria-expanded={activePopover === "role"}
                aria-label={`Job category filter: ${filters.category || "All"}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.category
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>{filters.category ? (filters.category.charAt(0).toUpperCase() + filters.category.slice(1)) : "Category"}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "role" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Job Category"
                  className="absolute left-0 mt-1.5 w-80 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <span className="font-bold text-[13px] text-[#0F172A]">Job Category</span>
                    <button
                      type="button"
                      onClick={() => handleReset("category", "")}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  {/* Filter Search */}
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search functions..."
                      value={roleSearchQuery}
                      onChange={(e) => setRoleSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-2.5 py-1.5 rounded-lg border border-[#CBD5E1] text-[12px] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                    />
                  </div>

                  {/* Function Options List */}
                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                    <button
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, category: "" }))}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition text-[13px] ${
                        !draftFilters.category ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-[#334155] hover:bg-slate-50"
                      }`}
                    >
                      All Functions
                    </button>
                    {filteredRoles.map((r) => {
                      const slug = r === "AI & Machine Learning" ? "ai" : r.toLowerCase().replace(/ & /g, "-").replace(/\s+/g, "-");
                      const isSelected = r === "AI & Machine Learning"
                        ? draftFilters.category === "ai" || draftFilters.category === "ai-ml" || draftFilters.category === "ai-machine-learning"
                        : draftFilters.category === slug;
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setDraftFilters((prev) => ({ ...prev, category: slug }))}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg transition text-[13px] ${
                            isSelected
                              ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                              : "text-[#334155] hover:bg-slate-50"
                          }`}
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => handleReset("category", "")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ category: draftFilters.category })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 3. LEVEL CHIP & POPOVER (Multi-select) */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["level"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("level")}
                aria-expanded={activePopover === "level"}
                aria-label={`Level filter: ${filters.level || "All"}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.level
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>
                  {levelInfo.extra > 0
                    ? `${levelInfo.label} (+${levelInfo.extra})`
                    : levelInfo.label}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "level" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Experience Level"
                  className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <div><span className="font-bold text-[13px] text-[#0F172A] block">Seniority Level</span><span className="text-[10px] text-[#64748B]">Heuristic match on title keywords</span></div>
                    <button
                      type="button"
                      onClick={() => handleReset("level", "")}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-1.5 max-h-56 overflow-y-auto">
                    {[
                      { id: "intern", label: "Intern / New Grad" },
                      { id: "entry", label: "Entry Level" },
                      { id: "mid", label: "Mid Level" },
                      { id: "senior", label: "Senior Level" },
                      { id: "lead", label: "Staff / Principal / Lead" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition text-[13px] ${
                          isSelectedInMulti("level", item.id)
                            ? "bg-[#EFF6FF] text-[#1D4ED8] font-semibold"
                            : "text-[#334155] hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelectedInMulti("level", item.id)}
                          onChange={() => toggleMultiSelect("level", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => handleReset("level", "")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ level: draftFilters.level })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 4. JOB TYPE CHIP & POPOVER (Multi-select) */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["jobType"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("jobType")}
                aria-expanded={activePopover === "jobType"}
                aria-label={`Job type filter: ${filters.jobType || "All"}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.jobType
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>
                  {jobTypeInfo.extra > 0
                    ? `${jobTypeInfo.label} (+${jobTypeInfo.extra})`
                    : jobTypeInfo.label}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "jobType" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Job Type"
                  className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <span className="font-bold text-[13px] text-[#0F172A]">Job Type</span>
                    <button
                      type="button"
                      onClick={() => handleReset("jobType", "")}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {[
                      { id: "full-time", label: "Full-time" },
                      { id: "contract", label: "Contract" },
                      { id: "part-time", label: "Part-time" },
                      { id: "internship", label: "Internship" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition text-[13px] ${
                          isSelectedInMulti("jobType", item.id)
                            ? "bg-[#EFF6FF] text-[#1D4ED8] font-semibold"
                            : "text-[#334155] hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelectedInMulti("jobType", item.id)}
                          onChange={() => toggleMultiSelect("jobType", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => handleReset("jobType", "")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ jobType: draftFilters.jobType })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 5. WORK MODEL CHIP & POPOVER (Multi-select) */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["workModel"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("workModel")}
                aria-expanded={activePopover === "workModel"}
                aria-label={`Work model filter: ${filters.workModel || "All"}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.workModel
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>
                  {workModelInfo.extra > 0
                    ? `${workModelInfo.label} (+${workModelInfo.extra})`
                    : workModelInfo.label}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "workModel" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Work Model"
                  className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <div><span className="font-bold text-[13px] text-[#0F172A] block">Work Model</span><span className="text-[10px] text-[#64748B]">Heuristic match on remote flag & location</span></div>
                    <button
                      type="button"
                      onClick={() => handleReset("workModel", "")}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {[
                      { id: "remote", label: "Remote anywhere" },
                      { id: "hybrid", label: "Hybrid" },
                      { id: "onsite", label: "Onsite" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition text-[13px] ${
                          isSelectedInMulti("workModel", item.id)
                            ? "bg-[#EFF6FF] text-[#1D4ED8] font-semibold"
                            : "text-[#334155] hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelectedInMulti("workModel", item.id)}
                          onChange={() => toggleMultiSelect("workModel", item.id)}
                          className="w-4 h-4 rounded text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => handleReset("workModel", "")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ workModel: draftFilters.workModel })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 6. DATE POSTED CHIP & POPOVER */}
            <div className="relative">
              <button
                ref={(el) => { triggerRefs.current["date"] = el; }}
                type="button"
                onClick={() => handleOpenPopover("date")}
                aria-expanded={activePopover === "date"}
                aria-label={`Date posted filter: ${filters.datePosted || "Any time"}`}
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                  filters.datePosted && filters.datePosted !== "all"
                    ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                    : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <span>{filters.datePosted && filters.datePosted !== "all" ? filters.datePosted : "Date Posted"}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              </button>

              {activePopover === "date" && (
                <div
                  ref={popoverRef}
                  role="dialog"
                  aria-label="Filter by Date Posted"
                  className="absolute left-0 mt-1.5 w-60 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                    <span className="font-bold text-[13px] text-[#0F172A]">Date Posted</span>
                    <button
                      type="button"
                      onClick={() => handleReset("datePosted", "")}
                      className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {[
                      { id: "", label: "Any time" },
                      { id: "24h", label: "Past 24 hours" },
                      { id: "7d", label: "Past week" },
                      { id: "30d", label: "Past month" },
                    ].map((item) => (
                      <label
                        key={item.id || "any"}
                        className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition text-[13px] ${
                          draftFilters.datePosted === item.id
                            ? "bg-[#EFF6FF] text-[#1D4ED8] font-semibold"
                            : "text-[#334155] hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="date_posted_preset"
                          checked={draftFilters.datePosted === item.id}
                          onChange={() => setDraftFilters((prev) => ({ ...prev, datePosted: item.id }))}
                          className="w-3.5 h-3.5 text-[#2563EB] focus:ring-[#93C5FD]"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                    <button
                      type="button"
                      onClick={() => handleReset("datePosted", "")}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirm({ datePosted: draftFilters.datePosted })}
                      className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* FAR RIGHT: SORT DROPDOWN */}
          <div className="relative">
            <button
              ref={(el) => { triggerRefs.current["sort"] = el; }}
              type="button"
              onClick={() => handleOpenPopover("sort")}
              aria-expanded={activePopover === "sort"}
              aria-label={`Sort by: ${filters.sort === "match" ? "Recommended" : "Newest"}`}
              className="h-8 px-3 rounded-lg border border-[#CBD5E1] bg-white text-[#0F172A] text-[13px] font-medium transition inline-flex items-center gap-1.5 hover:bg-[#F8FAFC] cursor-pointer shadow-2xs"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-[#64748B]" />
              <span>Sort: {filters.sort === "match" ? "Recommended" : "Newest"}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {activePopover === "sort" && (
              <div
                ref={popoverRef}
                className="absolute right-0 mt-1.5 w-56 bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-2 z-50 text-xs space-y-1"
              >
                <button
                  type="button"
                  onClick={() => {
                    onChange({ sort: "match" });
                    handleClosePopover();
                  }}
                  className={`w-full text-left p-2 rounded-lg transition ${
                    filters.sort === "match" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-[#334155] hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
                    <span className="font-semibold text-[13px]">Recommended (Match)</span>
                  </div>
                  {!hasConfirmedResume && (
                    <p className="text-[10px] text-[#64748B] mt-0.5 pl-5">Upload resume to activate tailored ranking</p>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChange({ sort: "newest" });
                    handleClosePopover();
                  }}
                  className={`w-full text-left p-2 rounded-lg transition ${
                    filters.sort === "newest" ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold" : "text-[#334155] hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#64748B]" />
                    <span className="font-semibold text-[13px]">Newest First</span>
                  </div>
                  <p className="text-[10px] text-[#64748B] mt-0.5 pl-5">Chronological date posted</p>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ROW 2: Years of Experience, Hidden Jobs, All Filters button */}
        <div className="flex flex-wrap items-center gap-1.5 lg:gap-2">
          {/* Years of Experience Chip & Popover */}
          <div className="relative">
            <button
              ref={(el) => { triggerRefs.current["experience"] = el; }}
              type="button"
              onClick={() => handleOpenPopover("experience")}
              aria-expanded={activePopover === "experience"}
              aria-label={`Experience filter: ${filters.experience || "All"}`}
              className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                filters.experience && filters.experience !== "all"
                  ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                  : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
              }`}
            >
              <span>{filters.experience && filters.experience !== "all" ? filters.experience : "Years of Experience"}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {activePopover === "experience" && (
              <div
                ref={popoverRef}
                role="dialog"
                aria-label="Filter by Experience"
                className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
              >
                <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                  <span className="font-bold text-[13px] text-[#0F172A]">Experience Range</span>
                  <button
                    type="button"
                    onClick={() => handleReset("experience", "")}
                    className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                  >
                    Clear
                  </button>
                </div>

                <div className="space-y-1">
                  {["All Experience", "1-3 Years", "3-5 Years", "5+ Years", "8+ Years"].map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, experience: e === "All Experience" ? "" : e }))}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition text-[13px] ${
                        (e === "All Experience" && !draftFilters.experience) || draftFilters.experience === e
                          ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                          : "text-[#334155] hover:bg-slate-50"
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => handleReset("experience", "")}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirm({ experience: draftFilters.experience })}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Min Salary Chip & Popover */}
          <div className="relative">
            <button
              ref={(el) => { triggerRefs.current["salaryMin"] = el; }}
              type="button"
              onClick={() => handleOpenPopover("salaryMin")}
              aria-expanded={activePopover === "salaryMin"}
              aria-label={`Min Salary filter: ${filters.salaryMin ? `${parseInt(String(filters.salaryMin), 10) / 1000}k+` : "All"}`}
              className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                filters.salaryMin
                  ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                  : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
              }`}
            >
              <span>{filters.salaryMin ? `${parseInt(String(filters.salaryMin), 10) / 1000}k+` : "Min Salary"}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {activePopover === "salaryMin" && (
              <div
                ref={popoverRef}
                role="dialog"
                aria-label="Filter by Minimum Salary"
                className="absolute left-0 mt-1.5 w-60 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
              >
                <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                  <span className="font-bold text-[13px] text-[#0F172A]">Min Salary</span>
                  <button
                    type="button"
                    onClick={() => handleReset("salaryMin", "")}
                    className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                  >
                    Clear
                  </button>
                </div>

                <div className="space-y-1">
                  {[
                    { val: "", label: "Any salary" },
                    { val: "50000", label: "$50k+/year" },
                    { val: "80000", label: "$80k+/year" },
                    { val: "100000", label: "$100k+/year" },
                    { val: "120000", label: "$120k+/year" },
                    { val: "150000", label: "$150k+/year" },
                    { val: "200000", label: "$200k+/year" },
                  ].map((s) => (
                    <button
                      key={s.val || "any"}
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, salaryMin: s.val }))}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition text-[13px] ${
                        (!draftFilters.salaryMin && !s.val) || String(draftFilters.salaryMin) === s.val
                          ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                          : "text-[#334155] hover:bg-slate-50"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => handleReset("salaryMin", "")}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirm({ salaryMin: draftFilters.salaryMin })}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Source Type Chip & Popover */}
          <div className="relative">
            <button
              ref={(el) => { triggerRefs.current["sourceType"] = el; }}
              type="button"
              onClick={() => handleOpenPopover("sourceType")}
              aria-expanded={activePopover === "sourceType"}
              aria-label={`Source filter: ${filters.sourceType || "All"}`}
              className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                filters.sourceType && filters.sourceType !== "all"
                  ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                  : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
              }`}
            >
              <span>{filters.sourceType && filters.sourceType !== "all" ? filters.sourceType.toUpperCase() : "Source"}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {activePopover === "sourceType" && (
              <div
                ref={popoverRef}
                role="dialog"
                aria-label="Filter by Source Type"
                className="absolute left-0 mt-1.5 w-60 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
              >
                <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                  <span className="font-bold text-[13px] text-[#0F172A]">Source Type</span>
                  <button
                    type="button"
                    onClick={() => handleReset("sourceType", "")}
                    className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                  >
                    Clear
                  </button>
                </div>

                <div className="space-y-1">
                  {[
                    { val: "", label: "All sources" },
                    { val: "ats", label: "Direct ATS (Greenhouse, Lever, etc.)" },
                    { val: "direct", label: "Employer Career Pages" },
                    { val: "aggregator", label: "Aggregated Feeds" },
                  ].map((s) => (
                    <button
                      key={s.val || "all"}
                      type="button"
                      onClick={() => setDraftFilters((prev) => ({ ...prev, sourceType: s.val }))}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg transition text-[13px] ${
                        (!draftFilters.sourceType && !s.val) || draftFilters.sourceType === s.val
                          ? "bg-[#EFF6FF] text-[#1D4ED8] font-bold"
                          : "text-[#334155] hover:bg-slate-50"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => handleReset("sourceType", "")}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirm({ sourceType: draftFilters.sourceType })}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Company Chip & Popover */}
          <div className="relative">
            <button
              ref={(el) => { triggerRefs.current["company"] = el; }}
              type="button"
              onClick={() => handleOpenPopover("company")}
              aria-expanded={activePopover === "company"}
              aria-label={`Company filter: ${filters.company || "All"}`}
              className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                filters.company && filters.company !== "all"
                  ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8] font-semibold"
                  : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
              }`}
            >
              <span>{filters.company && filters.company !== "all" ? `Company: ${filters.company}` : "Company"}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {activePopover === "company" && (
              <div
                ref={popoverRef}
                role="dialog"
                aria-label="Filter by Company"
                className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-32px)] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl p-4 z-50 text-xs space-y-3"
              >
                <div className="flex items-center justify-between pb-2 border-b border-[#E2E8F0]">
                  <span className="font-bold text-[13px] text-[#0F172A]">Company Name</span>
                  <button
                    type="button"
                    onClick={() => handleReset("company", "")}
                    className="text-[11px] text-[#2563EB] hover:underline font-semibold"
                  >
                    Clear
                  </button>
                </div>

                <div className="relative">
                  <input
                    type="text"
                    value={draftFilters.company || ""}
                    onChange={(e) => setDraftFilters((prev) => ({ ...prev, company: e.target.value }))}
                    placeholder="e.g. Stripe, OpenAI, Spotify..."
                    className="w-full text-xs px-3 py-2 rounded-lg border border-[#CBD5E1] bg-white text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                  />
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => handleReset("company", "")}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-slate-100 transition"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirm({ company: draftFilters.company })}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition shadow-xs"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Hidden Jobs Toggle Chip */}
          <button
            type="button"
            onClick={() => onChange({ hidden: !filters.hidden })}
            aria-label="Toggle Hidden Jobs"
            className={`h-8 px-3 rounded-lg border text-[13px] font-semibold transition inline-flex items-center gap-1.5 cursor-pointer shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
              filters.hidden
                ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                : "bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]"
            }`}
          >
            <Lock className="w-3.5 h-3.5 text-[#64748B]" />
            <span>Hidden Jobs</span>
            {hiddenCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700">
                {hiddenCount}
              </span>
            )}
          </button>

          {/* All Filters Button */}
          <button
            ref={allFiltersTriggerRef}
            type="button"
            onClick={onOpenAllFilters}
            aria-label="Open all filters drawer"
            className="h-8 px-3.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[13px] font-semibold inline-flex items-center gap-1.5 cursor-pointer shadow-2xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>All Filters</span>
            {activeCount > 0 && (
              <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-white text-[#2563EB] text-[10px] font-bold">
                {activeCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 3. ACTIVE FILTERS STRIP (When activeCount > 0)                       */}
      {/* =================================================================== */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#E2E8F0] text-xs">
          <span className="font-bold text-[#64748B]">Active:</span>

          {filters.countryCode && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>Country: {filters.countryCode}</span>
              <button
                type="button"
                onClick={() => onChange({ countryCode: "" })}
                aria-label={`Remove country filter ${filters.countryCode}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.location && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.location}</span>
              <button
                type="button"
                onClick={() => onChange({ location: "" })}
                aria-label={`Remove location filter ${filters.location}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.category && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.category}</span>
              <button
                type="button"
                onClick={() => onChange({ category: "" })}
                aria-label={`Remove category filter ${filters.category}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.level && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.level}</span>
              <button
                type="button"
                onClick={() => onChange({ level: "" })}
                aria-label={`Remove level filter ${filters.level}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.jobType && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.jobType}</span>
              <button
                type="button"
                onClick={() => onChange({ jobType: "" })}
                aria-label={`Remove job type filter ${filters.jobType}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.workModel && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.workModel}</span>
              <button
                type="button"
                onClick={() => onChange({ workModel: "" })}
                aria-label={`Remove work model filter ${filters.workModel}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.datePosted && filters.datePosted !== "all" && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.datePosted}</span>
              <button
                type="button"
                onClick={() => onChange({ datePosted: "" })}
                aria-label={`Remove date posted filter ${filters.datePosted}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.experience && filters.experience !== "all" && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>{filters.experience}</span>
              <button
                type="button"
                onClick={() => onChange({ experience: "" })}
                aria-label={`Remove experience filter ${filters.experience}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.hidden && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>Viewing Hidden Jobs</span>
              <button
                type="button"
                onClick={() => onChange({ hidden: false })}
                aria-label="Remove hidden jobs filter"
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

                    {filters.salaryMin && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>Min Salary: ${parseInt(String(filters.salaryMin), 10) / 1000}k+</span>
              <button
                type="button"
                onClick={() => onChange({ salaryMin: "" })}
                aria-label="Remove salary filter"
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.sourceType && filters.sourceType !== "all" && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>Source: {filters.sourceType.toUpperCase()}</span>
              <button
                type="button"
                onClick={() => onChange({ sourceType: "" })}
                aria-label="Remove source type filter"
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.company && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] font-medium text-[11px]">
              <span>Company: {filters.company}</span>
              <button
                type="button"
                onClick={() => onChange({ company: "" })}
                aria-label={`Remove company filter ${filters.company}`}
                className="hover:text-rose-600 transition"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          <button
            type="button"
            onClick={onClearAll}
            className="text-xs font-bold text-[#2563EB] hover:text-[#1D4ED8] hover:underline ml-1"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
