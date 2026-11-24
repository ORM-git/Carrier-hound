"use client";

import React, { useState } from "react";
import { Plus, X, Globe, Check, HelpCircle, LogOut } from "lucide-react";
import BrandIcon from "@/components/BrandIcon";
import JobFunctionBottomSheet from "./JobFunctionBottomSheet";
import CountryPickerModal from "./CountryPickerModal";
import { JOB_TYPE_OPTIONS, WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";
import { isWorkAuthComplete, parseWorkAuth, toggleWorkAuth, type WorkAuthId } from "@/lib/onboarding/workAuth";

const HELP_BUTTON_CLASS =
  "p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0082FF] lg:focus-visible:ring-brand-500 transition-colors";

interface OnboardingStep1Props {
  roles: string[];
  onToggleRole: (role: string) => void;
  onRemoveRole: (role: string) => void;
  employmentTypes: string[];
  onToggleEmploymentType: (type: string) => void;
  country: string;
  onSelectCountry: (country: { code: string; name: string }) => void;
  openToRemote: boolean;
  onToggleOpenToRemote: () => void;
  workAuth: string;
  onSelectWorkAuth: (auth: string) => void;
  onNext: () => void;
  isEditMode?: boolean;
  onLogout?: () => void;
}

export default function OnboardingStep1({
  roles,
  onToggleRole,
  onRemoveRole,
  employmentTypes,
  onToggleEmploymentType,
  country,
  onSelectCountry,
  openToRemote,
  onToggleOpenToRemote,
  workAuth,
  onSelectWorkAuth,
  onNext,
  isEditMode = false,
  onLogout,
}: OnboardingStep1Props) {
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);
  const [isCountryPickerOpen, setIsCountryPickerOpen] = useState(false);
  const [showRemoteHelp, setShowRemoteHelp] = useState(false);
  const [showWorkAuthHelp, setShowWorkAuthHelp] = useState(false);

  // Tracks whichever trigger (mobile/tablet tree or desktop tree) was actually
  // clicked, so focus returns to the right one regardless of viewport.
  const [activeJobTrigger, setActiveJobTrigger] = useState<HTMLElement | null>(null);
  const [activeCountryTrigger, setActiveCountryTrigger] = useState<HTMLElement | null>(null);

  // Form is valid only when all 4 required fields are filled
  const isFormValid =
    roles.length > 0 &&
    employmentTypes.length > 0 &&
    Boolean(country && country.trim().length > 0) &&
    isWorkAuthComplete(workAuth);
  const selectedWorkAuth = parseWorkAuth(workAuth) ?? [];

  // Rendered twice (mobile tree + desktop tree); the hidden copy is display:none so only one is focusable
  const remoteHelpButton = (extraClass = "") => (
    <button
      type="button"
      className={`${HELP_BUTTON_CLASS} ${extraClass}`}
      onClick={(e) => {
        e.stopPropagation();
        setShowRemoteHelp((prev) => !prev);
      }}
      aria-label="Info about remote preference"
      aria-expanded={showRemoteHelp}
      aria-controls="remote-help"
    >
      <HelpCircle className="w-4 h-4" />
    </button>
  );

  return (
    <>
      {/* ============================================================
          MOBILE / TABLET (<1024px): main-branch markup, unchanged.
          ============================================================ */}
      <div className="lg:hidden w-full max-w-lg md:max-w-2xl mx-auto flex flex-col pb-[max(7rem,5em)] md:pb-12 pt-4 md:pt-8 px-4 sm:px-6 md:px-8">
        {/* Step instruction (neutral copy; the former assistant persona header was removed by owner decision) */}
        <p className="mb-3 md:mb-8 text-base md:text-lg font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
          {isEditMode ? (
            <>
              <span className="inline-block align-middle mr-2 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-[#E6F2FF] text-[#0020B0]">
                Edit mode
              </span>
              Update your job preferences.
            </>
          ) : (
            "What type of role are you looking for?"
          )}
        </p>

        {/* Main Form Card */}
        <div className="bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-3.5 sm:p-6 md:p-8 shadow-sm md:shadow-md space-y-3 md:space-y-7">
          {/* 1. Job role (Required) */}
          <div>
            <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
              <span className="text-[#0020B0] dark:text-brand-400 font-bold mr-1">*</span>
              Job role{" "}
              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                (select from categories for best results)
              </span>
            </label>

            {roles.length === 0 ? (
              <button
                type="button"
                onClick={(e) => {
                  setActiveJobTrigger(e.currentTarget);
                  setIsBottomSheetOpen(true);
                }}
                className="w-full min-h-[44px] py-2.5 md:py-4 px-4 border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-[#0082FF] dark:hover:border-brand-500 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 bg-zinc-50/50 dark:bg-zinc-800/40 hover:bg-[#E6F2FF]/50 dark:hover:bg-brand-900/20 transition group"
              >
                <Plus className="w-4 h-4 text-zinc-500 group-hover:text-[#0020B0] transition" />
                <span>Add</span>
              </button>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-1.5 md:gap-2.5">
                  {roles.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 md:py-1.5 rounded-full text-xs md:text-sm font-semibold bg-[#E6F2FF] dark:bg-brand-900/50 text-[#0020B0] dark:text-brand-200 border border-[#0082FF]/30"
                    >
                      <span>{r}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveRole(r)}
                        aria-label={`Remove ${r}`}
                        className="p-0.5 text-[#0020B0] hover:text-[#0020B0] dark:hover:text-brand-100 rounded-full hover:bg-[#CCE6FF]/50 dark:hover:bg-brand-800/50 transition"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={(e) => {
                      setActiveJobTrigger(e.currentTarget);
                      setIsBottomSheetOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 min-h-[32px] px-1 text-xs md:text-sm font-semibold text-[#0020B0] dark:text-brand-400 hover:underline"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add more roles</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 2. Job Type (Required) */}
          <div>
            <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2.5">
              <span className="text-[#0020B0] dark:text-brand-400 font-bold mr-1">*</span>
              Job Type
            </label>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
              {JOB_TYPE_OPTIONS.map((jt) => {
                const isChecked = employmentTypes.includes(jt.id) || employmentTypes.includes(jt.label);
                return (
                  <button
                    key={jt.id}
                    type="button"
                    aria-pressed={isChecked}
                    onClick={() => onToggleEmploymentType(jt.id)}
                    className={`flex items-center gap-3 min-h-[44px] px-3 py-2 md:p-3.5 rounded-2xl border text-left text-sm font-semibold transition ${
                      isChecked
                        ? "bg-[#E6F2FF] border-[#0082FF] text-[#0020B0] dark:text-brand-100 shadow-sm"
                        : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors md:flex-shrink-0 ${
                        isChecked
                          ? "bg-[#0082FF] border-[#0082FF] text-white"
                          : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      }`}
                    >
                      {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                    <span>{jt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3 & 4. Location & Remote (Two-column layout on desktop) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6 items-start">
            {/* Location / Country */}
            <div>
              <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                <span className="text-[#0020B0] dark:text-brand-400 font-bold mr-1">*</span>
                Country / Location
              </label>
              <button
                type="button"
                onClick={(e) => {
                  setActiveCountryTrigger(e.currentTarget);
                  setIsCountryPickerOpen(true);
                }}
                className="w-full min-h-[44px] md:h-[52px] flex items-center justify-between px-3.5 py-2.5 md:p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-left text-sm font-medium hover:border-[#0082FF] dark:hover:border-brand-500 transition"
              >
                <div className="flex items-center gap-2.5 truncate">
                  <Globe className="w-4 h-4 text-[#0020B0] flex-shrink-0" />
                  {country ? (
                    <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">
                      {country}
                    </span>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500 truncate">
                      Select your country
                    </span>
                  )}
                </div>
                <span className="text-xs font-semibold text-[#0020B0] dark:text-brand-400 flex-shrink-0 ml-2">
                  {country ? "Change" : "Select"}
                </span>
              </button>
            </div>

            {/* Open to Remote */}
            <div>
              {/* Desktop: label row with help above the card */}
              <div className="hidden md:flex items-center justify-between mb-2">
                <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Remote Preference
                </span>
                {remoteHelpButton()}
              </div>

              {/* Card is a div so the help can be a sibling button (buttons can't nest); mobile looks as on main */}
              <div
                className={`w-full min-h-[44px] md:h-[52px] flex items-center justify-between px-3.5 py-2.5 md:p-4 rounded-2xl border text-left text-sm font-semibold transition ${
                  openToRemote
                    ? "bg-[#E6F2FF] border-[#0082FF] text-[#0020B0] dark:text-brand-100"
                    : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {/* Negative margin stretches the click target over the card padding */}
                <button
                  type="button"
                  onClick={onToggleOpenToRemote}
                  className="flex-1 flex items-center gap-3 text-left -my-2.5 -ml-3.5 py-2.5 pl-3.5 md:-my-4 md:-ml-4 md:py-4 md:pl-4 rounded-l-2xl"
                >
                  <div
                    className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors md:flex-shrink-0 ${
                      openToRemote
                        ? "bg-[#0082FF] border-[#0082FF] text-white"
                        : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    }`}
                  >
                    {openToRemote && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                  </div>
                  <span>Open to Remote</span>
                </button>
                {remoteHelpButton("md:hidden")}
              </div>

              {showRemoteHelp && (
                <p id="remote-help" className="mt-1.5 px-3 md:px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50">
                  When checked, your recommended jobs will include remote roles alongside your preferred location.
                </p>
              )}
            </div>
          </div>

          {/* 5. Work Authorization / Sponsorship (Required, Never default to Authorized) */}
          <div>
            <div className="flex items-center justify-between mb-1.5 md:mb-2.5">
              <label className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                <span className="text-[#0020B0] dark:text-brand-400 font-bold mr-1">*</span>
                Work Authorization
              </label>
              <button
                type="button"
                className={HELP_BUTTON_CLASS}
                onClick={() => setShowWorkAuthHelp(!showWorkAuthHelp)}
                aria-label="Info about work authorization"
                aria-expanded={showWorkAuthHelp}
                aria-controls="work-auth-help"
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            </div>

            {showWorkAuthHelp && (
              <p id="work-auth-help" className="mb-2.5 px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50">
                Choose what applies to you in the country you selected. You can pick both sponsorship and another permit; the first option stands alone.
              </p>
            )}

            <div className="space-y-1.5 md:space-y-0 md:grid md:grid-cols-3 md:gap-3">
              {WORK_AUTH_OPTIONS.map((opt) => {
                const isSelected = selectedWorkAuth.includes(opt.id as WorkAuthId);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectWorkAuth(toggleWorkAuth(workAuth, opt.id as WorkAuthId))}
                    className={`w-full min-h-[44px] md:h-full flex items-center gap-2.5 px-3 py-2 md:gap-3 md:p-4 rounded-2xl border text-left text-sm font-semibold transition ${
                      isSelected
                        ? "bg-[#E6F2FF] border-[#0082FF] text-[#0020B0] dark:text-brand-100 shadow-sm"
                        : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${
                        isSelected
                          ? "bg-[#0082FF] border-[#0082FF] text-white"
                          : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      }`}
                    >
                      {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                    <span className="text-xs sm:text-sm">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Progress Indicator and Next Button (Fixed on mobile, in-flow on desktop) */}
        <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:static md:bg-transparent md:border-0 md:p-0 md:mt-8 md:backdrop-blur-none">
          <div className="max-w-lg md:max-w-none mx-auto space-y-2 md:space-y-4">
            {/* Progress bar (Step 1 of 2 -> 50%) */}
            <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 md:h-2 rounded-full overflow-hidden">
              <div
                className="bg-[#0082FF] h-full rounded-full transition-all duration-300"
                style={{ width: "50%" }}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-xs md:text-sm font-semibold text-zinc-400 dark:text-zinc-500">
                Step 1 of 2
              </span>
              <button
                type="button"
                data-testid="btn-onboarding-step1-next-mobile"
                disabled={!isFormValid}
                onClick={onNext}
                className="min-h-[44px] px-8 md:px-10 py-2.5 md:py-3.5 rounded-full text-sm md:text-base font-bold text-[#0F172A] bg-[#0082FF] hover:bg-[#0039F5] hover:text-white active:bg-[#0039F5] active:text-white disabled:opacity-40 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition flex items-center justify-center gap-2"
              >
                <span>Next</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================
          DESKTOP (>=1024px): split-shell redesign.
          ============================================================ */}
      <div className="hidden lg:flex min-h-screen w-full bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        {/* 1. LEFT WELCOME PANEL (Desktop full-height sticky split shell) */}
        <aside className="w-[42%] xl:w-[40%] bg-gradient-to-br from-brand-50/90 via-brand-50/70 to-brand-100/50 dark:from-zinc-950 dark:via-brand-900/20 dark:to-zinc-900 border-r border-brand-100/80 dark:border-zinc-800/80 flex flex-col justify-between p-12 sticky top-0 h-screen flex-shrink-0">
          {/* Brand Bar */}
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-white dark:bg-zinc-800 border border-brand-500/20 shadow-xs flex items-center justify-center p-2 text-brand-600">
                <BrandIcon className="w-6 h-6" />
              </div>
              <div>
                <span className="text-base font-black tracking-tight text-zinc-900 dark:text-white">
                  Career Monke
                </span>
                <span className="block text-[11px] font-semibold text-brand-700 dark:text-brand-400">
                  {isEditMode ? "Preferences Editor" : "Job Discovery"}
                </span>
              </div>
            </div>
          </div>

          {/* Welcome Block (Non-AI CM Welcome & Reference Typography) */}
          <div className="space-y-4 max-w-md">
            {/* Reference-style speech badge treatment */}
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-white/80 dark:bg-zinc-800/80 border border-brand-200/80 dark:border-brand-800/50 shadow-xs">
              <div className="w-2 h-2 rounded-full bg-brand-500" />
              <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                Career Monke Guide
              </span>
            </div>

            <h1 className="text-3xl xl:text-4xl font-black text-zinc-900 dark:text-white tracking-tight leading-tight">
              To get started, what type of role are you looking for?
            </h1>

            <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              {isEditMode
                ? "Update your preferred job roles, employment agreements, and locations to refresh your recommendations."
                : "Tell us your target job roles, employment terms, and location preferences to receive tailored job matches."}
            </p>
          </div>

          {/* Left footer note on desktop */}
          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            Step 1 of 2 · Basic Preferences
          </div>
        </aside>

        {/* 2. RIGHT FORM PANEL */}
        <section className="flex-1 flex flex-col justify-between min-h-screen bg-white dark:bg-zinc-950 overflow-y-auto">
          <div>
            {/* Top Bar with Logout */}
            <div className="w-full flex items-center justify-between px-8 pt-6 pb-2">
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                {isEditMode ? "Edit Profile" : "Onboarding"}
              </div>
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Logout</span>
                </button>
              )}
            </div>

            {/* Main Form Fields Container */}
            <div className="max-w-xl w-full mx-auto px-8 py-6 space-y-7">
              {/* 1. Job role (Required) */}
              <div className="space-y-2">
                <div className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  <span className="text-red-500 dark:text-red-400 font-bold mr-1">*</span>
                  Job role
                  <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400 ml-1.5">
                    (select from categories for best results)
                  </span>
                </div>

                {roles.length === 0 ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      setActiveJobTrigger(e.currentTarget);
                      setIsBottomSheetOpen(true);
                    }}
                    className="w-full py-3.5 px-4 border border-zinc-200 dark:border-zinc-800 hover:border-brand-500 dark:hover:border-brand-500 rounded-2xl flex items-center justify-between text-left text-sm text-zinc-400 dark:text-zinc-500 bg-zinc-50/50 dark:bg-zinc-900/50 hover:bg-brand-50/30 transition group"
                  >
                    <span>Select your job roles</span>
                    <Plus className="w-4 h-4 text-zinc-400 group-hover:text-brand-600 transition" />
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap gap-2">
                      {roles.map((r) => (
                        <span
                          key={r}
                          className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full text-xs font-semibold bg-brand-50 dark:bg-brand-900/50 text-brand-800 dark:text-brand-200 border border-brand-500/30"
                        >
                          <span>{r}</span>
                          <button
                            type="button"
                            onClick={() => onRemoveRole(r)}
                            aria-label={`Remove ${r}`}
                            className="p-0.5 text-brand-600 hover:text-brand-900 dark:hover:text-brand-100 rounded-full hover:bg-brand-200/50 dark:hover:bg-brand-800/50 transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        setActiveJobTrigger(e.currentTarget);
                        setIsBottomSheetOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline pt-0.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add more roles</span>
                    </button>
                  </div>
                )}
              </div>

              {/* 2. Job Type (Required, 2x2 grid matching Reference 1) */}
              <div className="space-y-2.5">
                <div className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  <span className="text-red-500 dark:text-red-400 font-bold mr-1">*</span>
                  Job Type
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {JOB_TYPE_OPTIONS.map((jt) => {
                    const isChecked = employmentTypes.includes(jt.id) || employmentTypes.includes(jt.label);
                    return (
                      <button
                        key={jt.id}
                        type="button"
                        aria-pressed={isChecked}
                        onClick={() => onToggleEmploymentType(jt.id)}
                        className={`flex items-center gap-3 p-3.5 rounded-2xl border text-left text-sm font-semibold transition ${
                          isChecked
                            ? "bg-brand-500/10 border-brand-500 text-brand-900 dark:text-brand-100 shadow-xs"
                            : "bg-zinc-50/70 dark:bg-zinc-800/40 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0 ${
                            isChecked
                              ? "bg-brand-600 border-brand-600 text-white"
                              : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                          }`}
                        >
                          {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                        <span className="truncate">{jt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 3. Location & Remote (Side-by-side row matching Reference 1) */}
              <div className="space-y-2.5">
                <div className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  <span className="text-red-500 dark:text-red-400 font-bold mr-1">*</span>
                  Location
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
                  {/* Country / Location Picker button */}
                  <div className="sm:col-span-7">
                    <button
                      type="button"
                      onClick={(e) => {
                        setActiveCountryTrigger(e.currentTarget);
                        setIsCountryPickerOpen(true);
                      }}
                      className="w-full h-[50px] flex items-center justify-between p-3.5 rounded-2xl bg-zinc-50/70 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 text-left text-sm font-medium hover:border-brand-500 dark:hover:border-brand-500 transition"
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <Globe className="w-4 h-4 text-brand-600 flex-shrink-0" />
                        {country ? (
                          <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">
                            {country}
                          </span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500 truncate">
                            Select country / location
                          </span>
                        )}
                      </div>
                      <span className="text-xs font-semibold text-brand-600 dark:text-brand-400 flex-shrink-0 ml-2">
                        {country ? "Change" : "Select"}
                      </span>
                    </button>
                  </div>

                  {/* Open to Remote card */}
                  <div className="sm:col-span-5">
                    <div
                      className={`w-full h-[50px] flex items-center justify-between p-3.5 rounded-2xl border text-left text-sm font-semibold transition ${
                        openToRemote
                          ? "bg-brand-500/10 border-brand-500 text-brand-900 dark:text-brand-100"
                          : "bg-zinc-50/70 dark:bg-zinc-800/40 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={onToggleOpenToRemote}
                        className="flex-1 flex items-center gap-2.5 text-left -my-3.5 -ml-3.5 py-3.5 pl-3.5 rounded-l-2xl"
                      >
                        <div
                          className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0 ${
                            openToRemote
                              ? "bg-brand-600 border-brand-600 text-white"
                              : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                          }`}
                        >
                          {openToRemote && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                        <span className="truncate">Open to Remote</span>
                      </button>
                      {remoteHelpButton()}
                    </div>
                  </div>
                </div>

                {showRemoteHelp && (
                  <p
                    id="remote-help-desktop"
                    className="mt-1 px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50"
                  >
                    When checked, your recommended jobs will include remote roles alongside your preferred location.
                  </p>
                )}
              </div>

              {/* 4. Work Authorization (Required per prompt contract) */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <span className="text-red-500 dark:text-red-400 font-bold mr-1">*</span>
                    Work Authorization
                  </div>
                  <button
                    type="button"
                    className={HELP_BUTTON_CLASS}
                    onClick={() => setShowWorkAuthHelp(!showWorkAuthHelp)}
                    aria-label="Info about work authorization"
                    aria-expanded={showWorkAuthHelp}
                    aria-controls="work-auth-help-desktop"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </button>
                </div>

                {showWorkAuthHelp && (
                  <p
                    id="work-auth-help-desktop"
                    className="px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50"
                  >
                    Choose what applies to you in the country you selected. You can pick both sponsorship and another permit; the first option stands alone.
                  </p>
                )}

                <div className="space-y-2">
                  {WORK_AUTH_OPTIONS.map((opt) => {
                    const isSelected = selectedWorkAuth.includes(opt.id as WorkAuthId);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSelectWorkAuth(toggleWorkAuth(workAuth, opt.id as WorkAuthId))}
                        className={`w-full flex items-center gap-3 p-3.5 rounded-2xl border text-left text-sm font-semibold transition ${
                          isSelected
                            ? "bg-brand-500/10 border-brand-500 text-brand-900 dark:text-brand-100 shadow-xs"
                            : "bg-zinc-50/70 dark:bg-zinc-800/40 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${
                            isSelected
                              ? "bg-brand-600 border-brand-600 text-white"
                              : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                          }`}
                        >
                          {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                        </div>
                        <span className="text-xs sm:text-sm">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* 5. Bottom Navigation Bar with Progress & Next CTA */}
          <div className="w-full bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-100 dark:border-zinc-800 p-6 mt-6">
            <div className="max-w-xl mx-auto space-y-3">
              {/* Progress Bar (Step 1 of 2 -> 50%) */}
              <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-brand-500 h-full rounded-full transition-all duration-300"
                  style={{ width: "50%" }}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-semibold text-zinc-400 dark:text-zinc-500">
                  Step 1 of 2
                </span>
                <button
                  type="button"
                  data-testid="btn-onboarding-step1-next"
                  disabled={!isFormValid}
                  onClick={onNext}
                  className="px-10 py-3.5 rounded-full text-base font-bold text-white bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition flex items-center justify-center gap-2"
                >
                  <span>Next</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Shared modals (rendered once; focus returns to whichever tree's trigger was clicked) */}
      <JobFunctionBottomSheet
        isOpen={isBottomSheetOpen}
        onClose={() => setIsBottomSheetOpen(false)}
        selectedRoles={roles}
        onToggleRole={onToggleRole}
        openerElement={activeJobTrigger}
      />
      <CountryPickerModal
        isOpen={isCountryPickerOpen}
        onClose={() => setIsCountryPickerOpen(false)}
        selectedCountry={country}
        onSelectCountry={(c) => onSelectCountry(c)}
        openerElement={activeCountryTrigger}
      />
    </>
  );
}
