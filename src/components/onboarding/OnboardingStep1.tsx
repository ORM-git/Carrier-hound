"use client";

import React, { useState } from "react";
import { Plus, X, MapPin, Check, HelpCircle, Briefcase } from "lucide-react";
import BrandIcon from "@/components/BrandIcon";
import JobFunctionBottomSheet from "./JobFunctionBottomSheet";
import LocationPickerModal from "./LocationPickerModal";
import { JOB_TYPE_OPTIONS } from "@/data/onboardingCategories";

interface OnboardingStep1Props {
  roles: string[];
  onToggleRole: (role: string) => void;
  onRemoveRole: (role: string) => void;
  employmentTypes: string[];
  onToggleEmploymentType: (type: string) => void;
  location: string;
  onSelectLocation: (loc: string) => void;
  openToRemote: boolean;
  onToggleOpenToRemote: () => void;
  onNext: () => void;
}

export default function OnboardingStep1({
  roles,
  onToggleRole,
  onRemoveRole,
  employmentTypes,
  onToggleEmploymentType,
  location,
  onSelectLocation,
  openToRemote,
  onToggleOpenToRemote,
  onNext,
}: OnboardingStep1Props) {
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false);
  const [showRemoteHelp, setShowRemoteHelp] = useState(false);

  const isFormValid = roles.length > 0 && employmentTypes.length > 0;

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col pb-28 pt-4 px-4 sm:px-6">
      {/* Copilot Greeting Header */}
      <div className="flex items-start gap-3 mb-6">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center p-2 text-emerald-600 shadow-sm">
            <BrandIcon className="w-7 h-7" />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"
            title="Copilot Online"
          />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">CareerMonke Copilot</span>
            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">AI</span>
          </div>
          <div className="p-3.5 rounded-2xl rounded-tl-sm bg-white dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 shadow-sm text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
            Hi, I&apos;m your CareerMonke Copilot. What type of role are you looking for?
          </div>
        </div>
      </div>

      {/* Main Form Card */}
      <div className="bg-white dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 sm:p-6 shadow-sm space-y-6">
        {/* 1. Job Function (Required) */}
        <div>
          <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            <span className="text-emerald-600 dark:text-emerald-400 font-bold mr-1">*</span>
            Job Function <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">(select from categories for best results)</span>
          </label>

          {roles.length === 0 ? (
            <button
              type="button"
              onClick={() => setIsBottomSheetOpen(true)}
              className="w-full py-3.5 px-4 border-2 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 dark:hover:border-emerald-500 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 bg-zinc-50/50 dark:bg-zinc-800/40 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 transition group"
            >
              <Plus className="w-4 h-4 text-zinc-500 group-hover:text-emerald-600 transition" />
              <span>Add</span>
            </button>
          ) : (
            <div className="space-y-2.5">
              <div className="flex flex-wrap gap-2">
                {roles.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200 border border-emerald-500/30"
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
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline pt-1"
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
          <div className="grid grid-cols-2 gap-2.5">
            {JOB_TYPE_OPTIONS.map((jt) => {
              const isChecked = employmentTypes.includes(jt.id);
              return (
                <button
                  key={jt.id}
                  type="button"
                  onClick={() => onToggleEmploymentType(jt.id)}
                  className={`flex items-center gap-3 p-3 rounded-2xl border text-left text-sm font-semibold transition ${
                    isChecked
                      ? "bg-emerald-500/10 border-emerald-500 text-emerald-900 dark:text-emerald-100 shadow-sm"
                      : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/70 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors ${
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

        {/* 3. Location */}
        <div>
          <label className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            Location
          </label>
          <button
            type="button"
            onClick={() => setIsLocationPickerOpen(true)}
            className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600 transition"
          >
            <div className="flex items-center gap-2.5 truncate">
              <MapPin className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span className="truncate">{location || "Anywhere in India"}</span>
            </div>
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex-shrink-0 ml-2">
              Change
            </span>
          </button>
        </div>

        {/* 4. Open to Remote Checkbox Card */}
        <div>
          <button
            type="button"
            onClick={onToggleOpenToRemote}
            className={`w-full flex items-center justify-between p-3.5 rounded-2xl border text-left text-sm font-semibold transition ${
              openToRemote
                ? "bg-emerald-500/10 border-emerald-500 text-emerald-900 dark:text-emerald-100"
                : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-colors ${
                  openToRemote
                    ? "bg-emerald-600 border-emerald-600 text-white"
                    : "border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                }`}
              >
                {openToRemote && <Check className="w-3.5 h-3.5 stroke-[3]" />}
              </div>
              <span>Open to Remote</span>
            </div>

            <div
              className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full"
              onClick={(e) => {
                e.stopPropagation();
                setShowRemoteHelp(!showRemoteHelp);
              }}
              aria-label="Info about remote preference"
            >
              <HelpCircle className="w-4 h-4" />
            </div>
          </button>

          {showRemoteHelp && (
            <p className="mt-1.5 px-3 text-xs text-zinc-500 dark:text-zinc-400 animate-in fade-in-50">
              When checked, your recommended jobs will include remote roles alongside your preferred location.
            </p>
          )}
        </div>
      </div>

      {/* Sticky Bottom Bar with Progress Indicator and Next Button */}
      <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200/80 dark:border-zinc-800 p-4">
        <div className="max-w-lg mx-auto space-y-3">
          {/* Progress bar (Step 1 of 2 -> 50%) */}
          <div className="w-full bg-zinc-100 dark:bg-zinc-800 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all duration-300"
              style={{ width: "50%" }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
              Step 1 of 2
            </span>
            <button
              type="button"
              disabled={!isFormValid}
              onClick={onNext}
              className="px-8 py-3 rounded-full text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition flex items-center justify-center gap-2"
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

      {/* Location Picker Modal */}
      <LocationPickerModal
        isOpen={isLocationPickerOpen}
        onClose={() => setIsLocationPickerOpen(false)}
        selectedLocation={location}
        onSelectLocation={onSelectLocation}
      />
    </div>
  );
}
