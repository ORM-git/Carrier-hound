"use client";

import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import SavedPrioritiesNote from "./SavedPrioritiesNote";
import { X, ChevronRight, ChevronDown, Search, Building, Plus, Eraser } from "lucide-react";
import { JobFilterValues } from "./JobFilterBar";
import { CANONICAL_EXPERIENCE_LEVELS, EXPERIENCE_LEVEL_LABELS } from "@/lib/jobs/experienceLevels";
import { normalizeTextList, savedFeedConstraintsEnforced } from "@/lib/preferences/feedConstraints";

type SectionId = "basic" | "comp" | "interests" | "company" | "hidden";
const SECTIONS: Array<{ id: SectionId; title: string; sub: string }> = [
  { id: "basic", title: "Basic Job Criteria", sub: "Job Function / Job Type / Work Model..." },
  { id: "comp", title: "Compensation & Sponsorship", sub: "Annual Salary / Sponsorship" },
  { id: "interests", title: "Areas of Interests", sub: "Industry / Skill / Role..." },
  { id: "company", title: "Company Insights", sub: "Company Search / Job Source..." },
  { id: "hidden", title: "Preferences & Hidden", sub: "Hidden Positions" },
];
const SALARY_STEPS = ["", "50000", "80000", "100000", "120000", "150000", "200000"];
const salaryLabel = (v: string) => (v ? `$${Number(v) / 1000}k+` : "Any salary");
type ListKey = "excludedTitles" | "includedCompanies" | "excludedCompanies";
const LIST_LABELS: Record<ListKey, string> = { excludedTitles: "Excluded Title", includedCompanies: "Include Company", excludedCompanies: "Exclude Company" };
const LIST_CHIP: Record<ListKey, string> = { excludedTitles: "Not title: ", includedCompanies: "Company: ", excludedCompanies: "Not company: " };

/** Shared look: white field cards on a pale panel, 13px labels, CM blue instead of Jobright green. */
const CARD = "rounded-xl bg-white border border-[#E2E8F0] p-4 space-y-3";
const LABEL = "text-[13px] font-semibold text-[#0F172A] block";
const OPTION_BASE = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-normal text-[#0F172A] bg-[#F1F5F9] hover:bg-[#E8EEF6] transition cursor-pointer";
const CHECK = "w-5 h-5 rounded-[3px] border-[#CBD5E1] accent-[#2563EB] cursor-pointer";
const PILL = (on: boolean) => `px-3 py-2.5 rounded-lg text-[13px] text-center transition cursor-pointer ${on ? "bg-[#DBEAFE] text-[#1D4ED8] font-semibold" : "bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E8EEF6]"}`;
const INPUT = "w-full pl-9 pr-3 py-2.5 rounded-lg bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]";

interface AllFiltersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filters: JobFilterValues;
  onApply: (updated: JobFilterValues) => void;
  onResetAll: () => void;
  activeCount: number;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /** Saved-priorities context (display only; never merged into the draft or Apply). */
  savedPriorities?: { summary: string; onEdit: () => void };
}

