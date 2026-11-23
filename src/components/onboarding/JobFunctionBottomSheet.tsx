"use client";

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { X, Search, ChevronRight, ChevronDown, Check } from "lucide-react";
import { ONBOARDING_CATEGORIES } from "@/data/onboardingCategories";

interface JobFunctionBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  selectedRoles: string[];
  onToggleRole: (role: string) => void;
  openerElement?: HTMLElement | null;
}

export default function JobFunctionBottomSheet({
  isOpen,
  onClose,
  selectedRoles,
  onToggleRole,
  openerElement,
}: JobFunctionBottomSheetProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusReturnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCatId, setSelectedCatId] = useState<string>("software-internet-ai");
  // Mobile accordion: several categories may be open at once; selections live in selectedRoles, not here.
  const [expandedCatIds, setExpandedCatIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) =>
    setExpandedCatIds((prev) => {
      const nextIds = new Set(prev);
      if (nextIds.has(id)) nextIds.delete(id);
      else nextIds.add(id);
      return nextIds;
    });

  // Focus return handler
  const handleClose = useCallback(() => {
    onClose();
    // Return focus to opener element
    const target = openerElement || openerRef.current;
    if (target && typeof target.focus === "function") {
      if (focusReturnTimeoutRef.current) clearTimeout(focusReturnTimeoutRef.current);
      focusReturnTimeoutRef.current = setTimeout(() => {
        target.focus();
      }, 50);
    }
  }, [onClose, openerElement]);

  // Capture active opener on mount/open
  useEffect(() => {
    if (isOpen) {
      if (document.activeElement instanceof HTMLElement) {
        openerRef.current = document.activeElement;
      }
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (focusReturnTimeoutRef.current) clearTimeout(focusReturnTimeoutRef.current);
    };
  }, []);

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
        handleClose();
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
  }, [isOpen, handleClose]);

  // Active category for desktop right pane
  const currentCategory = useMemo(() => {
    return (
      ONBOARDING_CATEGORIES.find((c) => c.id === selectedCatId) ||
      ONBOARDING_CATEGORIES[0]
    );
  }, [selectedCatId]);

  // Search filtering across all categories and taxonomy groups
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;

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

  // Counts of selected roles per category
  const roleCountsByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const cat of ONBOARDING_CATEGORIES) {
      let count = 0;
      for (const sg of cat.subgroups) {
        for (const role of sg.roles) {
          if (selectedRoles.includes(role)) {
            count++;
          }
        }
      }
      map.set(cat.id, count);
    }
    return map;
  }, [selectedRoles]);

  if (!isOpen) return null;

  const isSearching = Boolean(searchQuery.trim());

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
        onClick={handleClose}
      />

      {/* Modal / Bottom Sheet Window */}
      <div
        ref={modalRef}
        className="relative z-10 w-full sm:max-w-3xl lg:max-w-4xl max-h-[92vh] sm:max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-5 duration-200"
      >
        {/* Handle for mobile pull affordance */}
        <div className="w-12 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <h2
              id="job-function-dialog-title"
              className="text-lg font-bold text-zinc-900 dark:text-zinc-100"
            >
              Job roles
            </h2>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:inline">
              (Choose roles matching your expertise)
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="p-1.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60">
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search job roles"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search job roles"
              className="w-full pl-10 pr-9 py-2.5 text-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 lg:focus:ring-brand-500"
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

        {/* Selected Roles Preview Row (if any selected) */}
        {selectedRoles.length > 0 && (
          <div className="px-5 py-2.5 bg-emerald-50/50 lg:bg-brand-50/50 dark:bg-emerald-950/20 lg:dark:bg-brand-900/20 border-b border-emerald-100 lg:border-brand-100 dark:border-emerald-900/30 lg:dark:border-brand-900/30 flex items-center gap-2 overflow-x-auto">
            <span className="text-xs font-semibold text-emerald-800 lg:text-brand-800 dark:text-emerald-300 lg:dark:text-brand-300 flex-shrink-0">
              Selected ({selectedRoles.length}):
            </span>
            <div className="flex items-center gap-1.5 flex-nowrap">
              {selectedRoles.map((role) => (
                <span
                  key={role}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 lg:bg-brand-100 dark:bg-emerald-900/60 lg:dark:bg-brand-900/60 text-emerald-900 lg:text-brand-900 dark:text-emerald-100 lg:dark:text-brand-100 border border-emerald-300 lg:border-brand-300 dark:border-emerald-800 lg:dark:border-brand-800 flex-shrink-0"
                >
                  <span>{role}</span>
                  <button
                    type="button"
                    onClick={() => onToggleRole(role)}
                    aria-label={`Remove ${role}`}
                    className="p-0.5 hover:bg-emerald-200 lg:hover:bg-brand-200 dark:hover:bg-emerald-800 lg:dark:hover:bg-brand-800 rounded-full"
                  >
                    <X className="w-3 h-3 text-emerald-700 lg:text-brand-700 dark:text-emerald-200 lg:dark:text-brand-200" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Desktop Two-Pane Layout / Mobile Drill-in Layout */}
        <div className="flex-1 overflow-hidden flex flex-col lg:flex-row min-h-[380px] sm:min-h-[420px] max-h-[62vh]">
          {/* SEARCH RESULTS VIEW (Applies to both Desktop and Mobile when searching) */}
          {isSearching ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {searchResults && searchResults.length > 0 ? (
                searchResults.map((cat) => (
                  <div key={cat.id} className="space-y-3">
                    <h3 className="text-sm font-bold text-emerald-700 lg:text-brand-700 dark:text-emerald-400 lg:dark:text-brand-400 border-b border-emerald-100 lg:border-brand-100 dark:border-emerald-900/40 lg:dark:border-brand-900/40 pb-1">
                      {cat.name}
                    </h3>
                    <div className="space-y-3 pl-2">
                      {cat.subgroups.map((sg) => (
                        <div key={sg.name} className="space-y-2">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                            {sg.name}
                          </h4>
                          <div className="flex flex-wrap gap-2">
                            {sg.roles.map((role) => {
                              const isSelected = selectedRoles.includes(role);
                              return (
                                <button
                                  key={role}
                                  type="button"
                                  onClick={() => onToggleRole(role)}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition ${
                                    isSelected
                                      ? "bg-emerald-100 lg:bg-brand-100 dark:bg-emerald-900/60 lg:dark:bg-brand-900/60 text-emerald-900 lg:text-brand-900 dark:text-emerald-100 lg:dark:text-brand-100 border border-emerald-500/50 lg:border-brand-500/50 shadow-xs font-semibold"
                                      : "bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700"
                                  }`}
                                >
                                  {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                                  <span>{role}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  No matching job roles found for &ldquo;{searchQuery}&rdquo;.
                </div>
              )}
            </div>
          ) : (
            <>
              {/* DESKTOP VIEW: Left category navigation list + Right grouped role chips */}
              <div className="hidden lg:flex w-full h-full overflow-hidden">
                {/* Left pane: Category navigation */}
                <div className="w-1/3 min-w-[240px] max-w-[280px] border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto bg-zinc-50/50 dark:bg-zinc-900/40 py-2">
                  <div className="space-y-0.5 px-2">
                    {ONBOARDING_CATEGORIES.map((cat) => {
                      const isSelected = cat.id === selectedCatId;
                      const count = roleCountsByCat.get(cat.id) || 0;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          data-testid={`category-nav-${cat.id}`}
                          onClick={() => setSelectedCatId(cat.id)}
                          className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left text-sm transition ${
                            isSelected
                              ? "bg-brand-100/70 dark:bg-brand-900/60 text-brand-900 dark:text-brand-100 font-bold shadow-xs border-r-4 border-brand-600"
                              : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 font-medium"
                          }`}
                        >
                          <span className="truncate pr-2">{cat.name}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {count > 0 && (
                              <span className="text-[11px] px-1.5 py-0.2 bg-brand-200 dark:bg-brand-900 text-brand-900 dark:text-brand-100 rounded-full font-bold">
                                {count}
                              </span>
                            )}
                            <ChevronRight
                              className={`w-4 h-4 ${
                                isSelected
                                  ? "text-brand-600 dark:text-brand-400"
                                  : "text-zinc-400"
                              }`}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Right pane: Grouped role chips for active category */}
                <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5 bg-white dark:bg-zinc-900">
                  <div className="border-b border-zinc-100 dark:border-zinc-800 pb-2">
                    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {currentCategory.name}
                    </h3>
                  </div>

                  <div className="space-y-5">
                    {currentCategory.subgroups.map((sg) => (
                      <div key={sg.name} className="space-y-2.5">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                          {sg.name}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {sg.roles.map((role) => {
                            const isSelected = selectedRoles.includes(role);
                            return (
                              <button
                                key={role}
                                type="button"
                                onClick={() => onToggleRole(role)}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-medium transition ${
                                  isSelected
                                    ? "bg-brand-100 dark:bg-brand-900/60 text-brand-900 dark:text-brand-100 border border-brand-500/50 shadow-xs font-semibold"
                                    : "bg-zinc-100 dark:bg-zinc-800/80 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200/80 dark:border-zinc-700/80"
                                }`}
                              >
                                {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                                <span>{role}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* MOBILE VIEW: inline accordion, child roles selectable under their category (no drill-down screen) */}
              <div className="lg:hidden flex-1 overflow-y-auto">
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80 px-4 py-1">
                  {ONBOARDING_CATEGORIES.map((cat) => {
                    const count = roleCountsByCat.get(cat.id) || 0;
                    const expanded = expandedCatIds.has(cat.id);
                    const panelId = `mobile-cat-panel-${cat.id}`;
                    return (
                      <div key={cat.id}>
                        <h3>
                          <button
                            type="button"
                            data-testid={`mobile-cat-${cat.id}`}
                            onClick={() => toggleExpanded(cat.id)}
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            className="w-full min-h-[48px] flex items-center justify-between gap-3 py-3 text-left text-sm font-semibold text-zinc-800 dark:text-zinc-200 hover:text-emerald-600 transition"
                          >
                            <span>{cat.name}</span>
                            <span className="flex items-center gap-2 flex-shrink-0">
                              {count > 0 && (
                                <span className="text-xs px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/70 text-emerald-800 dark:text-emerald-200 font-bold rounded-full">
                                  {count}
                                  <span className="sr-only"> selected</span>
                                </span>
                              )}
                              <ChevronDown
                                aria-hidden="true"
                                className={`w-4 h-4 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                              />
                            </span>
                          </button>
                        </h3>
                        {expanded && (
                          <div id={panelId} role="region" aria-label={cat.name} className="pb-4 space-y-3">
                            {cat.subgroups.map((sg) => (
                              <div key={sg.name} className="space-y-2">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                                  {sg.name}
                                </h4>
                                <div className="flex flex-wrap gap-2">
                                  {sg.roles.map((role) => {
                                    const isSelected = selectedRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        type="button"
                                        onClick={() => onToggleRole(role)}
                                        aria-pressed={isSelected}
                                        className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 py-2 rounded-xl text-sm text-left font-medium transition ${
                                          isSelected
                                            ? "bg-emerald-100 dark:bg-emerald-900/60 text-emerald-900 dark:text-emerald-100 border border-emerald-500/50 shadow-xs font-semibold"
                                            : "bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200/80 dark:border-zinc-700"
                                        }`}
                                      >
                                        {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5] flex-shrink-0" aria-hidden="true" />}
                                        <span>{role}</span>
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
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/90 flex items-center justify-between gap-3">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {selectedRoles.length === 0 ? (
              <span>Select at least 1 role</span>
            ) : (
              <span className="font-semibold text-emerald-600 lg:text-brand-600 dark:text-emerald-400 lg:dark:text-brand-400">
                {selectedRoles.length} {selectedRoles.length === 1 ? "role" : "roles"} selected
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="px-6 py-2.5 text-sm font-bold rounded-full bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 text-white shadow-sm transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
