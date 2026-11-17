"use client";

import React, { useState } from "react";
import { X, MapPin, Check } from "lucide-react";
import { LOCATION_OPTIONS } from "@/data/onboardingCategories";

interface LocationPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedLocation: string;
  onSelectLocation: (loc: string) => void;
}

export default function LocationPickerModal({
  isOpen,
  onClose,
  selectedLocation,
  onSelectLocation,
}: LocationPickerModalProps) {
  const [customInput, setCustomInput] = useState("");

  if (!isOpen) return null;

  const handleSelect = (loc: string) => {
    onSelectLocation(loc);
    onClose();
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customInput.trim()) {
      onSelectLocation(customInput.trim());
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="location-dialog-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm transition-opacity"
    >
      {/* Backdrop click area */}
      <button
        type="button"
        aria-label="Close dialog backdrop"
        tabIndex={-1}
        className="fixed inset-0 cursor-default bg-transparent border-0"
        onClick={onClose}
      />

      <div className="relative z-10 w-full sm:max-w-md max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-5 duration-200">
        <div className="w-12 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2
            id="location-dialog-title"
            className="text-lg font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2"
          >
            <MapPin className="w-5 h-5 text-emerald-600" />
            Select Preferred Location
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Custom Location input */}
        <form onSubmit={handleCustomSubmit} className="p-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex gap-2">
            <input
              type="text"
              aria-label="Enter preferred city or region"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Or enter city/region (e.g. Hyderabad)..."
              className="flex-1 px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              disabled={!customInput.trim()}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-50 transition"
            >
              Add
            </button>
          </div>
        </form>

        {/* Preset Options */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {LOCATION_OPTIONS.map((loc) => {
            const isSelected = selectedLocation === loc;
            return (
              <button
                key={loc}
                type="button"
                onClick={() => handleSelect(loc)}
                className={`w-full flex items-center justify-between px-4 py-3 text-left text-sm rounded-xl font-medium transition ${
                  isSelected
                    ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-500"
                    : "text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                <span>{loc}</span>
                {isSelected && <Check className="w-4 h-4 text-emerald-600" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
