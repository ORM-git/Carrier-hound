"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { User } from "@supabase/supabase-js";

export interface TopBarTab {
  id: string;
  label: string;
  count?: number | string;
  active: boolean;
  onClick: () => void;
}

interface AppTopBarProps {
  pageLabel: string;
  tabs?: TopBarTab[];
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  user?: User | null;
  isPro?: boolean;
}

export default function AppTopBar({
  pageLabel,
  tabs,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search by title or company",
  user,
  isPro = false,
}: AppTopBarProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // Compute initials and display name
  const userInitial = user?.email
    ? user.email.slice(0, 1).toUpperCase()
    : "U";

  const rawName =
    (user?.user_metadata?.full_name as string) ||
    (user?.user_metadata?.name as string) ||
    (user?.email ? user.email.split("@")[0] : "Candidate");

  // Format display name nicely
  const displayName =
    rawName.charAt(0).toUpperCase() + rawName.slice(1);

  return (
    <header
      data-testid="app-top-bar"
      className="sticky top-0 z-30 h-14 bg-white border-b border-[#E2E8F0] w-full"
    >
      <div className="h-full px-4 sm:px-6 flex items-center justify-between gap-3 sm:gap-4">
        {/* =================================================================== */}
        {/* LEFT: Page Label + Tabs (on /jobs)                                  */}
        {/* =================================================================== */}
        <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1 sm:flex-initial">
          {/* Page Label (bold 18px uppercase) */}
          <h1 className="font-bold text-[18px] uppercase tracking-wider text-[#0F172A] shrink-0 leading-none">
            {pageLabel}
          </h1>

          {/* Optional Tabs (e.g. Recommended | Saved | Applied | External) */}
          {tabs && tabs.length > 0 && (
            <div className="hidden sm:flex items-center gap-1 sm:gap-2 ml-1 sm:ml-3 overflow-x-auto no-scrollbar">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={tab.onClick}
                  className={`relative h-14 inline-flex items-center gap-1.5 px-2.5 sm:px-3 text-[14px] cursor-pointer whitespace-nowrap transition-colors duration-200 ${
                    tab.active
                      ? "font-bold text-[#0F172A] after:absolute after:bottom-0 after:left-2 after:right-2 after:h-[2px] after:bg-[#0F172A]"
                      : "font-medium text-[#94A3B8] hover:text-[#0F172A]"
                  }`}
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-[#0F172A] text-white leading-none">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* =================================================================== */}
        {/* RIGHT OF CENTRE: Fully Rounded Search Input                          */}
        {/* =================================================================== */}
        {onSearchChange && (
          <div className="flex-1 max-w-xs sm:max-w-sm hidden md:block mx-2">
            <div className="relative">
              <Search className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                aria-label="Search by job title, company, or keyword"
                value={searchValue || ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full h-9 pl-9 pr-3 rounded-full bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder-[#94A3B8] border border-transparent focus:border-[#93C5FD] focus:bg-white focus:outline-none transition-all duration-200"
              />
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* FAR RIGHT: Avatar, Full Name bold 13px, Plan Pill Free/Pro          */}
        {/* =================================================================== */}
        <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
          {/* Mobile search toggle if search is enabled */}
          {onSearchChange && (
            <button
              type="button"
              onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
              aria-label="Toggle search input"
              className="md:hidden w-8 h-8 rounded-full flex items-center justify-center text-[#64748B] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors"
            >
              <Search className="w-4 h-4" />
            </button>
          )}

          {/* Circular avatar with user's initial on #2563EB + full name bold 13px */}
          <Link
            href="/settings"
            aria-label="Profile and settings"
            className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded-full"
          >
            <div className="w-8 h-8 rounded-full bg-[#2563EB] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
              {userInitial}
            </div>
            <span className="font-bold text-[13px] text-[#0F172A] hidden lg:inline truncate max-w-[120px]">
              {displayName}
            </span>
          </Link>

          {/* Plan Pill ("Free" or "Pro") with neutral outline */}
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold border border-[#CBD5E1] text-[#475569] bg-white shadow-none shrink-0">
            {isPro ? "Pro" : "Free"}
          </span>
        </div>
      </div>

      {/* Mobile search dropdown bar when toggled */}
      {onSearchChange && mobileSearchOpen && (
        <div className="md:hidden px-4 py-2 bg-white border-b border-[#E2E8F0]">
          <div className="relative">
            <Search className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              autoFocus
              aria-label="Search by job title, company, or keyword"
              value={searchValue || ""}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full h-9 pl-9 pr-3 rounded-full bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder-[#94A3B8] border border-transparent focus:border-[#93C5FD] focus:bg-white focus:outline-none transition-all duration-200"
            />
          </div>
        </div>
      )}
    </header>
  );
}
