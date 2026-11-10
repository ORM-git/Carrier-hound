"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import AppIconRail from "./AppIconRail";
import AppTopBar, { TopBarTab } from "./AppTopBar";
import { useSidebarMode } from "@/lib/sidebar";
import type { User } from "@supabase/supabase-js";

const USER_EMAIL_KEY = "careermonke_user_email";

interface LoggedInAppShellProps {
  pageLabel: string;
  tabs?: TopBarTab[];
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  user?: User | null;
  isPro?: boolean;
  mainClassName?: string;
  hideFooter?: boolean;
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
  mainClassName,
  hideFooter = false,
  children,
}: LoggedInAppShellProps) {
  const { isExpanded } = useSidebarMode();
  const router = useRouter();

  // Cross-tab state sync: when another tab signs out, the user-email key is
  // removed from localStorage and every other open app tab is sent to
  // /login instead of sitting on a stale authenticated view. Same-tab
  // sign-out already redirects through UserMenu.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === USER_EMAIL_KEY && event.newValue === null) {
        router.replace("/login");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [router]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      {/* Left Icon Rail / Sidebar (dual-mode 72px / 240px on desktop, hidden on mobile) */}
      <AppIconRail />

      {/* Top Bar + Content area (offset dynamically by 72px or 240px on desktop) */}
      <div
        className={`flex-1 flex flex-col min-w-0 pb-6 md:pb-0 transition-[padding] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${
          isExpanded ? "md:pl-[240px]" : "md:pl-[72px]"
        }`}
      >
        <AppTopBar
          pageLabel={pageLabel}
          tabs={tabs}
          searchValue={searchValue}
          onSearchChange={onSearchChange}
          searchPlaceholder={searchPlaceholder}
          user={user}
          isPro={isPro}
        />
        <main id="main-content" className={mainClassName || "flex-1 min-w-0"}>
          {children}
        </main>
        {!hideFooter && pageLabel !== "PRICING" && (
          <footer className="border-t border-slate-200/80 bg-white/50 py-4 px-4 sm:px-6 text-center text-xs text-slate-400 mt-auto">
            <p>© 2026 Olive Ridley Media Private Limited. All rights reserved.</p>
          </footer>
        )}
      </div>
    </div>
  );
}
