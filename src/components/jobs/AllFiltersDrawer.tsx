"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  X,
  ChevronRight,
  Check,
  Search,
  Lock,
  RotateCcw,
  SlidersHorizontal,
  Briefcase,
  MapPin,
  Clock,
  TrendingUp,
  Globe,
  Calendar,
  Building,
} from "lucide-react";
import { JobFilterValues } from "./JobFilterBar";

interface AllFiltersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filters: JobFilterValues;
  onApply: (updated: JobFilterValues) => void;
  onResetAll: () => void;
  activeCount: number;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function AllFiltersDrawer({
  isOpen,
  onClose,
  filters,
  onApply,
  onResetAll,
  activeCount,
  triggerRef,
}: AllFiltersDrawerProps) {
  const [draft, setDraft] = useState<JobFilterValues>(filters);
  const [activeSection, setActiveSection] = useState<"basic" | "interest" | "preferences">("basic");
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Initialize draft when drawer opens
  useEffect(() => {
    if (isOpen) {
      setDraft({ ...filters });
    }
  }, [isOpen, filters]);

  // Handle Escape key and focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        triggerRef?.current?.focus();
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
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

  // Multi-select helper
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

  // Compute draft active count
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

  const handleConfirm = () => {
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
      {/* Dimmed backdrop */}
      <div
        className="fixed inset-0 bg-[#0F172A]/50 z-[70] backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Container (872px on wide desktop) */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="All Filters"
        className="fixed inset-y-0 right-0 z-[71] w-full max-w-[872px] bg-white shadow-2xl flex flex-col font-sans animate-in slide-in-from-right duration-300"
      >
        {/* =================================================================== */}
        {/* DRAWER HEADER: Close, Title + Count, Reset All, Confirm             */}
        {/* =================================================================== */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0] shrink-0 bg-white">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close all filters drawer"
              className="w-10 h-10 min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center text-[#475569] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-[#0F172A]">All Filters</h2>
              {draftActiveCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-[#2563EB] text-white text-xs font-bold">
                  {draftActiveCount}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleResetDraft}
              className="text-xs font-bold text-[#64748B] hover:text-[#0F172A] hover:underline px-2 py-1 cursor-pointer"
            >
              Reset All
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="h-10 px-6 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-sm font-bold shadow-sm transition min-h-[44px] cursor-pointer"
            >
              Confirm
            </button>
          </div>
        </div>

        {/* =================================================================== */}
        {/* ACTIVE FILTER CHIPS STRIP                                           */}
        {/* =================================================================== */}
        {draftActiveCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-6 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] shrink-0">
            {draft.location && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium">
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
            {draft.category && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium">
                <span>{draft.category}</span>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, category: "" }))}
                  aria-label={`Remove function ${draft.category}`}
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
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium"
                >
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
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium"
                >
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
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium"
                >
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
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium">
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
            {draft.industry && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium">
                <span>{draft.industry}</span>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, industry: "" }))}
                  aria-label="Remove industry"
                  className="hover:text-rose-600 transition"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            {draft.hidden && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#CBD5E1] text-[#0F172A] text-xs font-medium">
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

        {/* =================================================================== */}
        {/* DRAWER BODY: Left Section Nav + Right Scrollable Form               */}
        {/* =================================================================== */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left Section Navigation (Desktop) */}
          <nav
            aria-label="Filter sections"
            className="w-56 shrink-0 border-r border-[#E2E8F0] p-4 space-y-1 bg-[#F8FAFC] hidden md:block overflow-y-auto"
          >
            <button
              type="button"
              onClick={() => setActiveSection("basic")}
              className={`w-full text-left p-3 rounded-xl transition text-[13px] font-semibold flex items-center justify-between ${
                activeSection === "basic"
                  ? "bg-white text-[#2563EB] shadow-2xs border border-[#E2E8F0]"
                  : "text-[#475569] hover:bg-slate-200/50 hover:text-[#0F172A]"
              }`}
            >
              <div>
                <p className="font-bold">Basic Job Criteria</p>
                <p className="text-[11px] text-[#64748B] font-normal">Type, Model, Level, Location</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection("interest")}
              className={`w-full text-left p-3 rounded-xl transition text-[13px] font-semibold flex items-center justify-between ${
                activeSection === "interest"
                  ? "bg-white text-[#2563EB] shadow-2xs border border-[#E2E8F0]"
                  : "text-[#475569] hover:bg-slate-200/50 hover:text-[#0F172A]"
              }`}
            >
              <div>
                <p className="font-bold">Areas of Interest</p>
                <p className="text-[11px] text-[#64748B] font-normal">Industry & Role Domain</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection("preferences")}
              className={`w-full text-left p-3 rounded-xl transition text-[13px] font-semibold flex items-center justify-between ${
                activeSection === "preferences"
                  ? "bg-white text-[#2563EB] shadow-2xs border border-[#E2E8F0]"
                  : "text-[#475569] hover:bg-slate-200/50 hover:text-[#0F172A]"
              }`}
            >
              <div>
                <p className="font-bold">Preferences & Hidden</p>
                <p className="text-[11px] text-[#64748B] font-normal">Hidden jobs & Visibility</p>
              </div>
            </button>
          </nav>

          {/* Right Form Container (Scrollable) */}
          <div className="flex-1 p-6 overflow-y-auto space-y-8">
            {/* 1. BASIC JOB CRITERIA */}
            {(activeSection === "basic" || typeof window !== "undefined") && (
              <section className="space-y-6">
                <div>
                  <h3 className="text-base font-bold text-[#0F172A]">Basic Job Criteria</h3>
                  <p className="text-xs text-[#64748B]">Core employment requirements for position matching</p>
                </div>

                {/* Job Type: 2-column tiles */}
                <div className="space-y-2">
                  <label className="text-[13px] font-bold text-[#0F172A] block">Job Type</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      { id: "full-time", label: "Full-time" },
                      { id: "contract", label: "Contract" },
                      { id: "part-time", label: "Part-time" },
                      { id: "internship", label: "Internship" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold ${
                          isSelected("jobType", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:bg-slate-100"
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

                {/* Work Model: 2-column tiles */}
                <div className="space-y-2">
                  <label className="text-[13px] font-bold text-[#0F172A] block">Work Model</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      { id: "remote", label: "Remote anywhere" },
                      { id: "hybrid", label: "Hybrid" },
                      { id: "onsite", label: "Onsite" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold ${
                          isSelected("workModel", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:bg-slate-100"
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

                {/* Experience Level: 2-column tiles */}
                <div className="space-y-2">
                  <label className="text-[13px] font-bold text-[#0F172A] block">Experience Level</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      { id: "intern", label: "Intern / New Grad" },
                      { id: "entry", label: "Entry Level" },
                      { id: "mid", label: "Mid Level" },
                      { id: "senior", label: "Senior Level" },
                      { id: "lead", label: "Staff / Principal / Lead" },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition text-xs font-semibold ${
                          isSelected("level", item.id)
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:bg-slate-100"
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

                {/* Location / Geography */}
                <div className="space-y-2">
                  <label className="text-[13px] font-bold text-[#0F172A] block">Country / City Location</label>
                  <div className="space-y-2">
                    <select
                      value={draft.location.startsWith("Remote") ? "Remote" : draft.location}
                      onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                      aria-label="Select Country or Region"
                      className="w-full h-11 px-3 rounded-xl border border-[#CBD5E1] bg-white text-xs font-medium text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
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
                        placeholder="Search city or specific area..."
                        value={draft.location}
                        onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                        className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#CBD5E1] text-xs focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                      />
                    </div>
                  </div>
                </div>

                {/* Date Posted */}
                <div className="space-y-2">
                  <label className="text-[13px] font-bold text-[#0F172A] block">Date Posted</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                        className={`p-2.5 rounded-xl border text-xs font-semibold transition text-center cursor-pointer ${
                          draft.datePosted === item.id
                            ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                            : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:bg-slate-100"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* 2. AREAS OF INTEREST */}
            {(activeSection === "interest" || typeof window !== "undefined") && (
              <section className="space-y-4 pt-6 border-t border-[#E2E8F0]">
                <div>
                  <h3 className="text-base font-bold text-[#0F172A]">Areas of Interest & Industry</h3>
                  <p className="text-xs text-[#64748B]">Filter positions across specific domain verticals</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {[
                    { id: "tech", label: "Tech & Software" },
                    { id: "ai", label: "AI & Machine Learning" },
                    { id: "finance", label: "Finance & Fintech" },
                    { id: "healthcare", label: "Healthcare & Biotech" },
                    { id: "marketing", label: "Marketing & Growth" },
                    { id: "operations", label: "Operations & Logistics" },
                  ].map((ind) => (
                    <button
                      key={ind.id}
                      type="button"
                      onClick={() => setDraft((p) => ({ ...p, industry: p.industry === ind.id ? "" : ind.id }))}
                      className={`flex items-center justify-between p-3 rounded-xl border text-xs font-semibold transition text-left cursor-pointer ${
                        draft.industry === ind.id
                          ? "bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]"
                          : "bg-[#F8FAFC] border-[#E2E8F0] text-[#0F172A] hover:bg-slate-100"
                      }`}
                    >
                      <span>{ind.label}</span>
                      {draft.industry === ind.id && <Check className="w-4 h-4 text-[#2563EB]" />}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* 3. PREFERENCES & HIDDEN JOBS */}
            {(activeSection === "preferences" || typeof window !== "undefined") && (
              <section className="space-y-4 pt-6 border-t border-[#E2E8F0]">
                <div>
                  <h3 className="text-base font-bold text-[#0F172A]">Hidden Positions</h3>
                  <p className="text-xs text-[#64748B]">Manage dismissed or hidden job listings</p>
                </div>

                <div className="p-4 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
                  <div className="space-y-0.5">
                    <p className="text-sm font-bold text-[#0F172A]">View Hidden Positions</p>
                    <p className="text-xs text-[#64748B]">Reveal positions you previously hid from search</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, hidden: !p.hidden }))}
                    role="switch"
                    aria-checked={draft.hidden}
                    aria-label="View Hidden Positions toggle"
                    className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer ${
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
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
