"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import { X, Search, ChevronDown, ChevronUp, Check, Plus } from "lucide-react";
import { ONBOARDING_CATEGORIES, OnboardingCategory } from "@/data/onboardingCategories";

interface JobFunctionBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  selectedRoles: string[];
  onToggleRole: (role: string) => void;
}

export default function JobFunctionBottomSheet({
  isOpen,
  onClose,
  selectedRoles,
  onToggleRole,
}: JobFunctionBottomSheetProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    "software-internet-ai": true,
    "human-resource-administrative-legal": false,
  });

  // Focus trap & Escape key listener
  useEffect(() => {
    if (!isOpen) return;

    // Auto-focus search input
    const timer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Tab") {
        if (!modalRef.current) return;
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  const toggleCategory = (catId: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [catId]: !prev[catId],
    }));
  };

  // Filtered categories based on search
  const filteredCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ONBOARDING_CATEGORIES;

    return ONBOARDING_CATEGORIES.map((cat) => {
      const catMatches = cat.name.toLowerCase().includes(q);
      const matchingSubgroups = cat.subgroups
        .map((sg) => {
          const sgMatches = sg.name.toLowerCase().includes(q);
          const matchingRoles = sg.roles.filter((r) =>
            r.toLowerCase().includes(q)
          );
          if (catMatches || sgMatches) {
            return sg;
          }
          return {
            ...sg,
            roles: matchingRoles,
          };
        })
        .filter((sg) => sg.roles.length > 0);

      return {
        ...cat,
        subgroups: matchingSubgroups,
      };
    }).filter((cat) => cat.subgroups.length > 0);
  }, [searchQuery]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="job-function-dialog-title"
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

      {/* Bottom sheet on mobile, Modal on desktop */}
      <div
        ref={modalRef}
        className="relative z-10 w-full sm:max-w-xl max-h-[88vh] sm:max-h-[82vh] flex flex-col bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-5 duration-200"
      >
        {/* Handle for mobile pull affordance */}
        <div className="w-12 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2
            id="job-function-dialog-title"
            className="text-lg font-bold text-zinc-900 dark:text-zinc-100"
          >
            Job Function
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

        {/* Search input */}
        <div className="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search expected job function or role"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search expected job function or role..."
              className="w-full pl-10 pr-9 py-2.5 text-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search query"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-0.5"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Accordion List */}
        <div className="flex-1 overflow-y-auto px-5 py-3 divide-y divide-zinc-100 dark:divide-zinc-800/80">
          {filteredCategories.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No matching job functions found for &ldquo;{searchQuery}&rdquo;.
            </div>
          ) : (
            filteredCategories.map((cat) => {
              const isExpanded =
                Boolean(expandedCategories[cat.id]) || Boolean(searchQuery.trim());
              const countInCat = cat.subgroups.reduce((acc, sg) => {
                return (
                  acc + sg.roles.filter((r) => selectedRoles.includes(r)).length
                );
              }, 0);

              return (
                <div key={cat.id} className="py-2.5 first:pt-1 last:pb-1">
                  {/* Category accordion header */}
                  <button
                    type="button"
                    onClick={() => toggleCategory(cat.id)}
                    aria-expanded={isExpanded}
                    className="w-full flex items-center justify-between py-2 text-left text-sm font-semibold text-zinc-900 dark:text-zinc-100 hover:text-emerald-600 dark:hover:text-emerald-400 transition"
                  >
                    <span className="flex items-center gap-2">
                      {cat.name}
                      {countInCat > 0 && (
                        <span className="text-xs px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 font-bold rounded-full">
                          {countInCat}
                        </span>
                      )}
                    </span>
                    <span className="text-zinc-400">
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </span>
                  </button>

                  {/* Subgroups & Role Chips */}
                  {isExpanded && (
                    <div className="mt-2 pl-1 pb-3 space-y-4 animate-in fade-in-50 duration-150">
                      {cat.subgroups.map((sg) => (
                        <div key={sg.name} className="space-y-2">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                            {sg.name}
                          </h4>
                          <div className="flex flex-wrap gap-1.5 sm:gap-2">
                            {sg.roles.map((role) => {
                              const isSelected = selectedRoles.includes(role);
                              return (
                                <button
                                  key={role}
                                  type="button"
                                  onClick={() => onToggleRole(role)}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                                    isSelected
                                      ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                                      : "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700/80 hover:border-zinc-300 dark:hover:border-zinc-600"
                                  }`}
                                >
                                  {isSelected ? (
                                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                  ) : (
                                    <Plus className="w-3 h-3 text-zinc-400" />
                                  )}
                                  {role}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/90 flex items-center justify-between gap-3">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {selectedRoles.length === 0 ? (
              <span>Select at least 1 role</span>
            ) : (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {selectedRoles.length} {selectedRoles.length === 1 ? "role" : "roles"} selected
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
