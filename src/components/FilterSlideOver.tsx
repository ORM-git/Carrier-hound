"use client";

import React, { useEffect } from "react";
import { X, SlidersHorizontal, Check, RotateCcw } from "lucide-react";
import { CATEGORIES } from "@/data/categories";

interface FilterSlideOverProps {
  open: boolean;
  onClose: () => void;
  selectedCategories: string[];
  onToggleCategory: (slug: string) => void;
  countryFilter: string;
  onChangeCountry: (country: string) => void;
  remoteOnly: boolean;
  onToggleRemote: (remote: boolean) => void;
  dateFilter: string;
  onChangeDate: (date: string) => void;
  salaryFilter: string;
  onChangeSalary: (salary: string) => void;
  experienceFilter: string;
  onChangeExperience: (exp: string) => void;
  onResetAll: () => void;
  availableCountries?: string[];
}

export default function FilterSlideOver({
  open,
  onClose,
  selectedCategories,
  onToggleCategory,
  countryFilter,
  onChangeCountry,
  remoteOnly,
  onToggleRemote,
  dateFilter,
  onChangeDate,
  salaryFilter,
  onChangeSalary,
  experienceFilter,
  onChangeExperience,
  onResetAll,
  availableCountries = [
    "United States",
    "United Kingdom",
    "Canada",
    "Germany",
    "France",
    "Sweden",
    "Switzerland",
    "Australia",
    "India",
  ],
}: FilterSlideOverProps) {
  // Close on ESC
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-fadeIn">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[#0F172A]/60 backdrop-blur-xs transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-Over Panel */}
      <div
        className="relative w-full max-w-md bg-[#F8FAFC] h-full shadow-popover z-10 flex flex-col justify-between overflow-hidden rounded-l-[20px] animate-slideInRight"
        role="dialog"
        aria-modal="true"
        aria-label="Filter panel"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-bold text-[#09090B]">
              Advanced Filters
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onResetAll}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 p-2 min-h-[44px] inline-flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close filters"
              className="p-2 min-h-[44px] min-w-[44px] rounded-lg text-gray-500 hover:text-gray-800 flex items-center justify-center transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Form Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-6">
          {/* Salary Filter */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Minimum Salary Band
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "all", label: "Any Salary" },
                { id: "100k", label: "$100k+ / year" },
                { id: "150k", label: "$150k+ / year" },
                { id: "200k", label: "$200k+ / year" },
              ].map((item) => {
                const isSelected = salaryFilter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChangeSalary(item.id)}
                    className={`px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium border text-left transition-colors flex items-center justify-between cursor-pointer ${
                      isSelected
                        ? "bg-blue-50 border-blue-600 text-blue-700 font-semibold"
                        : "border-gray-200 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span>{item.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-blue-600" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Experience Level Filter */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Experience Level
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "all", label: "All Levels" },
                { id: "fresher", label: "Entry / Fresher" },
                { id: "mid", label: "Mid-Level" },
                { id: "senior", label: "Senior / Staff" },
              ].map((item) => {
                const isSelected = experienceFilter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChangeExperience(item.id)}
                    className={`px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium border text-left transition-colors flex items-center justify-between cursor-pointer ${
                      isSelected
                        ? "bg-blue-50 border-blue-600 text-blue-700 font-semibold"
                        : "border-gray-200 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span>{item.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-blue-600" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Location / Country */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Country / Region
            </label>
            <select
              value={countryFilter}
              onChange={(e) => onChangeCountry(e.target.value)}
              className="w-full text-sm px-3.5 py-2.5 min-h-[44px] bg-white border border-gray-200 rounded-lg text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
            >
              <option value="all">All Countries (Worldwide)</option>
              {availableCountries
                .filter((c) => c && c.toLowerCase() !== "all")
                .map((countryName) => (
                  <option key={countryName} value={countryName}>
                    {countryName}
                  </option>
                ))}
            </select>
          </div>

          {/* Remote Only Toggle */}
          <div className="p-3.5 rounded-lg border border-gray-200 bg-gray-50/70">
            <label className="flex items-center justify-between cursor-pointer min-h-[44px]">
              <div>
                <span className="text-sm font-semibold text-[#09090B] block">
                  100% Remote Only
                </span>
                <span className="text-xs text-gray-500">
                  Surface positions eligible for full remote work
                </span>
              </div>
              <input
                type="checkbox"
                aria-label="100% Remote Only"
                checked={remoteOnly}
                onChange={(e) => onToggleRemote(e.target.checked)}
                className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500 border-gray-300 cursor-pointer"
              />
            </label>
          </div>

          {/* Date Discovered */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Date Discovered
            </label>
            <select
              value={dateFilter}
              onChange={(e) => onChangeDate(e.target.value)}
              className="w-full text-sm px-3.5 py-2.5 min-h-[44px] bg-white border border-gray-200 rounded-lg text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
            >
              <option value="all">Anytime (Live ATS feed)</option>
              <option value="24h">Past 24 hours</option>
              <option value="7d">Past 7 days</option>
              <option value="30d">Past 30 days</option>
            </select>
          </div>

          {/* Specific Categories Chips */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Specific Categories ({selectedCategories.length} active)
            </label>
            <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto p-1 border border-gray-100 rounded-lg">
              {CATEGORIES.slice(0, 18).map((cat) => {
                const isSelected = selectedCategories.includes(cat.slug);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => onToggleCategory(cat.slug)}
                    className={`px-3 py-1 min-h-[36px] rounded-full text-[12px] font-medium border transition-all duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)] flex items-center gap-1 cursor-pointer ${
                      isSelected
                        ? "bg-[#DBEAFE] text-[#1E3A8A] border-[#BFDBFE]"
                        : "bg-[#F1F5F9] border-[#E2E8F0] text-[#0F172A] hover:border-[#CBD5E1]"
                    }`}
                  >
                    <span>{cat.name}</span>
                    {isSelected && <X className="w-3 h-3 ml-0.5" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer with sticky safe padding (Netlify badge clearance) */}
        <div className="sticky bottom-0 z-20 p-4 sm:p-5 pb-24 sm:pb-5 border-t border-gray-100 bg-white/95 backdrop-blur-xs">
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white py-3 min-h-[48px] rounded-full font-bold text-sm sm:text-base shadow-none transition-all duration-200 ease-[cubic-bezier(0.645,0.045,0.355,1)] flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#93C5FD] focus:ring-offset-1"
          >
            Apply Filters
          </button>
        </div>
      </div>
    </div>
  );
}
