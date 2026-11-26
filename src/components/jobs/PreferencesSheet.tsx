"use client";

import { useSheetPresence } from "./hooks/useSheetPresence";
import "./sheet-motion.css";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronDown, Plus, Search, Check, Lock } from "lucide-react";
import type { UserPreferences } from "@/lib/auth/types";
import { ONBOARDING_CATEGORIES, JOB_TYPE_OPTIONS, LOCATION_OPTIONS, WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";
import { SUPPORTED_COUNTRIES, getCountryName } from "@/lib/countries";
import {
  CANONICAL_EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_LABELS,
  formatExperienceLevels,
  isExperienceLevelFilterActive,
  parseExperienceLevels,
  type CanonicalExperienceLevel,
} from "@/lib/jobs/experienceLevels";
import { MAX_SKILLS, normalizeSkillList, skillKey } from "@/lib/jobs/skillKey";
import YearsRangeControl, { describeRange } from "./YearsRangeControl";
import { isRequiredYearsRangeActive } from "@/lib/jobs/requiredYears";
import { parseWorkAuth, toggleWorkAuth, type WorkAuthId } from "@/lib/onboarding/workAuth";
import { normalizeTextList, MAX_LIST_ITEMS, WORK_MODELS, savedFeedConstraintsEnforced, type DatePostedWindow, type WorkModel } from "@/lib/preferences/feedConstraints";
import {
  activeCount,
  companyConflicts,
  draftFromPreferences,
  groupCounts,
  preferencesFromDraft,
  summarize,
  validateDraft,
  type PreferenceGroup,
  type PreferencesDraft,
} from "@/lib/preferences/model";

interface PreferencesSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The committed (last saved) preferences of the signed-in user. */
  committed: UserPreferences;
  /** Account the committed values belong to. A change while open discards the draft and closes. */
  ownerId: string;
  /** Persists once; must reject on failure. */
  onSave: (next: UserPreferences) => Promise<void>;
  triggerRef?: React.RefObject<HTMLElement | null>;
  /** What the server can apply now (GET /api/jobs/capabilities). Fetched when omitted; a failure means false. */
  capabilities?: { excludedSkillsFilter?: boolean; preferredSkillsRanking?: boolean };
  /** This account's plan, from the page's Pro check. "unknown" until that check is definitive. Preferred-skill ordering needs Pro. */
  accountPlan?: "pro" | "free" | "unknown";
}

const WORK_MODEL_LABELS: Record<WorkModel, string> = { onsite: "Onsite", hybrid: "Hybrid", remote: "Remote" };
const DATE_OPTIONS: Array<{ id: DatePostedWindow | null; label: string }> = [
  { id: null, label: "Any time" },
  { id: "24h", label: "Past 24 hours" },
  { id: "3d", label: "Past 3 days" },
  { id: "7d", label: "Past week" },
  { id: "30d", label: "Past month" },
];
// Annual slider ceilings per currency; the number field accepts any positive amount.
const SALARY_MAX: Record<string, number> = { USD: 500000, EUR: 300000, GBP: 300000, INR: 10000000 };
const SALARY_STEP: Record<string, number> = { USD: 5000, EUR: 5000, GBP: 5000, INR: 50000 };
const CURRENCIES = ["USD", "INR", "EUR", "GBP"];

const PENDING_CONSTRAINT_STORAGE = "Waiting for a storage update on our side; this can't be saved yet.";
const NOT_APPLIED = "Saved, but not applied to your feed yet: whether saved filters may hide jobs is still being decided.";

