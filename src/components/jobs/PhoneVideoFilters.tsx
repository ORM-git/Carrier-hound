"use client";
import React, { useEffect, useRef, useState } from "react";
import { X, ChevronDown, Plus, Search } from "lucide-react";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { CANONICAL_EXPERIENCE_LEVELS, EXPERIENCE_LEVEL_LABELS } from "@/lib/jobs/experienceLevels";
import type { JobFilterValues } from "./JobFilterBar";
import { useSheetPresence } from "./hooks/useSheetPresence";
import "./phone-video-filters.css";

type Group = "basic" | "compensation" | "interests" | "company";
type Picker = "countryCode" | "location" | "category" | "company";
const CATEGORIES = [
  ["ai", "AI & Machine Learning"],
  ["engineering", "Engineering & Software"],
  ["product", "Product Management"],
  ["design", "Design & Creative"],
  ["data", "Data Science & Analytics"],
  ["marketing", "Marketing & Growth"],
  ["sales", "Sales & Business Development"],
  ["operations", "Operations & Support"],
  ["finance", "Finance & Accounting"],
];
const GROUPS: Array<[Group, string, string]> = [
  ["basic", "Basic Job Criteria", "Job type / Work model / Location / Level"],
  ["compensation", "Compensation & Sponsorship", "Minimum annual salary"],
  ["interests", "Areas of Interests", "Job category"],
  ["company", "Company Insights", "Company search / Job source"],
];
const LABELS: Record<Picker, string> = {
  countryCode: "Country",
  location: "City or specific area",
  category: "Job category",
  company: "Company",
};
const split = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const reset = (sort: JobFilterValues["sort"]): JobFilterValues => ({
  countryCode: "",
  location: "",
  category: "",
  level: "",
  jobType: "",
  workModel: "",
  datePosted: "",
  salaryMin: "",
  sourceType: "",
  company: "",
  industry: "",
  experience: "",
  hidden: false,
  sort,
});

