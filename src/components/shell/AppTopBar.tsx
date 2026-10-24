"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search, Menu, X, LogOut, Settings, User as UserIcon, ChevronDown } from "lucide-react";
import BrandIcon from "@/components/BrandIcon";
import { NAV_ITEMS } from "./AppIconRail";
import { signOutUser } from "@/lib/auth/session";
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname() || "";
  const router = useRouter();

  // Handle Escape key to close mobile drawer and body overflow locking
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawerOpen]);

  const handleSignOut = async () => {
    await signOutUser();
    setDrawerOpen(false);
    router.push("/");
  };

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
    <>
      <header
        data-testid="app-top-bar"
        className="sticky top-0 z-30 h-14 bg-white border-b border-[#E2E8F0] w-full"
      >
        <div className="h-full px-4 sm:px-6 flex items-center justify-between gap-3 sm:gap-4">
          {/* =================================================================== */}
          {/* LEFT: Mobile Hamburger + Page Label + Tabs (on /jobs)               */}
          {/* =================================================================== */}
          <div className="flex items-center gap-2.5 sm:gap-4 min-w-0 flex-1 sm:flex-initial">
            {/* Mobile Hamburger Button */}
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              className="md:hidden inline-flex items-center justify-center w-10 h-10 min-h-[44px] min-w-[44px] -ml-2 rounded-full text-[#0F172A] hover:bg-[#F1F5F9] transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Page Label (bold 18px uppercase) */}
            <h1 className="font-bold text-[18px] uppercase tracking-wider text-[#0F172A] shrink-0 leading-none">
              {pageLabel}
            </h1>

            {/* Breadcrumb separator between Page Label and Tabs */}
            {tabs && tabs.length > 0 && (
              <span className="text-slate-400 font-semibold text-lg hidden sm:inline select-none leading-none">
                ›
              </span>
            )}

            {/* Optional Tabs (e.g. Recommended | Saved | Applied | External) */}
            {tabs && tabs.length > 0 && (
              <div className="hidden sm:flex items-center gap-1 sm:gap-2 ml-1 sm:ml-3 overflow-x-auto no-scrollbar">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={tab.onClick}
                    className={`relative h-14 min-h-[44px] inline-flex items-center gap-1.5 px-2.5 sm:px-3 text-[14px] cursor-pointer whitespace-nowrap transition-colors duration-200 ${
                      tab.active
                        ? "font-bold text-[#0F172A] after:absolute after:bottom-0 after:left-2 after:right-2 after:h-[2px] after:bg-[#0F172A]"
                        : "font-medium text-[#475569] hover:text-[#0F172A]"
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
                  className="w-full h-9 pl-9 pr-3 rounded-full bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder-[#475569] border border-transparent focus:border-[#93C5FD] focus:bg-white focus:outline-none transition-all duration-200"
                />
              </div>
            </div>
          )}

          {/* =================================================================== */}
          {/* FAR RIGHT: Avatar, Full Name bold 13px, Plan Pill Free/Pro          */}
          {/* =================================================================== */}
          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
            {/* Promo pill matching signed-in reference */}
            {!isPro && (
              <Link
                href="/pricing"
                aria-label="Upgrade to Pro"
                className="hidden xl:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 text-xs font-bold text-[#1E3A8A] hover:border-blue-300 transition-colors shadow-2xs shrink-0"
              >
                <span className="w-4 h-4 rounded-full bg-[#2563EB] text-white flex items-center justify-center text-[10px]">⚡</span>
                <span>Pro: Direct ATS & AI Tailor</span>
                <span className="text-[#2563EB] font-bold">›</span>
              </Link>
            )}

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

            {/* Circular avatar with user's initial on #2563EB + full name bold 13px + Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setAvatarMenuOpen((prev) => !prev)}
                aria-label="User avatar menu"
                aria-haspopup="true"
                aria-expanded={avatarMenuOpen}
                className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded-full cursor-pointer"
              >
                <div className="w-8 h-8 rounded-full bg-[#2563EB] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
                  {userInitial}
                </div>
                <span className="font-bold text-[13px] text-[#0F172A] hidden lg:inline truncate max-w-[120px]">
                  {displayName}
                </span>
                <ChevronDown className={`w-3 h-3 text-[#64748B] hidden sm:inline transition-transform ${avatarMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {avatarMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" role="presentation" onClick={() => setAvatarMenuOpen(false)} />
                  <div
                    data-testid="avatar-menu-dropdown"
                    className="absolute right-0 top-full mt-2 w-56 bg-white border border-[#E2E8F0] rounded-xl shadow-xl z-50 overflow-hidden text-left py-1.5 animate-fadeIn"
                  >
                    <div className="px-4 py-2.5 border-b border-[#F1F5F9]">
                      <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Signed in as</p>
                      <p className="text-[13px] font-bold text-[#0F172A] truncate mt-0.5">{displayName}</p>
                      <p className="text-[11px] text-[#64748B] truncate">{user?.email}</p>
                    </div>

                    <div className="p-1 space-y-0.5">
                      <Link
                        href="/profile"
                        onClick={() => setAvatarMenuOpen(false)}
                        className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#0F172A] hover:bg-[#EFF6FF] hover:text-[#2563EB] rounded-lg transition-colors font-medium"
                      >
                        <UserIcon className="w-4 h-4 text-[#64748B]" />
                        <span>Profile</span>
                      </Link>
                      <Link
                        href="/settings"
                        onClick={() => setAvatarMenuOpen(false)}
                        className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#0F172A] hover:bg-[#EFF6FF] hover:text-[#2563EB] rounded-lg transition-colors font-medium"
                      >
                        <Settings className="w-4 h-4 text-[#64748B]" />
                        <span>Settings</span>
                      </Link>
                      <div className="my-1 border-t border-[#F1F5F9]" />
                      <button
                        type="button"
                        onClick={async () => {
                          setAvatarMenuOpen(false);
                          await signOutUser();
                          router.push("/");
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#DC2626] hover:bg-[#FEF2F2] rounded-lg transition-colors font-medium text-left cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

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
                className="w-full h-9 pl-9 pr-3 rounded-full bg-[#F1F5F9] text-[13px] text-[#0F172A] placeholder-[#475569] border border-transparent focus:border-[#93C5FD] focus:bg-white focus:outline-none transition-all duration-200"
              />
            </div>
          </div>
        )}
      </header>

      {/* =================================================================== */}
      {/* MOBILE FULL-HEIGHT DRAWER (0.3s cubic-bezier slide-in from left)    */}
      {/* =================================================================== */}
      {/* Backdrop: raised to z-[60] above CookieNotice z-50 */}
      <div
        role="presentation"
        onClick={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
        className={`fixed inset-0 bg-[#0F172A]/60 z-[60] transition-opacity duration-300 md:hidden ${
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Drawer: raised to z-[61] above backdrop z-[60] and CookieNotice z-50; scrollable on short screens */}
      <div
        id="mobile-nav-drawer"
        role="dialog"
        aria-label="Mobile Navigation"
        aria-modal="true"
        className={`fixed inset-y-0 left-0 z-[61] w-full max-w-[280px] bg-white h-full shadow-2xl flex flex-col justify-between p-5 transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] md:hidden overflow-y-auto overscroll-contain ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="space-y-4 min-h-0">
          {/* Header: Brand Logo + Close */}
          <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
            <Link
              href="/dashboard"
              onClick={() => setDrawerOpen(false)}
              className="flex items-center gap-2"
            >
              <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0] shadow-xs">
                <BrandIcon className="w-6 h-6" />
              </div>
              <span className="text-lg font-bold text-[#2563EB] tracking-tight">CareerMonke</span>
            </Link>
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                menuButtonRef.current?.focus();
              }}
              aria-label="Close navigation menu"
              className="inline-flex items-center justify-center w-10 h-10 min-h-[44px] min-w-[44px] rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Links */}
          <nav aria-label="Mobile Primary Navigation" className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.isActive(pathname);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setDrawerOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-xl text-[14px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                    active
                      ? "bg-[#EFF6FF] text-[#2563EB] font-bold"
                      : "text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] font-medium"
                  }`}
                >
                  <Icon className="w-5 h-5 stroke-[1.75] shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}

            {/* Settings Link */}
            <Link
              href="/settings"
              onClick={() => setDrawerOpen(false)}
              aria-current={pathname === "/settings" ? "page" : undefined}
              className={`flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-xl text-[14px] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                pathname === "/settings"
                  ? "bg-[#EFF6FF] text-[#2563EB] font-bold"
                  : "text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] font-medium"
              }`}
            >
              <Settings className="w-5 h-5 stroke-[1.75] shrink-0" />
              <span>Settings</span>
            </Link>
          </nav>
        </div>

        {/* Drawer Footer: User Profile & Sign Out (shrink-0 ensures always fully reachable) */}
        <div className="pt-3 border-t border-[#E2E8F0] space-y-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#2563EB] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-xs">
              {userInitial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[#0F172A] truncate">
                {displayName}
              </p>
              <p className="text-[11px] text-[#64748B] truncate">
                {user?.email || "Signed in"}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-[#CBD5E1] text-[#475569] bg-white shrink-0">
              {isPro ? "Pro" : "Free"}
            </span>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2 rounded-xl text-[14px] font-medium text-rose-600 hover:bg-rose-50 hover:text-rose-700 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </>
  );
}