function NotAppliedNote() {
  return <p className="mt-1.5 rounded-lg bg-[#F8FAFC] px-2.5 py-1.5 text-[12px] text-[#64748B]">{NOT_APPLIED}</p>;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

function Pill({ children, onRemove, removeLabel }: { children: React.ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-lg border border-transparent bg-[#DBEAFE] px-2.5 py-1 text-[13px] font-medium text-[#0F172A]">
      <span className="truncate" title={typeof children === "string" ? children : undefined}>{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="-my-2 -mr-2 inline-flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-[#1E40AF] hover:text-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** One-line summary with +N overflow, derived from the same values the controls edit. */
function SummaryLine({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  const { shown, more } = summarize(items);
  return (
    <p className="flex min-w-0 items-center gap-1 text-[12px] text-[#475569]">
      <span className="min-w-0 truncate">
        <span className="font-semibold text-[#0F172A]">{label}:</span> {shown.join(", ")}
      </span>
      {more > 0 && <span className="shrink-0 rounded-full bg-[#E2E8F0] px-1.5 text-[11px] font-semibold text-[#334155]">+{more}</span>}
    </p>
  );
}

function FieldLabel({ id, children, help, action }: { id?: string; children: React.ReactNode; help?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between">
        <p id={id} className="text-[13px] font-bold text-[#0F172A]">{children}</p>
        {action}
      </div>
      {help && <p className="mt-0.5 text-[12px] leading-snug text-[#64748B]">{help}</p>}
    </div>
  );
}

function LabelClear({ show, label, onClear }: { show: boolean; label: string; onClear: () => void }) {
  if (!show) return null;
  return (
    <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className="ml-2 min-h-[44px] shrink-0 px-1 text-[12px] font-semibold text-[#2563EB]">
      Clear
    </button>
  );
}

function FieldClear({ show, label, onClear }: { show: boolean; label: string; onClear: () => void }) {
  if (!show) return <div className="clear-both" />;
  return (
    <>
      <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className="float-right -my-3 min-h-[44px] px-1 text-[12px] font-semibold text-[#2563EB]">
        Clear
      </button>
      <div className="clear-both" />
    </>
  );
}

const CHIP_STRIP_LIMIT = 6; // reference: first six selections, then "+N"

function CheckOption({ checked, onChange, children, disabled }: { checked: boolean; onChange: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <label
      className={`flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-[13px] transition focus-within:ring-2 focus-within:ring-[#2563EB] ${
        checked ? "border-transparent bg-[#F1F5F9] font-medium text-[#0F172A]" : "border-transparent bg-[#F1F5F9] text-[#334155] hover:bg-[#E8EDF5]"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={onChange} disabled={disabled} />
      <span
        aria-hidden="true"
        className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border ${checked ? "border-[#2563EB] bg-[#2563EB] text-white" : "border-[#CBD5E1] bg-white"}`}
      >
        {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </label>
  );
}

/** Free-text list with add/remove, case-insensitive de-duplication and optional suggestions. */
function TagInput({
  label,
  help,
  values,
  onChange,
  placeholder,
  suggestions = [],
  disabled,
  disabledReason,
  onClear,
  clearLabel,
  normalize = normalizeTextList,
  keyOf = (v: string) => v.toLowerCase(),
  maxItems = MAX_LIST_ITEMS,
}: {
  label: string;
  /** Cleans and de-duplicates the whole list. Default: the generic text list rule. */
  normalize?: (values: string[]) => string[];
  /** Identity of an entry for duplicate and suggestion checks. Must agree with `normalize`. */
  keyOf?: (value: string) => string;
  maxItems?: number;
  help?: string;
  onClear?: () => void;
  clearLabel?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  suggestions?: string[];
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const listId = useId();
  const q = text.trim().toLowerCase();
  const matches = q ? suggestions.filter((s) => s.toLowerCase().includes(q) && !values.some((v) => keyOf(v) === keyOf(s))).slice(0, 6) : [];
  const add = (value: string) => {
    const next = normalize([...values, value]);
    if (next.length !== values.length) onChange(next);
    setText("");
  };
  const full = values.length >= maxItems;
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="block text-[13px] font-bold text-[#0F172A]">{label}</label>
        {onClear && <LabelClear show={values.length > 0 && !disabled} label={clearLabel || label} onClear={onClear} />}
      </div>
      {help && <p className="mb-2 mt-0.5 text-[12px] leading-snug text-[#64748B]">{help}</p>}
      {disabled ? (
        <p className="rounded-xl bg-[#F8FAFC] px-3 py-2 text-[12px] text-[#64748B]">{disabledReason}</p>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" aria-hidden="true" />
            <input
              id={inputId}
              type="text"
              value={text}
              disabled={full}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (text.trim()) add(matches[0] && keyOf(matches[0]) === keyOf(text) ? matches[0] : text);
                }
              }}
              placeholder={full ? `Limit of ${maxItems} reached` : placeholder}
              aria-describedby={listId}
              className="h-11 w-full rounded-xl border border-[#CBD5E1] bg-white pl-9 pr-3 text-[14px] text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#BFDBFE]"
            />
          </div>
          <div id={listId} aria-live="polite">
            {q && (
              <ul className="mt-1.5 space-y-1">
                {matches.map((m) => (
                  <li key={m}>
                    <button type="button" onClick={() => add(m)} className="min-h-[44px] w-full rounded-lg px-3 text-left text-[13px] text-[#0F172A] hover:bg-[#F1F5F9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]">
                      {m}
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" onClick={() => add(text)} className="min-h-[44px] w-full rounded-lg px-3 text-left text-[13px] font-semibold text-[#2563EB] hover:bg-[#EFF6FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]">
                    {matches.length ? "" : "No suggestions. "}Add “{text.trim()}”
                  </button>
                </li>
              </ul>
            )}
          </div>
        </>
      )}
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <Pill key={v} onRemove={disabled ? undefined : () => onChange(values.filter((x) => x !== v))} removeLabel={`Remove ${v}`}>
              {v}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

/** A requested control that has no data source yet: visible, labelled, never saved or counted. */
function PendingControl({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-3 py-2.5" aria-disabled="true">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#94A3B8]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[#475569]">
          {label} <span className="ml-1 rounded-full bg-[#E2E8F0] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#475569]">Unavailable</span>
        </p>
        <p className="mt-0.5 text-[12px] leading-snug text-[#64748B]">{reason}</p>
      </div>
    </div>
  );
}

export default function PreferencesSheet({ isOpen, onClose, committed, ownerId, onSave, triggerRef, capabilities, accountPlan = "unknown" }: PreferencesSheetProps) {
  const { present, exiting } = useSheetPresence(isOpen);
  const [draft, setDraft] = useState<PreferencesDraft>(() => draftFromPreferences(committed));
  const [expanded, setExpanded] = useState<PreferenceGroup | null>(null);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [fetchedCaps, setFetchedCaps] = useState<{ excludedSkillsFilter: boolean; preferredSkillsRanking: boolean }>({ excludedSkillsFilter: false, preferredSkillsRanking: false });
  useEffect(() => {
    // Readiness is never carried over: closed, a new open, a prop override, a failed or stale answer all mean false.
    const none = { excludedSkillsFilter: false, preferredSkillsRanking: false };
    setFetchedCaps(none);
    if (!isOpen || capabilities || typeof fetch !== "function") return;
    let cancelled = false;
    fetch("/api/jobs/capabilities", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setFetchedCaps(j ? { excludedSkillsFilter: j.excludedSkillsFilter === true, preferredSkillsRanking: j.preferredSkillsRanking === true } : none);
      })
      .catch(() => {
        if (!cancelled) setFetchedCaps(none);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, capabilities]);
  const excludedSkillsApplied = (capabilities ? capabilities.excludedSkillsFilter === true : fetchedCaps.excludedSkillsFilter);
  const preferredRankingReady = capabilities ? capabilities.preferredSkillsRanking === true : fetchedCaps.preferredSkillsRanking;
  // Global readiness is not an account entitlement: ordering applies only when the server is ready AND the account is Pro.
  const preferredSkillsApplied = preferredRankingReady && accountPlan === "pro";
  const preferredHelp = !preferredRankingReady
    ? "Saved, but not used to rank your feed yet."
    : accountPlan === "pro"
      ? "Used to order your recommended jobs. Search sorting is not ranked by skills."
      : accountPlan === "free"
        ? "Saved. Preferred skills reorder recommendations for Pro accounts only."
        : "Saved. Your plan is still loading, so ordering isn't confirmed yet.";
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  // Banner growth must not leave the helper line partly scrolled under it.
  useEffect(() => {
    if ((saveError || showErrors) && scrollBodyRef.current) scrollBodyRef.current.scrollTop = 0;
  }, [saveError, showErrors]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const roleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const roleSearchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);
  const previousRolePickerOpen = useRef(false);
  useEffect(() => {
    const changed = previousRolePickerOpen.current !== rolePickerOpen;
    previousRolePickerOpen.current = rolePickerOpen;
    if (!isOpen || !changed) return;
    // Commit-time focus needs no deferred callback that can outlive the sheet.
    (rolePickerOpen ? roleSearchRef : roleTriggerRef).current?.focus();
  }, [isOpen, rolePickerOpen]);
  const titleId = useId();
  const pendingRef = useRef(false);

  // Editable: the constraint columns exist. Applied: also enabled by the owner (default off).
  const constraintsAvailable = committed.feedConstraintsAvailable !== false;
  const constraintsApplied = constraintsAvailable && savedFeedConstraintsEnforced();
  const notAppliedTag = constraintsApplied ? "" : " (saved, not applied)";
  // Advanced columns (years, skills) exist. Never assumed: only an explicit true enables those controls.
  const advancedAvailable = committed.advancedPreferencesAvailable === true;
  const yearsRange = { min: draft.requiredYearsMin ?? null, max: draft.requiredYearsMax ?? null };
  const yearsActive = advancedAvailable && isRequiredYearsRangeActive(yearsRange);

  // The account this draft was opened for. Another account's values never reach this draft or a save.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const ownerChanged = isOpen && openedFor !== null && openedFor !== ownerId;
  useEffect(() => {
    if (!ownerChanged) return;
    setDraft(draftFromPreferences(committed));
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerChanged]);

  // Each open hydrates from the last committed values; closing discards the draft.
  useEffect(() => {
    if (!isOpen) {
      setOpenedFor(null);
      return;
    }
    setOpenedFor(ownerId);
    setDraft(draftFromPreferences(committed));
    setExpanded(null);
    setRolePickerOpen(false);
    setRoleQuery("");
    setOpenCategory(null);
    setSaveError(null);
    setShowErrors(false);
    // Hydrate only on open; committed changing while open must not wipe the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const close = () => {
    if (pendingRef.current) return;
    onClose();
    triggerRef?.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (rolePickerOpen) {
          setRolePickerOpen(false);
        } else close();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
    // close/rolePickerOpen read fresh via closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, rolePickerOpen]);

  const validation = validateDraft(draft);
  const conflicts = companyConflicts(draft);
  const draftCount = activeCount(draft, constraintsApplied, advancedAvailable);
  const counts = groupCounts(draft, constraintsApplied, advancedAvailable);
  const committedDraftJson = useMemo(() => JSON.stringify(draftFromPreferences(committed)), [committed]);
  const isDirty = JSON.stringify(draft) !== committedDraftJson;

  if (!present || ownerChanged) return null;

  const set = <K extends keyof PreferencesDraft>(key: K, value: PreferencesDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggleIn = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const handleUpdate = async () => {
    if (pendingRef.current) return;
    if (!validation.ok) {
      setShowErrors(true);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setSaveError(null);
    try {
      await onSave(preferencesFromDraft(committed, draft));
      pendingRef.current = false;
      setPending(false);
      onClose();
      triggerRef?.current?.focus();
    } catch {
      pendingRef.current = false;
      setPending(false);
      setSaveError("Your preferences were not saved. Your changes are still here, try Update again.");
    }
  };

  const resetAll = () =>
    setDraft((d) => ({
      ...d,
      roles: [],
      excludedTitles: [],
      employmentTypes: [],
      workModels: [],
      locations: [],
      experienceLevel: "",
      datePosted: null,
      minSalary: null,
      includedCompanies: [],
      excludedCompanies: [],
      requiredYearsMin: null,
      requiredYearsMax: null,
      preferredSkills: [],
      excludedSkills: [],
      // Country and work authorization are profile facts: kept on reset.
    }));

  const selectedLevels = parseExperienceLevels(draft.experienceLevel);
  const toggleLevel = (lvl: CanonicalExperienceLevel) => {
    const next = selectedLevels.includes(lvl) ? selectedLevels.filter((l) => l !== lvl) : [...selectedLevels, lvl];
    set("experienceLevel", formatExperienceLevels(CANONICAL_EXPERIENCE_LEVELS.filter((l) => next.includes(l))));
  };
  const isUS = draft.countryCode === "US";
  const workAuthIds = parseWorkAuth(draft.workAuth) ?? [];
  const currency = draft.salaryCurrency || "";
  const sliderMax = SALARY_MAX[currency] ?? 500000;
  const sliderStep = SALARY_STEP[currency] ?? 5000;
  const roleQ = roleQuery.trim().toLowerCase();
  const countryName = draft.countryCode ? getCountryName(draft.countryCode) || draft.countryCode : "";
  const committedCountry = (committed.countryCode || "").toUpperCase();
  const legacyLocations = committed.locations || [];

  type PrefChip = { kind: "function" | "excluded" | "type" | "work-model" | "level" | "years" | "skill" | "posted" | "location"; text: string };
  const activeChips: PrefChip[] = [
    ...draft.roles.map((text) => ({ kind: "function" as const, text })),
    ...(constraintsAvailable ? draft.excludedTitles.map((t) => ({ kind: "excluded" as const, text: `Not: ${t}${notAppliedTag}` })) : []),
    ...draft.employmentTypes.map((t) => ({ kind: "type" as const, text: JOB_TYPE_OPTIONS.find((o) => o.id === t)?.label || t })),
    ...draft.workModels.map((m) => ({ kind: "work-model" as const, text: WORK_MODEL_LABELS[m] })),
    ...(isExperienceLevelFilterActive(draft.experienceLevel) ? selectedLevels.map((l) => ({ kind: "level" as const, text: EXPERIENCE_LEVEL_LABELS[l] })) : []),
    ...(advancedAvailable ? draft.preferredSkills.map((t) => ({ kind: "skill" as const, text: `Skill: ${t}${preferredSkillsApplied ? "" : " (saved, not applied)"}` })) : []),
    ...(advancedAvailable ? draft.excludedSkills.map((t) => ({ kind: "skill" as const, text: `Not skill: ${t}${excludedSkillsApplied ? "" : " (saved, not applied)"}` })) : []),
    ...(yearsActive ? [{ kind: "years" as const, text: `Years: ${describeRange(yearsRange)}${notAppliedTag}` }] : []),
    ...(constraintsAvailable && draft.datePosted ? [{ kind: "posted" as const, text: `${DATE_OPTIONS.find((o) => o.id === draft.datePosted)!.label}${notAppliedTag}` }] : []),
    ...normalizeTextList([countryName, ...draft.locations]).map((text) => ({ kind: "location" as const, text })),
  ];

  const group = (id: PreferenceGroup, title: string, summary: React.ReactNode, body: React.ReactNode) => {
    const open = expanded === id;
    const count = counts[id];
    return (
      <section className="mx-4 my-3 overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
        <h3>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`pref-group-${id}`}
            onClick={() => setExpanded(open ? null : id)}
            className="flex min-h-[56px] w-full items-center justify-between gap-3 px-5 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2563EB]"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[15px] font-bold text-[#0F172A]">
                {title}
                {count > 0 && <span className="rounded-full bg-[#2563EB] px-1.5 text-[11px] font-bold text-white">{count}</span>}
              </span>
              {!open && <span className="mt-1 block space-y-0.5">{summary}</span>}
            </span>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#F1F5F9]"><ChevronDown className={`h-4 w-4 text-[#0F172A] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" /></span>
          </button>
        </h3>
        {open && (
          <div id={`pref-group-${id}`} className="space-y-5 px-5 pb-6">
            {body}
          </div>
        )}
      </section>
    );
  };

  const roleList = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pb-1 pt-2">
        <h3 className="text-[20px] font-bold text-[#0F172A]">Job Function</h3>
        <button
          type="button"
          onClick={() => {
            setRolePickerOpen(false);
          }}
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F1F5F9] text-[#0F172A] hover:bg-[#E2E8F0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="px-5 pb-3 pt-1">
        {draft.roles.length > 0 && (
          <div className="mb-3 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto" aria-label="Selected job functions">
            {draft.roles.map((r) => (
              <Pill key={r} onRemove={() => set("roles", draft.roles.filter((x) => x !== r))} removeLabel={`Remove ${r}`}>{r}</Pill>
            ))}
          </div>
        )}
        <label htmlFor="pref-role-search" className="sr-only">Search job functions</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" aria-hidden="true" />
          <input
            id="pref-role-search"
            ref={roleSearchRef}
            type="search"
            value={roleQuery}
            onChange={(e) => setRoleQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && roleQuery.trim()) {
                e.preventDefault();
                set("roles", normalizeTextList([...draft.roles, roleQuery]));
                setRoleQuery("");
              }
            }}
            placeholder="Search roles, e.g. Data Engineer"
            className="h-11 w-full rounded-xl border border-transparent bg-[#F1F5F9] pl-9 pr-3 text-[14px] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#BFDBFE]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#EEF2F9] px-4 py-3">
        {ONBOARDING_CATEGORIES.map((cat) => {
          const subgroups = cat.subgroups
            .map((sg) => ({ ...sg, roles: roleQ ? sg.roles.filter((r) => r.toLowerCase().includes(roleQ)) : sg.roles }))
            .filter((sg) => sg.roles.length);
          if (!subgroups.length) return null;
          const open = Boolean(roleQ) || openCategory === cat.id;
          const selectedHere = cat.subgroups.reduce((n, sg) => n + sg.roles.filter((r) => draft.roles.includes(r)).length, 0);
          return (
            <div key={cat.id} className="mb-2 rounded-2xl bg-white px-4">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenCategory(openCategory === cat.id ? null : cat.id)}
                className="flex min-h-[48px] w-full items-center justify-between gap-2 text-left text-[14px] font-semibold text-[#0F172A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
              >
                <span>
                  {cat.name}
                  {selectedHere > 0 && <span className="ml-2 rounded-full bg-[#DBEAFE] px-1.5 text-[11px] font-bold text-[#1E40AF]">{selectedHere}</span>}
                </span>
                <ChevronDown className={`h-4 w-4 text-[#0F172A] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
              </button>
              {open && (
                <div className="space-y-3 pb-3">
                  {subgroups.map((sg) => (
                    <fieldset key={sg.name}>
                      <legend className="mb-2 text-[14px] font-bold text-[#0F172A]">{sg.name}</legend>
                      <div className="flex flex-wrap gap-2">
                        {sg.roles.map((r) => (
                          <label key={r} className={`inline-flex min-h-[36px] cursor-pointer items-center rounded-lg px-3 text-[13px] focus-within:ring-2 focus-within:ring-[#2563EB] ${draft.roles.includes(r) ? "bg-[#DBEAFE] font-medium text-[#1E3A8A]" : "bg-[#F1F5F9] text-[#334155]"}`}>
                            <input type="checkbox" className="sr-only" checked={draft.roles.includes(r)} onChange={() => set("roles", toggleIn(draft.roles, r))} />
                            {r}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {roleQ && !ONBOARDING_CATEGORIES.some((c) => c.subgroups.some((sg) => sg.roles.some((r) => r.toLowerCase().includes(roleQ)))) && (
          <p className="py-4 text-[13px] text-[#64748B]">No matching roles in our list.</p>
        )}
        {roleQ && (
          <button
            type="button"
            onClick={() => {
              set("roles", normalizeTextList([...draft.roles, roleQuery]));
              setRoleQuery("");
            }}
            className="mt-2 min-h-[44px] w-full rounded-xl border border-dashed border-[#93C5FD] px-3 text-left text-[13px] font-semibold text-[#2563EB] hover:bg-[#EFF6FF]"
          >
            Add “{roleQuery.trim()}” as a custom role
          </button>
        )}
      </div>
    </div>
  );

  // Portalled so a transformed/animated feed ancestor can't offset the fixed overlay.
  return createPortal(
    <div className="cm-sheet-preferences fixed inset-0 z-[80]" data-sheet-state={exiting ? "closing" : "open"} ref={(element) => { if (element) element.inert = exiting; }} aria-hidden={exiting || undefined} data-testid="preferences-sheet">
      <button type="button" tabIndex={-1} aria-label="Close preferences" className="cm-sheet-backdrop absolute inset-0 border-0 bg-slate-900/40" onClick={close} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="cm-sheet-panel absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-3xl bg-white shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[480px] sm:rounded-none sm:rounded-l-2xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto mb-1 mt-3 h-1.5 w-12 shrink-0 rounded-full bg-slate-300 sm:hidden" aria-hidden="true" />
        <div className={`shrink-0 items-center justify-between gap-2 border-b border-[#E2E8F0] px-5 py-2.5 max-[359px]:px-3 ${rolePickerOpen ? "hidden" : "flex"}`}>
          <div className="flex min-w-0 items-center gap-2">
            <h2 id={titleId} className="min-w-0 truncate text-[17px] font-bold text-[#0F172A] max-[359px]:text-[16px]">Preferences</h2>
            {draftCount > 0 && (
              <span className="shrink-0 rounded-full bg-[#2563EB] px-2 py-0.5 text-[11px] font-bold text-white" aria-label={`${draftCount} active preference${draftCount === 1 ? "" : "s"}`}>
                {draftCount}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleUpdate}
              disabled={pending}
              aria-busy={pending}
              className="flex h-11 min-w-[88px] shrink-0 items-center justify-center rounded-full bg-[#2563EB] px-5 text-[13px] max-[359px]:min-w-[72px] max-[359px]:px-4 font-bold text-white shadow-sm transition hover:bg-[#1D4ED8] disabled:cursor-wait disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]"
            >
              {pending ? "Saving…" : "Update"}
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              disabled={pending}
              aria-label="Close preferences without saving"
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#475569] max-[359px]:h-10 max-[359px]:w-10 hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div aria-live="polite" className="shrink-0">
          {saveError && (
            <p role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-[13px] font-medium text-rose-700">{saveError}</p>
          )}
          {showErrors && !validation.ok && (
            <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-[13px] font-medium text-amber-800">{validation.errors.companies || "Fix the highlighted fields before updating."}</p>
          )}
        </div>

        {rolePickerOpen ? (
          roleList
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#EEF2F9]" data-testid="preferences-scroll-body" ref={scrollBodyRef} style={{ overflowAnchor: "none" }}>
            <div className="flex items-center justify-between px-5 pt-3 text-[12px] text-[#64748B]">
              <span>
                Update saves these to your account and refreshes Recommended.
                {isDirty && " Unsaved changes."}
              </span>
              <button type="button" onClick={resetAll} className="ml-3 min-h-[44px] shrink-0 px-1 font-semibold text-[#475569] underline-offset-2 hover:underline">
                Clear all
              </button>
            </div>
            {activeChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-5 pt-1 pb-1" data-testid="preferences-chips" aria-label="Selected preferences" role="list">
                {(chipsExpanded ? activeChips : activeChips.slice(0, CHIP_STRIP_LIMIT)).map((c, i) => (
                  <span key={`${c.kind}-${c.text}-${i}`} data-chip={c.kind} role="listitem" className="max-w-full truncate rounded-md bg-[#E2E8F0] px-[5px] py-[3px] text-[11px] font-medium leading-[15px] text-[#0F172A]">{c.text}</span>
                ))}
                {activeChips.length > CHIP_STRIP_LIMIT && (
                  <button type="button" aria-expanded={chipsExpanded} onClick={() => setChipsExpanded((v) => !v)} className="relative rounded-md bg-white px-[5px] py-[3px] text-[11px] font-medium leading-[15px] text-[#0F172A] before:absolute before:-inset-2 before:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]">
                    {chipsExpanded ? "Less" : `+${activeChips.length - CHIP_STRIP_LIMIT}`}
                  </button>
                )}
              </div>
            )}

            {group(
              "basic",
              "Basic",
              <span className="block text-[12px] text-[#64748B]">Function / Type / Work model / Location / Level / Posted</span>,
              <>
                <div>
                  <FieldLabel help="Ranks matching roles higher. Pick from the list or add your own title.">Job function</FieldLabel>
                  {draft.roles.length > 0 && (
                    <div data-testid="job-function-chips" className="mb-2 flex flex-wrap gap-1.5">
                      {draft.roles.map((r) => (
                        <Pill key={r} onRemove={() => set("roles", draft.roles.filter((x) => x !== r))} removeLabel={`Remove ${r}`}>{r}</Pill>
                      ))}
                    </div>
                  )}
                  <button
                    ref={roleTriggerRef}
                    type="button"
                    onClick={() => setRolePickerOpen(true)}
                    aria-label={draft.roles.length ? "Add job function" : "Choose job functions"}
                    aria-haspopup="dialog"
                    className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-[#CBD5E1] bg-white px-3 text-[14px] font-medium text-[#0F172A] hover:border-[#94A3B8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]"
                  >
                    <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {draft.roles.length ? "Add" : "Choose job functions"}
                  </button>
                </div>

                <TagInput
                  label="Exclude job titles"
                  help="Hides any job whose title contains one of these words (not case-sensitive), even if it matches your job function."
                  values={draft.excludedTitles}
                  onChange={(v) => set("excludedTitles", v)}
                  placeholder="e.g. Sales, Intern"
                  disabled={!constraintsAvailable}
                  disabledReason={PENDING_CONSTRAINT_STORAGE}
                />
                {constraintsAvailable && !constraintsApplied && <NotAppliedNote />}

                <fieldset>
                  <legend className="float-left mb-[13px] text-[13px] font-bold text-[#0F172A]">Job type</legend>
                    <FieldClear show={draft.employmentTypes.length > 0} label="job type" onClear={() => set("employmentTypes", [])} />
                  <div className="grid grid-cols-2 gap-2">
                    {JOB_TYPE_OPTIONS.map((o) => (
                      <CheckOption key={o.id} checked={draft.employmentTypes.includes(o.id)} onChange={() => set("employmentTypes", toggleIn(draft.employmentTypes, o.id))}>
                        {o.label}
                      </CheckOption>
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="float-left mb-[13px] text-[13px] font-bold text-[#0F172A]">Work model</legend>
                    <FieldClear show={draft.workModels.length > 0} label="work model" onClear={() => set("workModels", [])} />
                  <div className="grid grid-cols-3 gap-2">
                    {WORK_MODELS.map((m) => (
                      <CheckOption
                        key={m}
                        checked={draft.workModels.includes(m)}
                        onChange={() =>
                          set(
                            "workModels",
                            constraintsAvailable ? toggleIn(draft.workModels, m) : draft.workModels.includes(m) ? [] : [m]
                          )
                        }
                      >
                        {WORK_MODEL_LABELS[m]}
                      </CheckOption>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[12px] text-[#64748B]">
                    {!constraintsAvailable
                      ? "One choice for now: saving several needs a storage update on our side."
                      : draft.workModels.length > 1
                      ? "Saved as chosen. Ranking reads one choice only, so several rank as open to any setup."
                      : "One choice ranks that setup higher."}
                  </p>
                </fieldset>

                <div>
                  <label htmlFor="pref-country" className="block text-[13px] font-bold text-[#0F172A]">Country</label>
                  <select
                    id="pref-country"
                    value={draft.countryCode}
                    onChange={(e) => set("countryCode", e.target.value)}
                    className="mt-2 h-11 w-full rounded-xl border border-[#CBD5E1] bg-white px-3 text-[14px] text-[#0F172A] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#BFDBFE]"
                  >
                    {!SUPPORTED_COUNTRIES.some((c) => c.code === committedCountry) && committedCountry && (
                      <option value={committedCountry}>{getCountryName(committedCountry) || committedCountry} (saved)</option>
                    )}
                    {SUPPORTED_COUNTRIES.map((c) => (
                      <option key={c.code || "ww"} value={c.code}>{c.code ? c.name : "Not set (worldwide)"}</option>
                    ))}
                  </select>
                  {draft.countryCode !== committedCountry && draft.locations.length > 0 && (
                    <p className="mt-1.5 text-[12px] text-[#92400E]">Your cities below are kept. Remove any that are outside {countryName || "your new choice"}.</p>
                  )}
                </div>

                <TagInput
                  label="Cities or regions"
                  help="Ranks jobs in these places higher."
                  values={draft.locations}
                  onChange={(v) => set("locations", v)}
                  placeholder="Search or type a city"
                  suggestions={Array.from(new Set([...(draft.countryCode === "IN" || !draft.countryCode ? LOCATION_OPTIONS : []), ...legacyLocations]))}
                />
                <PendingControl label="Search radius" reason="This control isn't enabled yet." />

                <fieldset>
                  <legend className="mb-2 text-[13px] font-bold text-[#0F172A]">Experience level</legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {CANONICAL_EXPERIENCE_LEVELS.map((lvl) => (
                      <label
                        key={lvl}
                        className={`flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg border border-transparent bg-[#F1F5F9] px-3 text-[13px] focus-within:ring-2 focus-within:ring-[#2563EB] ${
                          selectedLevels.includes(lvl) ? "font-medium text-[#0F172A]" : "text-[#334155]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#2563EB]"
                          checked={selectedLevels.includes(lvl)}
                          onChange={() => toggleLevel(lvl)}
                        />
                        {EXPERIENCE_LEVEL_LABELS[lvl]}
                      </label>
                    ))}
                  </div>
                  {selectedLevels.length > 0 && (
                    <button type="button" onClick={() => set("experienceLevel", "")} className="mt-1.5 min-h-[44px] text-[12px] font-semibold text-[#2563EB]">
                      Clear level
                    </button>
                  )}
                  <p className="mt-1 text-[12px] text-[#64748B]">{constraintsApplied
                      ? "Pick any levels. Your feed shows jobs matching any selected level, using title words like “Senior”. A level you pick while browsing overrides this."
                      : "Pick any levels. Jobs matching any selected level rank higher, using title words like “Senior”. Saved levels rank jobs only for now."}</p>
                </fieldset>
                {advancedAvailable ? (
                  <div>
                    <YearsRangeControl
                      value={yearsRange}
                      onChange={(r) => setDraft((d) => ({ ...d, requiredYearsMin: r ? r.min : null, requiredYearsMax: r ? r.max : null }))}
                      action={<LabelClear show={yearsActive} label="years of experience" onClear={() => setDraft((d) => ({ ...d, requiredYearsMin: null, requiredYearsMax: null }))} />}
                    />
                    <p className="mt-1 text-[12px] text-[#64748B]">
                      {constraintsApplied
                        ? "Shows jobs whose stated years overlap this range. Jobs that state no years stay in."
                        : "Saved, but not applied to your feed yet. Jobs that state no years stay in once it is."}
                    </p>
                  </div>
                ) : (
                  <PendingControl label="Years of experience (min / max)" reason="This control isn't enabled yet." />
                )}

                <fieldset>
                  <legend className="float-left mb-[13px] text-[13px] font-bold text-[#0F172A]">Date posted</legend>
                    <FieldClear show={constraintsAvailable && draft.datePosted !== null} label="date posted" onClear={() => set("datePosted", null)} />
                  {constraintsAvailable ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        {DATE_OPTIONS.map((o) => (
                          <label
                            key={o.id ?? "any"}
                            className={`flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg border border-transparent bg-[#F1F5F9] px-3 text-[13px] focus-within:ring-2 focus-within:ring-[#2563EB] ${
                              draft.datePosted === o.id ? "font-medium text-[#0F172A]" : "text-[#334155]"
                            }`}
                          >
                            <input type="radio" name="pref-date" className="h-4 w-4 accent-[#2563EB]" checked={draft.datePosted === o.id} onChange={() => set("datePosted", o.id)} />
                            {o.label}
                          </label>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[12px] text-[#64748B]">Jobs whose source gives no posting date are left out while a window is set.</p>
                      {!constraintsApplied && <NotAppliedNote />}
                    </>
                  ) : (
                    <p className="rounded-xl bg-[#F8FAFC] px-3 py-2 text-[12px] text-[#64748B]">{PENDING_CONSTRAINT_STORAGE}</p>
                  )}
                </fieldset>
              </>
            )}

            {group(
              "compensation",
              "Compensation",
              <>
                <SummaryLine label="Minimum" items={draft.minSalary && currency ? [`${formatMoney(draft.minSalary, currency)} / year`] : []} />
                <SummaryLine label="Work authorization" items={workAuthIds.map((id) => WORK_AUTH_OPTIONS.find((o) => o.id === id)!.label)} />
              </>,
              <>
                <div>
                  <FieldLabel
                    id="pref-salary-label"
                    action={<LabelClear show={draft.minSalary != null} label="minimum salary" onClear={() => set("minSalary", null)} />}
                    help="Annual amount. Jobs listing a lower pay in the same currency rank lower; hourly and monthly pay is converted to a year, other currencies are never converted, and jobs without pay info stay in."
                  >
                    Minimum annual salary
                  </FieldLabel>
                  <div className="flex gap-2">
                    <label htmlFor="pref-currency" className="sr-only">Currency</label>
                    <select
                      id="pref-currency"
                      value={currency}
                      onChange={(e) => set("salaryCurrency", e.target.value)}
                      aria-invalid={Boolean(showErrors && validation.errors.salaryCurrency)}
                      className="h-11 w-24 shrink-0 rounded-xl border border-[#CBD5E1] aria-[invalid=true]:border-rose-500 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-rose-200 bg-white px-2 text-[14px] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#BFDBFE]"
                    >
                      <option value="">—</option>
                      {Array.from(new Set([...CURRENCIES, ...(committed.salaryCurrency ? [committed.salaryCurrency] : [])])).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <label htmlFor="pref-salary" className="sr-only">Minimum annual salary amount</label>
                    <input
                      id="pref-salary"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={sliderStep}
                      value={draft.minSalary ?? ""}
                      placeholder="No minimum"
                      onChange={(e) => set("minSalary", e.target.value === "" ? null : Number(e.target.value))}
                      aria-invalid={Boolean(showErrors && validation.errors.minSalary)}
                      aria-describedby="pref-salary-error"
                      className="h-11 min-w-0 flex-1 rounded-xl border border-[#CBD5E1] aria-[invalid=true]:border-rose-500 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-rose-200 bg-white px-3 text-[14px] focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#BFDBFE]"
                    />
                  </div>
                  <input
                    type="range"
                    aria-labelledby="pref-salary-label"
                    min={0}
                    max={sliderMax}
                    step={sliderStep}
                    value={Math.min(draft.minSalary ?? 0, sliderMax)}
                    onChange={(e) => set("minSalary", Number(e.target.value) || null)}
                    aria-valuetext={draft.minSalary ? `${currency ? formatMoney(draft.minSalary, currency) : draft.minSalary} per year` : "No minimum"}
                    className="mt-3 h-11 w-full accent-[#2563EB]"
                  />
                  <div className="flex justify-between text-[11px] text-[#64748B]" aria-hidden="true">
                    <span>No minimum</span>
                    <span>{currency ? formatMoney(sliderMax, currency) : sliderMax.toLocaleString()}+</span>
                  </div>
                  <p id="pref-salary-error" className="mt-1 text-[12px] font-medium text-rose-700">
                    {showErrors ? validation.errors.minSalary || validation.errors.salaryCurrency || "" : ""}
                  </p>
                </div>

                <fieldset>
                  <legend className="text-[13px] font-bold text-[#0F172A]">{isUS ? "Work authorization and H-1B sponsorship" : "Work authorization"}</legend>
                  <p className="mb-2 mt-0.5 text-[12px] leading-snug text-[#64748B]">
                    Saved to your profile. It doesn’t filter jobs yet, and we can’t confirm which employers sponsor visas.
                  </p>
                  <div className="space-y-2">
                    {WORK_AUTH_OPTIONS.map((o) => (
                      <CheckOption key={o.id} checked={workAuthIds.includes(o.id as WorkAuthId)} onChange={() => set("workAuth", toggleWorkAuth(draft.workAuth, o.id as WorkAuthId))}>
                        {o.id === "requires_sponsorship" && isUS ? "I need visa sponsorship (e.g. H-1B)." : o.label}
                      </CheckOption>
                    ))}
                  </div>
                </fieldset>
                <PendingControl label="Exclude jobs requiring security clearance" reason="We don't have verified clearance requirements for jobs yet. Unknown isn't the same as “not required”." />
                <PendingControl label={isUS ? "Exclude US-citizen-only jobs" : "Exclude citizen-only jobs"} reason="We don't have verified citizenship requirements for jobs yet." />
              </>
            )}

            {group(
              "interests",
              "Interests",
              advancedAvailable && (draft.preferredSkills.length > 0 || draft.excludedSkills.length > 0) ? (
                <>
                  <SummaryLine label={`Preferred skills${preferredSkillsApplied ? "" : " (saved, not applied)"}`} items={draft.preferredSkills} />
                  <SummaryLine label={`Excluded skills${excludedSkillsApplied ? "" : " (saved, not applied)"}`} items={draft.excludedSkills} />
                </>
              ) : (
                <p className="text-[12px] text-[#64748B]">{advancedAvailable ? "No skills set" : "Not available yet"}</p>
              ),
              <>
                <PendingControl label="Industries to include / exclude" reason="Jobs and companies don't have a verified industry classification yet." />
                {advancedAvailable ? (
                  <>
                    <TagInput
                      label="Preferred skills"
                      help={`Skills you want more of. ${preferredHelp}`}
                      values={draft.preferredSkills}
                      onChange={(v) => set("preferredSkills", v)}
                      placeholder="Type a skill"
                      onClear={() => set("preferredSkills", [])}
                      clearLabel="preferred skills"
                      normalize={normalizeSkillList}
                      keyOf={skillKey}
                      maxItems={MAX_SKILLS}
                    />
                    <TagInput
                      label="Excluded skills"
                      help={`Hides jobs that list one of these skills.${excludedSkillsApplied ? "" : " Saved, but not applied to your feed yet."} Jobs with no skill data stay in.`}
                      values={draft.excludedSkills}
                      onChange={(v) => set("excludedSkills", v)}
                      placeholder="Type a skill"
                      onClear={() => set("excludedSkills", [])}
                      clearLabel="excluded skills"
                      normalize={normalizeSkillList}
                      keyOf={skillKey}
                      maxItems={MAX_SKILLS}
                    />
                    <p className="text-[12px] text-[#64748B]">Matches skills exactly as a job lists them. A to Z ignore case. Other letters must match exactly. Your resume skills are unchanged.</p>
                    {showErrors && validation.errors.skills && (
                      <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">{validation.errors.skills}</p>
                    )}
                  </>
                ) : (
                  <PendingControl label="Skills" reason="This control isn't enabled yet. Your resume skills are unchanged." />
                )}
                <PendingControl label="Individual contributor or manager" reason="Jobs aren't classified as people-manager roles yet; seniority alone can't tell." />
              </>
            )}

            {group(
              "company",
              "Company",
              <>
                <SummaryLine label={`Only${notAppliedTag}`} items={constraintsAvailable ? draft.includedCompanies : []} />
                <SummaryLine label={`Never${notAppliedTag}`} items={constraintsAvailable ? draft.excludedCompanies : []} />
              </>,
              <>
                <TagInput
                  label="Only show these companies"
                  help="Exact company name, not case-sensitive. Leave empty for all companies."
                  values={draft.includedCompanies}
                  onChange={(v) => set("includedCompanies", v)}
                  placeholder="Type a company name"
                  disabled={!constraintsAvailable}
                  disabledReason={PENDING_CONSTRAINT_STORAGE}
                  onClear={() => set("includedCompanies", [])}
                  clearLabel="only-show companies"
                />
                <TagInput
                  label="Never show these companies"
                  help="Exact company name, not case-sensitive."
                  values={draft.excludedCompanies}
                  onChange={(v) => set("excludedCompanies", v)}
                  placeholder="Type a company name"
                  disabled={!constraintsAvailable}
                  disabledReason={PENDING_CONSTRAINT_STORAGE}
                  onClear={() => set("excludedCompanies", [])}
                  clearLabel="never-show companies"
                />
                {constraintsAvailable && !constraintsApplied && <NotAppliedNote />}
                {conflicts.length > 0 && (
                  <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    {conflicts.join(", ")} {conflicts.length === 1 ? "is" : "are"} in both lists. {validation.errors.companies}
                  </p>
                )}
                <PendingControl label="Company stage (Early, Growth, Late, Public)" reason="We don't have verified funding-stage data for employers." />
                <PendingControl label="Exclude staffing agencies" reason="We don't have a verified staffing-agency classification; consultancies aren't assumed to be agencies." />
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