/** Phone-only browse filters. Update uses the existing transient Jobs callback, never profile storage. */
export default function PhoneVideoFilters({
  isOpen,
  onClose,
  filters,
  onApply,
  triggerRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  filters: JobFilterValues;
  onApply: (d: JobFilterValues) => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { present, exiting } = useSheetPresence(isOpen);
  const [draft, setDraft] = useState<JobFilterValues>(filters);
  const [expanded, setExpanded] = useState<Group | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [query, setQuery] = useState("");
  const [salaryError, setSalaryError] = useState("");
  const panel = useRef<HTMLDivElement>(null),
    pickerTrigger = useRef<Picker | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef?.current;
    pickerTrigger.current = null;
    setDraft({ ...filters, hidden: false });
    setExpanded(null);
    setPicker(null);
    setQuery("");
    setSalaryError("");
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      trigger?.focus();
    };
    // A new draft is made once per open. Parent rerenders never overwrite in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (picker) panel.current?.querySelector<HTMLInputElement>("input[type=search]")?.focus();
    else if (pickerTrigger.current)
      panel.current
        ?.querySelector<HTMLButtonElement>(`[data-picker-trigger="${pickerTrigger.current}"]`)
        ?.focus();
  }, [picker]);
  if (!present) return null;
  const set = <K extends keyof JobFilterValues>(key: K, value: JobFilterValues[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const toggle = (key: "jobType" | "workModel" | "level", value: string) =>
    setDraft((d) => ({
      ...d,
      [key]: split(d[key]).includes(value)
        ? split(d[key])
            .filter((v) => v !== value)
            .join(", ")
        : [...split(d[key]), value].join(", "),
    }));
  const closePicker = () => {
    setPicker(null);
    setQuery("");
  };
  const launch = (key: Picker) => {
    pickerTrigger.current = key;
    setPicker(key);
    setQuery("");
  };
  const choiceList = (
    key: "jobType" | "workModel" | "level",
    title: string,
    options: Array<[string, string]>
  ) => (
    <fieldset className="cm-vf-field">
      <legend>
        {title}
        <button type="button" onClick={() => set(key, "")}>
          Clear all
        </button>
      </legend>
      <div className="cm-vf-options">
        {options.map(([id, label]) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={split(draft[key]).includes(id)}
              onChange={() => toggle(key, id)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
  const picked = (key: Picker) =>
    key === "countryCode"
      ? SUPPORTED_COUNTRIES.find((c) => c.code === draft.countryCode)?.name || draft.countryCode
      : key === "category"
        ? CATEGORIES.find((c) => c[0] === draft.category)?.[1] || draft.category
        : draft[key];
  const listField = (key: Picker) => (
    <div className="cm-vf-field">
      <div className="cm-vf-label">{LABELS[key]}</div>
      {draft[key] && (
        <div className="cm-vf-tags">
          <span className="cm-vf-tag">
            {picked(key)}
            <button type="button" aria-label={`Remove ${LABELS[key]}`} onClick={() => set(key, "")}>
              <X size={12} />
            </button>
          </span>
        </div>
      )}
      <button
        className="cm-vf-add"
        type="button"
        data-picker-trigger={key}
        onClick={() => launch(key)}
      >
        <Plus size={13} />
        {draft[key] ? "Change" : "Add"}
      </button>
    </div>
  );
  const chips: Array<{ key: keyof JobFilterValues; value: string; label: string }> = [];
  for (const key of [
    "countryCode",
    "location",
    "category",
    "jobType",
    "workModel",
    "level",
    "datePosted",
    "salaryMin",
    "sourceType",
    "company",
    "experience",
  ] as const) {
    const raw = String(draft[key] || "");
    if (!raw || raw === "all") continue;
    const values = ["jobType", "workModel", "level"].includes(key) ? split(raw) : [raw];
    for (const value of values) {
      const label =
        key === "countryCode"
          ? picked("countryCode") || value
          : key === "category"
            ? picked("category") || value
            : key === "level"
              ? EXPERIENCE_LEVEL_LABELS[value as keyof typeof EXPERIENCE_LEVEL_LABELS] || value
              : key === "salaryMin"
                ? `USD ${Number(value).toLocaleString()}+`
                : value;
      chips.push({ key, value, label });
    }
  }
  const removeChip = (key: keyof JobFilterValues, value: string) => {
    if (key === "jobType" || key === "workModel" || key === "level") toggle(key, value);
    else setDraft((d) => ({ ...d, [key]: "" }));
  };
  const keydown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (picker) closePicker();
      else closeRef.current();
    }
    if (e.key === "Tab") {
      const nodes = Array.from(
        panel.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input,select") || []
      ).filter((n) => n.getClientRects().length && !n.closest("[inert]"));
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || !panel.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || !panel.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first?.focus();
      }
    }
  };
  const apply = () => {
    const salary = String(draft.salaryMin ?? "").trim();
    if (salary && (!Number.isFinite(Number(salary)) || Number(salary) < 0)) {
      setSalaryError("Enter a valid annual amount of zero or more.");
      setExpanded("compensation");
      return;
    }
    onApply({ ...draft, salaryMin: salary, hidden: false });
    closeRef.current();
  };
  const unavailable = (text: string) => (
    <p className="cm-vf-unavailable">{text} Not available in Jobs filters yet.</p>
  );
  const pickerOptions =
    picker === "category"
      ? CATEGORIES
      : picker === "countryCode"
        ? SUPPORTED_COUNTRIES.map((c) => [c.code, c.name])
        : [];
  return (
    <div
      className="cm-vf-root cm-phone-job-filters"
      data-state={exiting ? "closing" : "open"}
      aria-hidden={exiting || undefined}
      ref={(e) => {
        if (e) e.inert = exiting;
      }}
    >
      <button
        className="cm-vf-backdrop"
        type="button"
        tabIndex={-1}
        aria-label="Close filters backdrop"
        onClick={onClose}
      />
      {/* Dialog handles keyboard events from all controls. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="cm-vf-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={picker ? LABELS[picker] : "Filter positions"}
        onKeyDown={keydown}
      >
        <header className="cm-vf-header">
          <h2>
            {picker ? LABELS[picker] : "Preference"}
            {!picker && <span aria-label={`${chips.length} selected filters`}>{chips.length}</span>}
          </h2>
          <div>
            {!picker && (
              <button className="cm-vf-update" type="button" onClick={apply}>
                Update
              </button>
            )}
            <button
              type="button"
              aria-label={picker ? "Back to filters" : "Close filter settings"}
              onClick={picker ? closePicker : onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        {picker ? (
          <div className="cm-vf-picker" key={picker}>
            {draft[picker] && (
              <div className="cm-vf-tags">
                <span className="cm-vf-tag">
                  {picked(picker)}
                  <button
                    type="button"
                    aria-label={`Remove selected ${LABELS[picker]}`}
                    onClick={() => set(picker, "")}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}
            <label className="cm-vf-search">
              <Search size={15} />
              <input
                type="search"
                aria-label={`Search ${LABELS[picker]}`}
                placeholder={`Search ${LABELS[picker].toLowerCase()}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="cm-vf-picker-scroll">
              {picker === "countryCode" || picker === "category" ? (
                <div className="cm-vf-picker-options">
                  {pickerOptions
                    .filter(([, label]) => label.toLowerCase().includes(query.toLowerCase()))
                    .map(([id, label]) => (
                      <button
                        key={id || "all"}
                        type="button"
                        aria-pressed={(draft[picker] || "") === id}
                        onClick={() => set(picker, id)}
                      >
                        {label}
                        {(draft[picker] || "") === id && <span aria-hidden="true">✓</span>}
                      </button>
                    ))}
                </div>
              ) : (
                <div className="cm-vf-free-add">
                  <p>
                    {picker === "company"
                      ? "Matches company names containing this text."
                      : "Matches the city or area text on the job listing."}
                  </p>
                  <button
                    type="button"
                    disabled={!query.trim()}
                    onClick={() => {
                      set(picker, query.trim());
                      setQuery("");
                    }}
                  >
                    Use {query.trim() || "selection"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="cm-vf-summary">
              {chips.slice(0, 6).map((c) => (
                <span key={`${c.key}-${c.value}`}>
                  {c.label}
                  <button
                    type="button"
                    aria-label={`Remove filter ${c.label}`}
                    onClick={() => removeChip(c.key, c.value)}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {chips.length > 6 && <span>+{chips.length - 6}</span>}
            </div>
            <div className="cm-vf-scroll">
              {GROUPS.map(([id, title, summary]) => (
                <section className="cm-vf-group" key={id}>
                  <h3>
                    <button
                      type="button"
                      aria-expanded={expanded === id}
                      aria-controls={`phone-filter-${id}`}
                      onClick={() => {
                        setExpanded(expanded === id ? null : id);
                        panel.current?.querySelector(".cm-vf-scroll")?.scrollTo?.({ top: 0 });
                      }}
                    >
                      <span>
                        {title}
                        {expanded !== id && <small>{summary}</small>}
                      </span>
                      <ChevronDown size={15} className={expanded === id ? "cm-vf-rotated" : ""} />
                    </button>
                  </h3>
                  <div
                    className="cm-vf-expand"
                    id={`phone-filter-${id}`}
                    data-expanded={expanded === id}
                    aria-hidden={expanded !== id}
                    ref={(e) => {
                      if (e) e.inert = expanded !== id;
                    }}
                  >
                    <div>
                      <div className="cm-vf-group-body">
                        {id === "basic" && (
                          <>
                            {choiceList("jobType", "Job type", [
                              ["full-time", "Full-time"],
                              ["contract", "Contract"],
                              ["part-time", "Part-time"],
                              ["internship", "Internship"],
                            ])}
                            {choiceList("workModel", "Work model", [
                              ["onsite", "Onsite"],
                              ["hybrid", "Hybrid"],
                              ["remote", "Remote"],
                            ])}
                            {listField("countryCode")}
                            {listField("location")}
                            {choiceList(
                              "level",
                              "Experience level",
                              CANONICAL_EXPERIENCE_LEVELS.map((l) => [
                                l,
                                EXPERIENCE_LEVEL_LABELS[l],
                              ])
                            )}
                            <fieldset className="cm-vf-field">
                              <legend>
                                Date posted
                                <button type="button" onClick={() => set("datePosted", "")}>
                                  Clear all
                                </button>
                              </legend>
                              <div className="cm-vf-options">
                                {[
                                  ["24h", "Past 24 hours"],
                                  ["3d", "Past 3 days"],
                                  ["7d", "Past week"],
                                  ["30d", "Past month"],
                                ].map(([v, label]) => (
                                  <label key={v}>
                                    <input
                                      type="radio"
                                      name="phone-filter-date"
                                      checked={draft.datePosted === v}
                                      onChange={() => set("datePosted", v)}
                                    />
                                    {label}
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                            {unavailable(
                              "Job function, excluded titles, required years, executive level and radius."
                            )}
                          </>
                        )}
                        {id === "compensation" && (
                          <>
                            <label className="cm-vf-field">
                              Minimum annual salary (USD)
                              <input
                                className="cm-vf-salary"
                                aria-label="Minimum annual salary USD"
                                type="number"
                                min="0"
                                step="1000"
                                value={draft.salaryMin ?? ""}
                                onChange={(e) => {
                                  set("salaryMin", e.target.value);
                                  setSalaryError("");
                                }}
                                aria-invalid={!!salaryError}
                              />
                            </label>
                            {salaryError && <p role="alert">{salaryError}</p>}
                            {unavailable(
                              "Visa sponsorship, clearance and citizenship restrictions."
                            )}
                          </>
                        )}
                        {id === "interests" && (
                          <>
                            {listField("category")}
                            {unavailable(
                              "Multiple job functions, industry, skills and IC / manager."
                            )}
                          </>
                        )}
                        {id === "company" && (
                          <>
                            {listField("company")}
                            <fieldset className="cm-vf-field">
                              <legend>
                                Job source
                                <button type="button" onClick={() => set("sourceType", "")}>
                                  Clear all
                                </button>
                              </legend>
                              <div className="cm-vf-options">
                                {[
                                  ["ats", "Direct portals"],
                                  ["direct", "Employer"],
                                  ["aggregator", "Aggregator"],
                                ].map(([v, label]) => (
                                  <label key={v}>
                                    <input
                                      type="radio"
                                      name="phone-filter-source"
                                      checked={draft.sourceType === v}
                                      onChange={() => set("sourceType", v)}
                                    />
                                    {label}
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                            {unavailable(
                              "Company include / exclude lists, company stage and staffing-agency exclusion."
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              ))}
              <button
                type="button"
                className="cm-vf-reset"
                onClick={() => {
                  setDraft(reset(filters.sort));
                  setSalaryError("");
                }}
              >
                Reset filters
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
