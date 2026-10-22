"use client";

import React from "react";
import AppIconRail from "./AppIconRail";
import AppTopBar, { TopBarTab } from "./AppTopBar";
import type { User } from "@supabase/supabase-js";

interface LoggedInAppShellProps {
  pageLabel: string;
  tabs?: TopBarTab[];
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  user?: User | null;
  isPro?: boolean;
  children: React.ReactNode;
}

export default function LoggedInAppShell({
  pageLabel,
  tabs,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  user,
  isPro,
  children,
}: LoggedInAppShellProps) {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      {/* Left Icon Rail (fixed 72px on desktop, bottom tab bar on mobile) */}
      <AppIconRail />

      {/* Top Bar + Content area (offset by 72px on desktop, pb-16 on mobile for tab bar) */}
      <div className="flex-1 md:pl-[72px] flex flex-col min-w-0 pb-16 md:pb-0">
        <AppTopBar
          pageLabel={pageLabel}
          tabs={tabs}
          searchValue={searchValue}
          onSearchChange={onSearchChange}
          searchPlaceholder={searchPlaceholder}
          user={user}
          isPro={isPro}
        />
        <main id="main-content" className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
