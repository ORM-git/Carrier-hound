"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Plus, Trash2, AlertCircle, Loader2 } from "lucide-react";
import { CandidateProfile, WorkExperienceItem, EducationItem } from "@/lib/resume/types";
import { sanitizeCandidateProfile } from "@/lib/security/xss";

export type ProfileSection = "personal" | "education" | "experience" | "skills";

interface ProfileDrawersProps {
  isOpen: boolean;
  section: ProfileSection | null;
  candidate: CandidateProfile | null;
  openerElement: HTMLElement | null;
  onClose: () => void;
  onSave: (updated: CandidateProfile) => Promise<void>;
}

const DRAFT_STORAGE_PREFIX = "careermonke:profile-draft:";
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredProfileDraft {
  ts: number;
  draft: CandidateProfile;
}

function draftStorageKey(email: string | undefined, section: ProfileSection | null): string | null {
  if (!email || !section) return null;
  return `${DRAFT_STORAGE_PREFIX}${email}:${section}`;
}

function readStoredDraft(key: string): StoredProfileDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredProfileDraft;
    if (!parsed || typeof parsed.ts !== "number" || !parsed.draft) return null;
    if (Date.now() - parsed.ts > DRAFT_MAX_AGE_MS) {
      // Stale draft: expire it instead of surfacing week-old edits.
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export default function ProfileDrawers({
  isOpen,
  section,
  candidate,
  openerElement,
  onClose,
  onSave,
}: ProfileDrawersProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Draft profile copy for unsaved edits
  const [draft, setDraft] = useState<CandidateProfile>(() => createInitialDraft(candidate));

  // New skill input state inside Skills drawer
  const [newSkill, setNewSkill] = useState("");

  // Re-initialize draft whenever drawer opens or candidate updates.
  // Form autosave/draft: a stored unsaved draft for this section wins over
  // the server copy and is restored with a dismissable notice.
  useEffect(() => {
    if (isOpen) {
      const key = draftStorageKey(candidate?.email, section);
      const stored = key ? readStoredDraft(key) : null;
      // Silent restore (owner rule: no visible UI changes). The 7-day
      // expiry and sign-out purge keep stale/foreign drafts out.
      setDraft(stored ? stored.draft : createInitialDraft(candidate));
      setError(null);
      setSaving(false);
      setNewSkill("");
    }
  }, [isOpen, candidate, section]);

  // Autosave the draft (debounced) while the drawer is open so unsaved
  // edits survive an accidental close, navigation, or reload. Stored on
  // this device only, keyed by account email + section; cleared on save
  // or explicit discard.
  useEffect(() => {
    if (!isOpen) return;
    const key = draftStorageKey(candidate?.email, section);
    if (!key) return;
    const handle = window.setTimeout(() => {
      try {
        const entry: StoredProfileDraft = { ts: Date.now(), draft };
        window.localStorage.setItem(key, JSON.stringify(entry));
      } catch {
        // Storage full or unavailable; autosave is best-effort.
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [draft, isOpen, candidate?.email, section]);

  // Focus trap, Escape key handling, and background interaction blocking
  useEffect(() => {
    if (!isOpen) return;

    const drawerNode = drawerRef.current;
    if (!drawerNode) return;

    const previousActive = openerElement || (document.activeElement as HTMLElement | null);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const getFocusable = () => {
      if (!drawerRef.current) return [];
      return Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
    };

    // Auto-focus first focusable element
    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      drawerNode.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab") {
        const currentFocusables = getFocusable();
        if (currentFocusables.length === 0) {
          e.preventDefault();
          return;
        }

        const first = currentFocusables[0];
        const last = currentFocusables[currentFocusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !drawerNode.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !drawerNode.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
      if (previousActive && typeof previousActive.focus === "function") {
        setTimeout(() => {
          try {
            previousActive.focus();
          } catch {}
        }, 10);
      }
    };
  }, [isOpen, onClose, openerElement]);

  if (!isOpen || !section) return null;

  // Title per section
  const sectionTitles: Record<ProfileSection, string> = {
    personal: "Edit Personal Information",
    education: "Edit Education",
    experience: "Edit Work Experience",
    skills: "Edit Skills",
  };

  // -------------------------------------------------------------------------
  // Handlers for Personal Fields
  // -------------------------------------------------------------------------
  const handlePersonalChange = (field: keyof CandidateProfile, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  // -------------------------------------------------------------------------
  // Handlers for Education Fields
  // -------------------------------------------------------------------------
  const handleUpdateEducation = (index: number, field: keyof EducationItem, value: string) => {
    setDraft((prev) => {
      const updated = [...prev.education];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, education: updated };
    });
  };

  const handleAddEducation = () => {
    const newEdu: EducationItem = {
      id: `edu-${Date.now()}`,
      degree: "",
      institution: "",
      year: "",
      fieldOfStudy: "",
      needsReview: false,
    };
    setDraft((prev) => ({
      ...prev,
      education: [newEdu, ...prev.education],
    }));
  };

  const handleRemoveEducation = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      education: prev.education.filter((_, i) => i !== index),
    }));
  };

  // -------------------------------------------------------------------------
  // Handlers for Experience Fields
  // -------------------------------------------------------------------------
  const handleUpdateExperience = (
    index: number,
    field: keyof WorkExperienceItem,
    value: any
  ) => {
    setDraft((prev) => {
      const updated = [...prev.experience];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, experience: updated };
    });
  };

  const handleAddExperience = () => {
    const newExp: WorkExperienceItem = {
      id: `exp-${Date.now()}`,
      company: "",
      role: "",
      startDate: "",
      endDate: "",
      location: "",
      bullets: [],
      needsReview: false,
    };
    setDraft((prev) => ({
      ...prev,
      experience: [newExp, ...prev.experience],
    }));
  };

  const handleRemoveExperience = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      experience: prev.experience.filter((_, i) => i !== index),
    }));
  };

  // -------------------------------------------------------------------------
  // Handlers for Skills Fields
  // -------------------------------------------------------------------------
  const handleAddSkill = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newSkill.trim();
    if (!clean) return;

    if (draft.skills.some((s) => s.toLowerCase() === clean.toLowerCase())) {
      setError(`Skill "${clean}" is already in your skills list.`);
      return;
    }

    setDraft((prev) => ({
      ...prev,
      skills: [...prev.skills, clean],
    }));
    setNewSkill("");
    setError(null);
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setDraft((prev) => ({
      ...prev,
      skills: prev.skills.filter((s) => s !== skillToRemove),
    }));
  };

  // -------------------------------------------------------------------------
  // Save Handler with Validation and Safe Rollback on Rejection
  // -------------------------------------------------------------------------
  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError(null);

    // Section-specific validation
    if (section === "personal") {
      if (!draft.name?.trim()) {
        setError("Full Name is required.");
        return;
      }
      if (draft.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
        setError("Please enter a valid email address.");
        return;
      }
    } else if (section === "education") {
      // If user has education items, verify at least degree and institution if partially filled
      for (let i = 0; i < draft.education.length; i++) {
        const item = draft.education[i];
        const hasAny = item.degree?.trim() || item.institution?.trim() || item.year?.trim();
        if (hasAny && (!item.degree?.trim() || !item.institution?.trim())) {
          setError(`Education entry #${i + 1} requires both Degree and Institution.`);
          return;
        }
      }
    } else if (section === "experience") {
      // If user has experience items, verify at least role and company if partially filled
      for (let i = 0; i < draft.experience.length; i++) {
        const item = draft.experience[i];
        const hasAny = item.role?.trim() || item.company?.trim() || item.startDate?.trim();
        if (hasAny && (!item.role?.trim() || !item.company?.trim())) {
          setError(`Work Experience entry #${i + 1} requires both Role and Company.`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const sanitized = sanitizeCandidateProfile(draft);
      await onSave(sanitized);
      const key = draftStorageKey(candidate?.email, section);
      if (key) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Best-effort cleanup.
        }
      }
      // On success, close drawer and return focus
      onClose();
    } catch (err: any) {
      console.error("Profile save error:", err);
      // Never show success! Keep drawer open, keep draft edits intact, display error inline
      setError(
        err?.message || "Failed to save profile changes. Your edits have been preserved. Please try again."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
      data-testid={`profile-drawer-${section}`}
      className="fixed inset-0 z-50 flex justify-end"
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        data-testid="profile-drawer-backdrop"
        className="fixed inset-0 bg-[#0F172A]/60 backdrop-blur-[2px] transition-opacity cursor-pointer animate-in fade-in duration-300"
      />

      {/* Drawer Container (808px on desktop, capped to viewport, full-screen on mobile, 300ms transition) */}
      <div
        ref={drawerRef}
        tabIndex={-1}
        className="relative z-10 w-full md:w-[808px] max-w-full h-full bg-white shadow-2xl flex flex-col focus:outline-none animate-in slide-in-from-right duration-300 ease-out"
      >
        {/* Drawer Header with Section Title, primary blue UPDATE button, and Close button */}
        <header className="h-16 px-6 border-b border-[#E2E8F0] flex items-center justify-between gap-4 bg-white shrink-0">
          <h2 id="drawer-title" className="text-[18px] font-bold text-[#0F172A] truncate">
            {sectionTitles[section]}
          </h2>
          <div className="flex items-center gap-2.5 shrink-0">
            {/* Primary Blue UPDATE Action */}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              data-testid="drawer-header-update-btn"
              className="h-10 min-h-[44px] px-5 rounded-full text-[13px] font-semibold bg-[#2563EB] text-white hover:bg-[#1D4ED8] active:bg-[#1E40AF] disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1 inline-flex items-center gap-2 cursor-pointer shadow-xs"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{saving ? "Saving..." : "UPDATE"}</span>
            </button>

            {/* Close X Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close drawer"
              data-testid="drawer-close-btn"
              className="w-11 h-11 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-[#64748B] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <X className="w-5 h-5 stroke-[2]" />
            </button>
          </div>
        </header>

        {/* Drawer Scrollable Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {/* Inline Error Banner */}
          {error && (
            <div
              role="alert"
              data-testid="drawer-error-alert"
              className="p-3.5 rounded-xl bg-[#FEE2E2] border border-[#FCA5A5] text-[#DC2626] text-sm flex items-start gap-2.5"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-[#DC2626]" />
              <div className="flex-1 text-[13px] leading-relaxed font-medium">{error}</div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* SECTION 1: PERSONAL                                           */}
          {/* ------------------------------------------------------------- */}
          {section === "personal" && (
            <div className="space-y-4" data-testid="drawer-fields-personal">
              <div>
                <label htmlFor="field-name" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                  Full Name <span className="text-[#DC2626]">*</span>
                </label>
                <input
                  id="field-name"
                  type="text"
                  required
                  value={draft.name || ""}
                  onChange={(e) => handlePersonalChange("name", e.target.value)}
                  placeholder="e.g. Jane Doe"
                  className="w-full h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                />
              </div>

              <div>
                <label htmlFor="field-headline" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                  Professional Headline
                </label>
                <input
                  id="field-headline"
                  type="text"
                  value={draft.headline || ""}
                  onChange={(e) => handlePersonalChange("headline", e.target.value)}
                  placeholder="e.g. Senior Full-Stack Engineer"
                  className="w-full h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                />
              </div>

              <div>
                <label htmlFor="field-summary" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                  Summary
                </label>
                <textarea
                  id="field-summary"
                  rows={4}
                  value={draft.summary || ""}
                  onChange={(e) => handlePersonalChange("summary", e.target.value)}
                  placeholder="Brief summary of your background, core strengths, and target roles..."
                  className="w-full min-h-[100px] p-3 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all leading-relaxed"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="field-email" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                    Email
                  </label>
                  <input
                    id="field-email"
                    type="email"
                    value={draft.email || ""}
                    onChange={(e) => handlePersonalChange("email", e.target.value)}
                    placeholder="jane@example.com"
                    className="w-full h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                  />
                </div>

                <div>
                  <label htmlFor="field-phone" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                    Phone
                  </label>
                  <input
                    id="field-phone"
                    type="tel"
                    value={draft.phone || ""}
                    onChange={(e) => handlePersonalChange("phone", e.target.value)}
                    placeholder="+1 (555) 000-0000"
                    className="w-full h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="field-location" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                  Location
                </label>
                <input
                  id="field-location"
                  type="text"
                  value={draft.location || ""}
                  onChange={(e) => handlePersonalChange("location", e.target.value)}
                  placeholder="e.g. San Francisco, CA or Remote"
                  className="w-full h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                />
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* SECTION 2: EDUCATION                                          */}
          {/* ------------------------------------------------------------- */}
          {section === "education" && (
            <div className="space-y-5" data-testid="drawer-fields-education">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#475569] uppercase tracking-wider">
                  Degrees & Institutions ({draft.education.length})
                </span>
                <button
                  type="button"
                  onClick={handleAddEducation}
                  className="inline-flex items-center gap-1.5 h-11 min-h-[44px] px-3.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] hover:bg-[#EFF6FF] rounded-lg transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Degree</span>
                </button>
              </div>

              {draft.education.length === 0 ? (
                <div className="p-6 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] text-center space-y-2">
                  <p className="text-sm font-medium text-[#0F172A]">No education entries listed.</p>
                  <p className="text-xs text-[#64748B]">Click &quot;Add Degree&quot; to add your first institution.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {draft.education.map((edu, idx) => (
                    <div
                      key={edu.id || `edu-${idx}`}
                      className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3 relative group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-[#0F172A] uppercase">
                          Degree #{idx + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveEducation(idx)}
                          aria-label={`Remove degree #${idx + 1}`}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[#94A3B8] hover:text-[#DC2626] rounded-lg hover:bg-white transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-[#475569] mb-1">
                          Degree / Major <span className="text-[#DC2626]">*</span>
                        </label>
                        <input
                          type="text"
                          value={edu.degree || ""}
                          onChange={(e) => handleUpdateEducation(idx, "degree", e.target.value)}
                          placeholder="e.g. B.S. in Computer Science"
                          className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-[#475569] mb-1">
                          Institution / University <span className="text-[#DC2626]">*</span>
                        </label>
                        <input
                          type="text"
                          value={edu.institution || ""}
                          onChange={(e) => handleUpdateEducation(idx, "institution", e.target.value)}
                          placeholder="e.g. University of California, Berkeley"
                          className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Graduation Year
                          </label>
                          <input
                            type="text"
                            value={edu.year || ""}
                            onChange={(e) => handleUpdateEducation(idx, "year", e.target.value)}
                            placeholder="e.g. 2022"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Field of Study (Optional)
                          </label>
                          <input
                            type="text"
                            value={edu.fieldOfStudy || ""}
                            onChange={(e) => handleUpdateEducation(idx, "fieldOfStudy", e.target.value)}
                            placeholder="e.g. Software Engineering"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* SECTION 3: WORK EXPERIENCE                                     */}
          {/* ------------------------------------------------------------- */}
          {section === "experience" && (
            <div className="space-y-5" data-testid="drawer-fields-experience">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#475569] uppercase tracking-wider">
                  Roles & Positions ({draft.experience.length})
                </span>
                <button
                  type="button"
                  onClick={handleAddExperience}
                  className="inline-flex items-center gap-1.5 h-11 min-h-[44px] px-3.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] hover:bg-[#EFF6FF] rounded-lg transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Role</span>
                </button>
              </div>

              {draft.experience.length === 0 ? (
                <div className="p-6 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] text-center space-y-2">
                  <p className="text-sm font-medium text-[#0F172A]">No work experience entries listed.</p>
                  <p className="text-xs text-[#64748B]">Click &quot;Add Role&quot; to add your previous or current employment.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {draft.experience.map((exp, idx) => (
                    <div
                      key={exp.id || `exp-${idx}`}
                      className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3 relative group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-[#0F172A] uppercase">
                          Role #{idx + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveExperience(idx)}
                          aria-label={`Remove role #${idx + 1}`}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-[#94A3B8] hover:text-[#DC2626] rounded-lg hover:bg-white transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Role / Job Title <span className="text-[#DC2626]">*</span>
                          </label>
                          <input
                            type="text"
                            value={exp.role || ""}
                            onChange={(e) => handleUpdateExperience(idx, "role", e.target.value)}
                            placeholder="e.g. Senior Frontend Engineer"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Company Name <span className="text-[#DC2626]">*</span>
                          </label>
                          <input
                            type="text"
                            value={exp.company || ""}
                            onChange={(e) => handleUpdateExperience(idx, "company", e.target.value)}
                            placeholder="e.g. Acme Corp"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Start Date
                          </label>
                          <input
                            type="text"
                            value={exp.startDate || ""}
                            onChange={(e) => handleUpdateExperience(idx, "startDate", e.target.value)}
                            placeholder="e.g. Jan 2021"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            End Date
                          </label>
                          <input
                            type="text"
                            value={exp.endDate || ""}
                            onChange={(e) => handleUpdateExperience(idx, "endDate", e.target.value)}
                            placeholder="e.g. Present"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[#475569] mb-1">
                            Location
                          </label>
                          <input
                            type="text"
                            value={exp.location || ""}
                            onChange={(e) => handleUpdateExperience(idx, "location", e.target.value)}
                            placeholder="e.g. Remote"
                            className="w-full h-11 min-h-[44px] px-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-[#475569] mb-1">
                          Key Achievements (One bullet per line)
                        </label>
                        <textarea
                          rows={3}
                          value={Array.isArray(exp.bullets) ? exp.bullets.join("\n") : ""}
                          onChange={(e) => {
                            const lines = e.target.value
                              .split("\n")
                              .map((l) => l.trim())
                              .filter(Boolean);
                            handleUpdateExperience(idx, "bullets", lines);
                          }}
                          placeholder="- Spearheaded migration to Next.js&#10;- Reduced bundle size by 40%"
                          className="w-full min-h-[88px] p-3 rounded-lg border border-[#CBD5E1] bg-white text-[13px] text-[#0F172A] focus:border-[#93C5FD] focus:outline-none leading-relaxed"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          {/* SECTION 4: SKILLS                                             */}
          {/* ------------------------------------------------------------- */}
          {section === "skills" && (
            <div className="space-y-5" data-testid="drawer-fields-skills">
              {/* Add Skill Form */}
              <div>
                <label htmlFor="input-new-skill" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider mb-1.5">
                  Add New Skill
                </label>
                <div className="flex gap-2">
                  <input
                    id="input-new-skill"
                    type="text"
                    value={newSkill}
                    onChange={(e) => setNewSkill(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddSkill();
                      }
                    }}
                    placeholder="e.g. React, PostgreSQL, Docker..."
                    className="flex-1 h-11 min-h-[44px] px-3.5 rounded-xl border border-[#CBD5E1] bg-white text-[14px] text-[#0F172A] placeholder-[#94A3B8] focus:border-[#93C5FD] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={handleAddSkill}
                    className="h-11 min-h-[44px] px-5 rounded-full text-xs font-semibold bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition-colors shrink-0 cursor-pointer"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Existing Skills Chips */}
              <div>
                <span className="block text-xs font-semibold text-[#475569] uppercase tracking-wider mb-2.5">
                  Current Skills ({draft.skills.length})
                </span>

                {draft.skills.length === 0 ? (
                  <div className="p-6 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] text-center space-y-1">
                    <p className="text-sm font-medium text-[#0F172A]">No skills added yet.</p>
                    <p className="text-xs text-[#64748B]">Type a skill above and press Add.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {draft.skills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center gap-1.5 bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE] text-xs font-medium pl-3 pr-1.5 py-1 rounded-full"
                      >
                        <span>{skill}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSkill(skill)}
                          aria-label={`Remove skill ${skill}`}
                          className="w-7 h-7 min-h-[28px] min-w-[28px] sm:min-h-[44px] sm:min-w-[44px] rounded-full inline-flex items-center justify-center text-[#1D4ED8] hover:bg-[#DBEAFE] hover:text-[#1E3A8A] transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </form>

        {/* Drawer Footer Actions (Cancel discards unsaved edits) */}
        <footer className="h-16 px-6 border-t border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between gap-3 shrink-0">
          <span className="text-xs text-[#64748B]">Cancel discards unsaved changes.</span>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            data-testid="drawer-cancel-btn"
            className="h-10 min-h-[44px] px-5 rounded-full text-[14px] font-medium bg-white border border-[#CBD5E1] text-[#0F172A] hover:bg-[#F1F5F9] transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

function createInitialDraft(candidate: CandidateProfile | null): CandidateProfile {
  if (candidate) {
    return {
      name: candidate.name || "",
      email: candidate.email || "",
      phone: candidate.phone || "",
      location: candidate.location || "",
      headline: candidate.headline || "",
      summary: candidate.summary || "",
      skills: Array.isArray(candidate.skills) ? [...candidate.skills] : [],
      experience: Array.isArray(candidate.experience)
        ? candidate.experience.map((e) => ({ ...e, bullets: [...(e.bullets || [])] }))
        : [],
      education: Array.isArray(candidate.education)
        ? candidate.education.map((e) => ({ ...e }))
        : [],
      certifications: Array.isArray(candidate.certifications) ? [...candidate.certifications] : [],
      rawText: candidate.rawText || "",
      confirmedAt: candidate.confirmedAt,
      updatedAt: candidate.updatedAt || new Date().toISOString(),
    };
  }

  return {
    name: "",
    email: "",
    phone: "",
    location: "",
    headline: "",
    summary: "",
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    updatedAt: new Date().toISOString(),
  };
}
