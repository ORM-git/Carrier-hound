"use client";

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { X, Search, Check, Globe } from "lucide-react";
import { SUPPORTED_COUNTRIES, COUNTRY_CODE_TO_NAME, CountryOption } from "@/lib/countries";

interface CountryPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedCountry: string;
  onSelectCountry: (country: { code: string; name: string }) => void;
  openerElement?: HTMLElement | null;
}

const POPULAR_COUNTRY_CODES = ["IN", "US", "GB", "CA", "DE", "AU", "SG", "FR", "AE", "NL"];

export default function CountryPickerModal({
  isOpen,
  onClose,
  selectedCountry,
  onSelectCountry,
  openerElement,
}: CountryPickerModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const handleClose = useCallback(() => {
    onClose();
    const target = openerElement || openerRef.current;
    if (target && typeof target.focus === "function") {
      setTimeout(() => {
        target.focus();
      }, 50);
    }
  }, [onClose, openerElement]);

  useEffect(() => {
    if (isOpen && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement;
    }
  }, [isOpen]);

  // Build full sorted country list
  const allCountries = useMemo(() => {
    const list: CountryOption[] = [];
    const seenCodes = new Set<string>();

    // 1. Add from SUPPORTED_COUNTRIES (skip blank Worldwide option)
    for (const item of SUPPORTED_COUNTRIES) {
      if (!item.code) continue;
      if (!seenCodes.has(item.code)) {
        seenCodes.add(item.code);
        list.push(item);
      }
    }

    // 2. Add from COUNTRY_CODE_TO_NAME
    for (const [code, name] of Object.entries(COUNTRY_CODE_TO_NAME)) {
      if (!seenCodes.has(code)) {
        seenCodes.add(code);
        list.push({
          code,
          name,
          label: `${name} (${code})`,
        });
      }
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  // Filter countries based on search
  const filteredCountries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allCountries;

    return allCountries.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q)
    );
  }, [allCountries, searchQuery]);

  // Focus trap & Escape key listener
  useEffect(() => {
    if (!isOpen) return;

    setSearchQuery("");
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

  if (!isOpen) return null;

  const handleSelect = (c: CountryOption) => {
    onSelectCountry({ code: c.code, name: c.name });
    handleClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="country-picker-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm transition-opacity"
    >
      {/* Backdrop click area */}
      <button
        type="button"
        aria-label="Close country picker backdrop"
        tabIndex={-1}
        className="fixed inset-0 cursor-default bg-transparent border-0"
        onClick={handleClose}
      />

      {/* Modal dialog */}
      <div
        ref={modalRef}
        className="relative z-10 w-full sm:max-w-md max-h-[88vh] sm:max-h-[80vh] flex flex-col bg-white dark:bg-zinc-900 border-t sm:border border-zinc-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-5 duration-200"
      >
        {/* Handle for mobile pull affordance */}
        <div className="w-12 h-1.5 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <h2
              id="country-picker-title"
              className="text-lg font-bold text-zinc-900 dark:text-zinc-100"
            >
              Select Country
            </h2>
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

        {/* Search input */}
        <div className="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search country name or code"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search country (e.g. India, United States, Canada)..."
              className="w-full pl-10 pr-9 py-2.5 text-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-0.5"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Quick popular badges */}
          {!searchQuery && (
            <div className="mt-3">
              <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider block mb-1.5">
                Popular Countries
              </span>
              <div className="flex flex-wrap gap-1.5">
                {POPULAR_COUNTRY_CODES.map((code) => {
                  const countryName = COUNTRY_CODE_TO_NAME[code];
                  if (!countryName) return null;
                  const isSelected =
                    selectedCountry.toLowerCase() === countryName.toLowerCase() ||
                    selectedCountry.toUpperCase() === code;
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => handleSelect({ code, name: countryName, label: countryName })}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium transition ${
                        isSelected
                          ? "bg-emerald-600 text-white shadow-sm"
                          : "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      }`}
                    >
                      {countryName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Country list */}
        <div className="flex-1 overflow-y-auto px-4 py-2 divide-y divide-zinc-100 dark:divide-zinc-800/60 max-h-[50vh]">
          {filteredCountries.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-400 dark:text-zinc-500">
              No matching countries found for &ldquo;{searchQuery}&rdquo;
            </div>
          ) : (
            filteredCountries.map((c) => {
              const isSelected =
                selectedCountry.toLowerCase() === c.name.toLowerCase() ||
                selectedCountry.toUpperCase() === c.code;
              return (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => handleSelect(c)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition ${
                    isSelected
                      ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 font-semibold"
                      : "text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">{c.name}</span>
                    <span className="text-[11px] font-mono font-medium px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                      {c.code}
                    </span>
                  </div>
                  {isSelected && <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
