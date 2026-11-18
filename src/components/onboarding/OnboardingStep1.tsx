"use client";

import React, { useState } from "react";
import { Plus, X, Globe, Check, HelpCircle } from "lucide-react";
import BrandIcon from "@/components/BrandIcon";
import JobFunctionBottomSheet from "./JobFunctionBottomSheet";
import CountryPickerModal from "./CountryPickerModal";
import { JOB_TYPE_OPTIONS, WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";

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
}: OnboardingStep1Props) {
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);
  const [isCountryPickerOpen, setIsCountryPickerOpen] = useState(false);
  const [showRemoteHelp, setShowRemoteHelp] = useState(false);
  const [showWorkAuthHelp, setShowWorkAuthHelp] = useState(false);

  // Form is valid only when all 4 required fields are filled
  const isFormValid =
    roles.length > 0 &&
    employmentTypes.length > 0 &&
    Boolean(country && country.trim().length > 0) &&
    Boolean(workAuth && workAuth.trim().length > 0);

  return (
    <div className="w-full max-w-lg md:max-w-2xl lg:max-w-4xl mx-auto flex flex-col pb-28 md:pb-12 pt-4 md:pt-8 px-4 sm:px-6 md:px-8">
      {/* Copilot Greeting Header */}
      <div className="flex items-start gap-3 md:gap-4 mb-6 md:mb-8">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 md:w-12 md:h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
            <BrandIcon className="w-7 h-7 md:w-8 md:h-8" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"
            title="Copilot Online"
          />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm md:text-base font-bold text-zinc-900 dark:text-zinc-100">
              CareerMonke Copilot
            </span>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
              {isEditMode ? "Edit Mode" : "AI"}
            </span>
          </div>
          <div className="p-3.5 md:p-4 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm md:text-[15px] text-zinc-800 dark:text-zinc-200 leading-relaxed">
            {isEditMode
              ? "Update your job preferences below to tune your recommended jobs feed."
              : "Hi, I'm your CareerMonke Copilot. What type of role are you looking for?"}
          </div>
        </div>
      </div>

      {/* Main Form Card */}
      <div className="bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 md:p-8 shadow-sm md:shadow-md space-y-6 md:space-y-7">
        {/* 1. Job Function (Required) */}
        <div>
          <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            <span className="text-emerald-600 dark:text-emerald-400 font-bold mr-1">*</span>
            Job Function{" "}
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
              (select from categories for best results)
            </span>
          </label>

          {roles.length === 0 ? (
            <button
              type="button"
              onClick={() => setIsBottomSheetOpen(true)}
              className="w-full py-3.5 md:py-4 px-4 border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 bg-zinc-50/50 dark:bg-zinc-800/40 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 transition group"
            >
              <Plus className="w-4 h-4 text-zinc-500 group-hover:text-emerald-600 transition" />
              <span>Add</span>
            </button>
          ) : (
            <div className="space-y-2.5">
              <div className="flex flex-wrap gap-2 md:gap-2.5">
                {roles.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full text-xs md:text-sm font-semibold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200 border border-emerald-500/30"
                  >
                    <span>{r}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveRole(r)}
                      aria-label={`Remove ${r}`}
                      className="p-0.5 text-emerald-600 hover:text-emerald-900 dark:hover:text-emerald-100 rounded-full hover:bg-emerald-200/50 dark:hover:bg-emerald-800/50 transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setIsBottomSheetOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs md:text-sm font-semibold text-emerald-600 dark:text-emerald-400 hover:underline pt-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add more roles</span>
              </button>
            </div>
          )}
        </div>

        {/* 2. Job Type (Required) */}
        <div>
          <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2.5">
            <span className="text-emerald-600 dark:text-emerald-400 font-bold mr-1">*</span>
            Job Type
          </label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 md:gap-3">
            {JOB_TYPE_OPTIONS.map((jt) => {
              const isChecked = employmentTypes.includes(jt.id);
              return (
                <button
                  key={jt.id}
                  type="button"
                  onClick={() => onToggleEmploymentType(jt.id)}
                  className={`flex items-center gap-2.5 md:gap-3 p-3 md:p-3.5 rounded-2xl border text-left text-xs sm:text-sm font-semibold transition ${
                    isChecked
                      ? "bg-emerald-500/10 border-emerald-500 text-emerald-900 dark:text-emerald-100 shadow-sm"
                      : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0 ${
                      isChecked
                        ? "bg-emerald-600 border-emerald-600 text-white"
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 items-start">
          {/* Location / Country */}
          <div>
            <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
              <span className="text-emerald-600 dark:text-emerald-400 font-bold mr-1">*</span>
              Country / Location
            </label>
            <button
              type="button"
              onClick={() => setIsCountryPickerOpen(true)}
              className="w-full h-[50px] md:h-[52px] flex items-center justify-between p-3.5 md:p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-left text-sm font-medium hover:border-emerald-500 dark:hover:border-emerald-500 transition"
            >
              <div className="flex items-center gap-2.5 truncate">
                <Globe className="w-4 h-4 text-emerald-600 flex-shrink-0" />
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
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex-shrink-0 ml-2">
                {country ? "Change" : "Select"}
              </span>
            </button>
          </div>

          {/* Open to Remote */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                Remote Preference
              </span>
              <div
                className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRemoteHelp(!showRemoteHelp);
                }}
                aria-label="Info about remote preference"
              >
                <HelpCircle className="w-4 h-4" />
              </div>
            </div>

            <button
              type="button"
              onClick={onToggleOpenToRemote}
              className={`w-full h-[50px] md:h-[52px] flex items-center justify-between p-3.5 md:p-4 rounded-2xl border text-left text-sm font-semibold transition ${
                openToRemote
                  ? "bg-emerald-500/10 border-emerald-500 text-emerald-900 dark:text-emerald-100"
                  : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors flex-shrink-0 ${
                    openToRemote
                      ? "bg-emerald-600 border-emerald-600 text-white"
                      : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                  }`}
                >
                  {openToRemote && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </div>
                <span>Open to Remote</span>
              </div>
            </button>

            {showRemoteHelp && (
              <p className="mt-1.5 px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50">
                When checked, your recommended jobs will include remote roles alongside your preferred location.
              </p>
            )}
          </div>
        </div>

        {/* 5. Work Authorization / Sponsorship (Required, Never default to Authorized) */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <label className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
              <span className="text-emerald-600 dark:text-emerald-400 font-bold mr-1">*</span>
              Work Authorization
            </label>
            <div
              className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full cursor-pointer"
              onClick={() => setShowWorkAuthHelp(!showWorkAuthHelp)}
              aria-label="Info about work authorization"
            >
              <HelpCircle className="w-4 h-4" />
            </div>
          </div>

          {showWorkAuthHelp && (
            <p className="mb-2.5 px-2 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50">
              Indicate whether you require visa sponsorship (e.g. H1B) or are legally authorized to work in your target country.
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 md:gap-3">
            {WORK_AUTH_OPTIONS.map((opt) => {
              const isSelected = workAuth === opt.label || workAuth === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onSelectWorkAuth(opt.label)}
                  className={`w-full h-full flex items-center gap-3 p-3.5 md:p-4 rounded-2xl border text-left text-xs sm:text-sm font-semibold transition ${
                    isSelected
                      ? "bg-emerald-500/10 border-emerald-500 text-emerald-900 dark:text-emerald-100 shadow-sm"
                      : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors flex-shrink-0 ${
                      isSelected
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    }`}
                  >
                    {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Progress Indicator and Next Button (Fixed on mobile, in-flow on desktop) */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4 md:static md:bg-transparent md:border-0 md:p-0 md:mt-8 md:backdrop-blur-none">
        <div className="max-w-lg md:max-w-none mx-auto space-y-3 md:space-y-4">
          {/* Progress bar (Step 1 of 2 -> 50%) */}
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 md:h-2 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-300"
              style={{ width: "50%" }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-xs md:text-sm font-semibold text-zinc-400 dark:text-zinc-500">
              Step 1 of 2
            </span>
            <button
              type="button"
              disabled={!isFormValid}
              onClick={onNext}
              className="px-8 md:px-10 py-3 md:py-3.5 rounded-full text-sm md:text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition flex items-center justify-center gap-2"
            >
              <span>Next</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Sheet Modal for Job Function selection */}
      <JobFunctionBottomSheet
        isOpen={isBottomSheetOpen}
        onClose={() => setIsBottomSheetOpen(false)}
        selectedRoles={roles}
        onToggleRole={onToggleRole}
      />

      {/* Searchable Country Picker Modal */}
      <CountryPickerModal
        isOpen={isCountryPickerOpen}
        onClose={() => setIsCountryPickerOpen(false)}
        selectedCountry={country}
        onSelectCountry={(c) => onSelectCountry(c)}
      />
    </div>
  );
}