export default function AllFiltersDrawer({
  isOpen,
  onClose,
  filters,
  onApply,
  onResetAll,
  activeCount,
  triggerRef,
  savedPriorities,
}: AllFiltersDrawerProps) {
  const [draft, setDraft] = useState<JobFilterValues>(filters);
  const [activeSection, setActiveSection] = useState<SectionId>("basic");
  const [openExcl, setOpenExcl] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (lockRef.current) clearTimeout(lockRef.current); }, []);
  // Scroll room under the last section so every rail item (even a short last one) can reach the top of the panel.
  const [tailRoom, setTailRoom] = useState(0);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const panel = panelRef.current;
      const last = panel?.querySelector<HTMLElement>('[data-section="hidden"]');
      if (!panel || !last) return;
      setTailRoom(Math.max(0, panel.clientHeight - last.offsetHeight - 8));
    };
    measure();
    const panel = panelRef.current;
    const ro = typeof ResizeObserver !== "undefined" && panel ? new ResizeObserver(measure) : null;
    if (ro && panel) ro.observe(panel);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [isOpen]);
  const listsEnabled = savedFeedConstraintsEnforced();
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Initialize draft when drawer opens
  useEffect(() => {
    if (isOpen) {
      setDraft({ ...filters });
    }
  }, [isOpen, filters]);

  // Move focus into the dialog on open; give it back on every close path (confirm, Esc, X, backdrop, parent close).
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    const trig = triggerRef?.current ?? null;
    const raf = requestAnimationFrame(() => {
      const d = drawerRef.current;
      if (d && !d.contains(document.activeElement)) d.querySelector<HTMLElement>("button")?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const target = trig ?? prev;
      if (target && target.isConnected) target.focus();
    };
  }, [isOpen, triggerRef]);

  // Handle Escape key and focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        if (!drawerRef.current.contains(document.activeElement)) {
          e.preventDefault();
          drawerRef.current.querySelector<HTMLElement>("button")?.focus();
          return;
        }
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

  const setList = (key: ListKey, values: string[]) => setDraft((p) => ({ ...p, [key]: values }));

  const handleConfirm = () => {
    onApply(draft);
    onClose();
  };

  const handleResetDraft = () => {
    setDraft({
      ...(listsEnabled ? { excludedTitles: [], includedCompanies: [], excludedCompanies: [] } : {}),
      countryCode: "",
      location: "",
      category: "",
      level: "",
      jobType: "",
      workModel: "",
      datePosted: "",
      industry: "",
      experience: "",
      salaryMin: "",
      sourceType: "",
      company: "",
      hidden: false,
      sort: filters.sort,
    });
  };

  // Selected-filter chips under the header: first three, then "+N Filters" (same idea as the reference).
  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  const split = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  if (draft.countryCode) chips.push({ key: "cc", label: `Country: ${draft.countryCode}`, remove: () => setDraft((p) => ({ ...p, countryCode: "" })) });
  if (draft.location) chips.push({ key: "loc", label: draft.location, remove: () => setDraft((p) => ({ ...p, location: "" })) });
  if (draft.category) chips.push({ key: "cat", label: draft.category, remove: () => setDraft((p) => ({ ...p, category: "" })) });
  for (const l of split(draft.level || "")) chips.push({ key: `lvl-${l}`, label: EXPERIENCE_LEVEL_LABELS[l as keyof typeof EXPERIENCE_LEVEL_LABELS] || l, remove: () => toggleMulti("level", l) });
  for (const t of split(draft.jobType || "")) chips.push({ key: `jt-${t}`, label: t, remove: () => toggleMulti("jobType", t) });
  for (const w of split(draft.workModel || "")) chips.push({ key: `wm-${w}`, label: w, remove: () => toggleMulti("workModel", w) });
  if (draft.datePosted && draft.datePosted !== "all") chips.push({ key: "dp", label: draft.datePosted, remove: () => setDraft((p) => ({ ...p, datePosted: "" })) });
  if (draft.salaryMin) chips.push({ key: "sal", label: salaryLabel(String(draft.salaryMin)), remove: () => setDraft((p) => ({ ...p, salaryMin: "" })) });
  if (draft.company) chips.push({ key: "co", label: draft.company, remove: () => setDraft((p) => ({ ...p, company: "" })) });
  if (draft.sourceType) chips.push({ key: "src", label: `Source: ${draft.sourceType}`, remove: () => setDraft((p) => ({ ...p, sourceType: "" })) });
  if (draft.hidden) chips.push({ key: "hid", label: "Hidden Jobs", remove: () => setDraft((p) => ({ ...p, hidden: false })) });
  if (listsEnabled) {
    for (const k of ["excludedTitles", "includedCompanies", "excludedCompanies"] as const)
      for (const v of draft[k] ?? []) chips.push({ key: `${k}-${v}`, label: LIST_CHIP[k] + v, remove: () => setList(k, (draft[k] ?? []).filter((x) => x !== v)) });
  }
  const chipLimit = 3;

  const goTo = (id: SectionId) => {
    setActiveSection(id);
    // Keep the clicked item highlighted while the smooth scroll settles (a short last section can never reach the top).
    if (lockRef.current) clearTimeout(lockRef.current);
    lockRef.current = setTimeout(() => { lockRef.current = null; }, 900);
    const panel = panelRef.current;
    const el = panel?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (panel && el) panel.scrollTo?.({ top: el.offsetTop - panel.offsetTop - 8, behavior: "smooth" });
  };
  const onPanelScroll = () => {
    const panel = panelRef.current;
    if (!panel || lockRef.current) return;
    const edge = panel.scrollTop + 80;
    let current: SectionId = "basic";
    for (const sec of SECTIONS) {
      const el = panel.querySelector<HTMLElement>(`[data-section="${sec.id}"]`);
      if (el && el.offsetTop - panel.offsetTop <= edge) current = sec.id;
    }
    setActiveSection(current);
  };

  const unavailable = (text: string) => (
    <p className="rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-3 py-2.5 text-xs leading-relaxed text-[#64748B]">{text}</p>
  );
  const sectionHead = (title: string) => <h3 className="text-base font-semibold text-[#0F172A]">{title}</h3>;
  const clearBtn = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-label={label} className="inline-flex items-center gap-1 text-[13px] text-[#0F172A] hover:text-[#2563EB] cursor-pointer">
      <Eraser className="w-4 h-4" aria-hidden="true" />
      Clear All
    </button>
  );
  const checkTiles = (key: "level" | "jobType" | "workModel", items: Array<{ id: string; label: string }>, full?: string) => (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <label key={item.id} className={`${OPTION_BASE} ${full === item.id ? "col-span-2" : ""}`}>
          <input type="checkbox" checked={isSelected(key, item.id)} onChange={() => toggleMulti(key, item.id)} className={CHECK} />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
  const textList = (key: ListKey) => (
    <div className="space-y-2">
      <span className={LABEL}>{LIST_LABELS[key]}</span>
      {!!draft[key]?.length && (
        <div className="flex flex-wrap gap-2">
          {draft[key]!.map((v) => (
            <span key={v} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#DBEAFE] text-[12px] text-[#0F172A]">
              {v}
              <button type="button" aria-label={`Remove ${LIST_LABELS[key]} ${v}`} onClick={() => setList(key, (draft[key] ?? []).filter((x) => x !== v))} className="text-[#475569] hover:text-[#0F172A] cursor-pointer">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("value") as HTMLInputElement;
          setList(key, normalizeTextList([...(draft[key] ?? []), input.value]));
          input.value = "";
        }}
      >
        <input name="value" aria-label={`Add ${LIST_LABELS[key]}`} maxLength={100} placeholder={`Add ${LIST_LABELS[key].toLowerCase()}`} className="flex-1 px-3 py-2.5 rounded-lg bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]" />
        <button type="submit" className="inline-flex items-center gap-1 px-3 rounded-lg bg-[#F1F5F9] hover:bg-[#E8EEF6] text-[13px] text-[#0F172A] cursor-pointer">
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </form>
    </div>
  );
  const salaryIdx = Math.max(0, SALARY_STEPS.indexOf(String(draft.salaryMin ?? "")));

  return (
    <>
      {/* Dimmed backdrop */}
      <div className="fixed inset-0 bg-[#0F172A]/50 z-[70] backdrop-blur-xs transition-opacity" onClick={onClose} aria-hidden="true" />

      {/* Drawer container (872px on wide desktop) */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="All Filters"
        className="fixed inset-y-0 right-0 z-[71] w-full max-w-[872px] bg-white shadow-2xl flex flex-col font-sans animate-in slide-in-from-right duration-300"
      >
        {/* HEADER: back chevron, title + count, Reset All, Confirm */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0 bg-white">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close all filters drawer"
              className="w-9 h-9 min-h-[44px] min-w-[44px] rounded-lg flex items-center justify-center text-[#0F172A] hover:bg-[#F1F5F9] transition cursor-pointer"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 rounded-lg bg-[#F1F5F9] px-3 py-1">
              <h2 className="text-lg font-bold text-[#0F172A]">All Filters</h2>
              {chips.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-[#2563EB] text-white text-xs font-bold">{chips.length}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleResetDraft} className="text-[13px] font-semibold text-[#64748B] hover:text-[#0F172A] hover:underline px-2 py-1 cursor-pointer">
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

        {/* SELECTED CHIPS */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3 border-b border-[#E2E8F0] shrink-0 bg-white">
            {chips.slice(0, chipLimit).map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[#F1F5F9] text-[13px] text-[#0F172A]">
                {c.label}
                <button type="button" onClick={c.remove} aria-label={`Remove ${c.label}`} className="text-[#64748B] hover:text-[#0F172A] cursor-pointer">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {chips.length > chipLimit && (
              <span className="inline-flex items-center h-7 px-2 rounded-md bg-[#DBEAFE] text-[13px] font-semibold text-[#1D4ED8]">+{chips.length - chipLimit} Filters</span>
            )}
          </div>
        )}
        {chips.length === 0 && <div className="border-b border-[#E2E8F0] shrink-0" />}

        {/* BODY: left rail + one continuous scrolling form */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <nav aria-label="Filter sections" className="w-[260px] shrink-0 p-3 space-y-1 bg-white hidden md:block overflow-y-auto">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                onClick={() => goTo(sec.id)}
                aria-current={activeSection === sec.id ? "true" : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition cursor-pointer ${activeSection === sec.id ? "bg-[#F1F5F9]" : "hover:bg-[#F8FAFC]"}`}
              >
                <p className={`text-[15px] font-semibold ${activeSection === sec.id ? "text-[#2563EB]" : "text-[#0F172A]"}`}>{sec.title}</p>
                <p className="text-[11px] text-[#64748B] font-normal truncate">{sec.sub}</p>
              </button>
            ))}
            <div className="mt-4 rounded-xl bg-[#EFF6FF] px-3 py-3 text-[13px] leading-snug text-[#0F172A]">
              <p className="font-bold">Applying for Intern/New Grad?</p>
              <p className="mt-0.5">
                Pick <span className="underline">Intern / New Grad</span> under Experience Level.
              </p>
            </div>
          </nav>

          <div ref={panelRef} onScroll={onPanelScroll} className="flex-1 p-5 overflow-y-auto space-y-6 bg-[#F8FAFC]">
            {savedPriorities && <SavedPrioritiesNote where="drawer" summary={savedPriorities.summary} onEdit={savedPriorities.onEdit} />}

            {/* 1. BASIC JOB CRITERIA */}
            <section data-section="basic" aria-label="Basic Job Criteria" className="space-y-4">
              {sectionHead("Basic Job Criteria")}

              <div className={CARD}>
                <label htmlFor="af-job-category" className={LABEL}>Job Function</label>
                <select
                  id="af-job-category"
                  value={draft.category}
                  onChange={(e) => setDraft((p) => ({ ...p, category: e.target.value }))}
                  aria-label="Select job category"
                  className="w-full h-11 px-3 rounded-lg bg-[#F1F5F9] text-[13px] text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#93C5FD]"
                >
                  <option value="">All Categories</option>
                  <option value="ai">AI & Machine Learning</option>
                  <option value="engineering">Engineering & Software</option>
                  <option value="product">Product Management</option>
                  <option value="design">Design & Creative</option>
                  <option value="data">Data Science & Analytics</option>
                  <option value="marketing">Marketing & Growth</option>
                  <option value="sales">Sales & Business Development</option>
                  <option value="operations">Operations & Support</option>
                  <option value="finance">Finance & Accounting</option>
                </select>
              </div>

              {listsEnabled && (
                <div className="rounded-xl bg-white border border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => setOpenExcl((v) => !v)}
                    aria-expanded={openExcl}
                    className="w-full flex items-center justify-between px-4 py-3 text-[13px] font-semibold text-[#0F172A] cursor-pointer"
                  >
                    Excluded Title
                    <ChevronDown className={`w-4 h-4 transition-transform ${openExcl ? "rotate-180" : ""}`} />
                  </button>
                  {openExcl && <div className="px-4 pb-4">{textList("excludedTitles")}</div>}
                </div>
              )}

              <div className={CARD}>
                <span className={LABEL}>Job Type</span>
                {checkTiles("jobType", [
                  { id: "full-time", label: "Full-time" },
                  { id: "contract", label: "Contract" },
                  { id: "part-time", label: "Part-time" },
                  { id: "internship", label: "Internship" },
                ])}
              </div>

              <div className={CARD}>
                <span className={LABEL}>Work Model</span>
                {checkTiles(
                  "workModel",
                  [
                    { id: "onsite", label: "Onsite" },
                    { id: "hybrid", label: "Hybrid" },
                    { id: "remote", label: "Remote anywhere" },
                  ],
                  "remote"
                )}
                <p className="text-[11px] text-[#64748B] italic">Heuristic match on remote flag & location</p>
              </div>

              <div className={CARD}>
                <div className="flex items-center justify-between">
                  <span className={LABEL}>Location</span>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2" role="group" aria-label="Country">
                  {[
                    { code: "", label: "Worldwide" },
                    { code: "US", label: "US" },
                    { code: "GB", label: "UK" },
                    { code: "CA", label: "Canada" },
                    { code: "DE", label: "Germany" },
                    { code: "IN", label: "India" },
                  ].map((item) => (
                    <button
                      key={item.code || "worldwide"}
                      type="button"
                      onClick={() => setDraft((p) => ({ ...p, countryCode: item.code }))}
                      className={PILL((draft.countryCode || "") === item.code)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    aria-label="City or specific area"
                    type="text"
                    placeholder="City or specific area, e.g. San Francisco, London"
                    value={draft.location}
                    onChange={(e) => setDraft((p) => ({ ...p, location: e.target.value }))}
                    className={INPUT}
                  />
                </div>
              </div>

              <div className={CARD}>
                <span className={LABEL}>Experience Level</span>
                {checkTiles(
                  "level",
                  CANONICAL_EXPERIENCE_LEVELS.map((l) => ({ id: l, label: EXPERIENCE_LEVEL_LABELS[l] }))
                )}
                <p className="text-[11px] text-[#64748B] italic">Heuristic match on title keywords</p>
              </div>

              <div className={CARD}>
                <div className="flex items-center justify-between">
                  <span className={LABEL}>Date Posted</span>
                  {clearBtn("Clear date posted", () => setDraft((p) => ({ ...p, datePosted: "" })))}
                </div>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Date posted">
                  {[
                    { id: "24h", label: "Past 24 hours" },
                    { id: "3d", label: "Past 3 days" },
                    { id: "7d", label: "Past week" },
                    { id: "30d", label: "Past month" },
                  ].map((item) => (
                    <label key={item.id} className={OPTION_BASE}>
                      <input
                        type="radio"
                        name="af-date-posted"
                        checked={draft.datePosted === item.id}
                        onChange={() => setDraft((p) => ({ ...p, datePosted: item.id }))}
                        className="w-[18px] h-[18px] accent-[#2563EB] cursor-pointer"
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </section>

            {/* 2. COMPENSATION & SPONSORSHIP */}
            <section data-section="comp" aria-label="Compensation & Sponsorship" className="space-y-4">
              {sectionHead("Compensation & Sponsorship")}
              <div className={CARD}>
                <div className="flex items-center justify-between">
                  <span className={LABEL}>
                    Minimum Annual Salary <span className="font-normal text-[#475569]">{salaryLabel(String(draft.salaryMin ?? ""))}</span>
                  </span>
                  <div className="inline-flex items-center gap-2 text-sm text-[#0F172A] cursor-pointer">
                    Open to all
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!draft.salaryMin}
                      aria-label="Open to all salaries"
                      onClick={() => setDraft((p) => ({ ...p, salaryMin: p.salaryMin ? "" : "50000" }))}
                      className={`w-10 h-[22px] rounded-full transition-colors relative cursor-pointer ${!draft.salaryMin ? "bg-[#2563EB]" : "bg-[#CBD5E1]"}`}
                    >
                      <span className={`block w-[18px] h-[18px] rounded-full bg-white shadow-xs transition-transform ${!draft.salaryMin ? "translate-x-[20px]" : "translate-x-[2px]"}`} />
                    </button>
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={SALARY_STEPS.length - 1}
                  step={1}
                  value={salaryIdx}
                  aria-label="Minimum annual salary"
                  aria-valuetext={salaryLabel(SALARY_STEPS[salaryIdx])}
                  onChange={(e) => setDraft((p) => ({ ...p, salaryMin: SALARY_STEPS[Number(e.target.value)] }))}
                  className="w-full accent-[#2563EB] cursor-pointer"
                />
                <div className="flex justify-between text-[11px] text-[#64748B]">
                  {SALARY_STEPS.map((v) => (
                    <span key={v || "any"}>{v ? `$${Number(v) / 1000}k` : "Any"}</span>
                  ))}
                </div>
              </div>
              {unavailable("Visa sponsorship and \"exclude security clearance / citizen-only\" filters are not available in this drawer yet.")}
            </section>

            {/* 3. AREAS OF INTERESTS */}
            <section data-section="interests" aria-label="Areas of Interests" className="space-y-4">
              {sectionHead("Areas of Interests")}
              {unavailable("Industry, skill and role-type filters are not available in this drawer yet. Use Job Function and Experience Level in Basic Job Criteria for now.")}
            </section>

            {/* 4. COMPANY INSIGHTS */}
            <section data-section="company" aria-label="Company Insights" className="space-y-4">
              {sectionHead("Company Insights")}
              <div className={CARD}>
                <label htmlFor="af-company" className={LABEL}>Company</label>
                <div className="relative">
                  <Building className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="af-company"
                    aria-label="Company"
                    type="text"
                    placeholder="e.g. Stripe, OpenAI, Linear..."
                    value={draft.company || ""}
                    onChange={(e) => setDraft((p) => ({ ...p, company: e.target.value }))}
                    className={INPUT}
                  />
                </div>
              </div>
              <div className={CARD}>
                <span className={LABEL}>Job Source</span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Job source">
                  {[
                    { val: "", label: "All sources" },
                    { val: "ats", label: "Direct Portals" },
                    { val: "direct", label: "Employer" },
                    { val: "aggregator", label: "Aggregator" },
                  ].map((item) => (
                    <button key={item.val || "all-sources"} type="button" onClick={() => setDraft((p) => ({ ...p, sourceType: item.val }))} className={PILL((draft.sourceType || "") === item.val)}>
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              {listsEnabled && (
                <div className={CARD}>
                  {textList("includedCompanies")}
                  {textList("excludedCompanies")}
                </div>
              )}
              {unavailable(`Company stage and staffing-agency exclusion are not available yet${listsEnabled ? "" : "; company include / exclude lists turn on when the owner enables them"}.`)}
            </section>

            {/* 5. PREFERENCES & HIDDEN */}
            <section data-section="hidden" aria-label="Preferences & Hidden" className="space-y-4">
              {sectionHead("Preferences & Hidden")}
              <div className={`${CARD} flex items-center justify-between`}>
                <div className="space-y-0.5">
                  <p className="text-[13px] font-semibold text-[#0F172A]">View Hidden Positions</p>
                  <p className="text-xs text-[#64748B]">Reveal positions you previously hid from search</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, hidden: !p.hidden }))}
                  role="switch"
                  aria-checked={draft.hidden}
                  aria-label="View Hidden Positions toggle"
                  className={`w-12 h-6 rounded-full transition-colors relative cursor-pointer ${draft.hidden ? "bg-[#2563EB]" : "bg-[#CBD5E1]"}`}
                >
                  <span className={`block w-5 h-5 rounded-full bg-white shadow-xs transition-transform transform ${draft.hidden ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            </section>
            <div aria-hidden="true" style={{ height: tailRoom }} />
          </div>
        </div>
      </div>
    </>
  );
}
