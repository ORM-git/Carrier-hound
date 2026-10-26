"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import BrandIcon from "./BrandIcon";
import { getAuthUser, signOutUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import type { User } from "@supabase/supabase-js";
import {
  Menu,
  X,
  ChevronDown,
  Globe,
  Building,
  Settings,
  Bell,
  CreditCard,
  LogOut,
} from "lucide-react";

export default function GuideHeader() {
  const pathname = usePathname();
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const exploreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Lock page scroll + Escape to close while mobile drawer is open
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  useEffect(() => {
    const checkAuth = () => {
      getAuthUser().then((u) => setUser(u));
    };
    checkAuth();

    const handleAuthChange = () => checkAuth();
    window.addEventListener("careermonke_auth_updated", handleAuthChange);
    return () => {
      window.removeEventListener("careermonke_auth_updated", handleAuthChange);
    };
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (exploreRef.current && !exploreRef.current.contains(e.target as Node)) {
        setExploreOpen(false);
      }
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExploreOpen(false);
        setAccountOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const [isPro, setIsPro] = useState(false);

  useEffect(() => {
    getProAccessStatus().then((res) => setIsPro(res.isPro));
    const handleSubUpdate = () => {
      getProAccessStatus().then((res) => setIsPro(res.isPro));
    };
    window.addEventListener("careermonke_pro_updated", handleSubUpdate);
    window.addEventListener("careermonke_auth_updated", handleSubUpdate);
    return () => {
      window.removeEventListener("careermonke_pro_updated", handleSubUpdate);
      window.removeEventListener("careermonke_auth_updated", handleSubUpdate);
    };
  }, [user]);

  const handleSignOut = async () => {
    await signOutUser();
    setUser(null);
    setAccountOpen(false);
    setDrawerOpen(false);
    router.push("/");
  };

  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : "CM";

  const isJobsActive = pathname === "/jobs" || Boolean(pathname?.startsWith("/job-search"));
  const isPricingActive = pathname === "/pricing";
  const isResourcesActive = Boolean(pathname?.startsWith("/remote"));
  const isWorldwideActive = pathname === "/worldwide";
  const isRadarActive = pathname === "/radar";
  const isApplicationsActive = pathname === "/applications" || pathname === "/tracker";
  const isResumeActive = pathname === "/resume";
  const isDashboardActive = pathname === "/dashboard";

  const navLinkClass = (active: boolean) =>
    `relative h-16 inline-flex items-center px-3 text-[14px] transition-colors duration-200 ${
      active
        ? "font-bold text-[#0F172A] after:absolute after:bottom-0 after:left-3 after:right-3 after:h-[2px] after:bg-[#0F172A]"
        : "font-medium text-[#475569] hover:text-[#0F172A]"
    }`;

  const drawerLinkClass = (active: boolean) =>
    `flex items-center justify-between px-3 min-h-[44px] rounded-lg text-[14px] transition-colors duration-200 ${
      active
        ? "font-bold text-[#0F172A] bg-[#F1F5F9] border-l-2 border-[#0F172A]"
        : "font-medium text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC]"
    }`;

  const dropdownItemClass =
    "flex items-center gap-2.5 px-3 min-h-[40px] rounded-lg text-[14px] font-medium text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A] transition-colors duration-200";

  return (
    <>
      <header className="sticky top-0 z-40 bg-white border-b border-[#E2E8F0] h-16 w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between gap-4">
          {/* Left: Brand Logo */}
          <Link
            href={user ? "/dashboard" : "/"}
            className="flex items-center gap-2.5 shrink-0 min-h-[44px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
          >
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0] shadow-xs shrink-0">
              <BrandIcon className="w-7 h-7" />
            </div>
            <span className="text-xl font-bold text-[#2563EB] tracking-tight">CareerMonke</span>
          </Link>

          {/* Centre / Left Nav Links: Desktop */}
          {user ? (
            /* Logged-In User Nav */
            <nav aria-label="Primary" className="hidden lg:flex flex-1 items-center justify-center gap-1 h-full">
              <Link href="/dashboard" className={navLinkClass(isDashboardActive)}>
                Dashboard
              </Link>
              <Link href="/jobs" prefetch={false} className={navLinkClass(isJobsActive)}>
                Jobs
              </Link>
              <Link href="/resume" prefetch={false} className={navLinkClass(isResumeActive)}>
                ATS Resume
              </Link>
              <Link href="/applications" prefetch={false} className={navLinkClass(isApplicationsActive)}>
                Applications
              </Link>
              <Link href="/remote" prefetch={false} className={navLinkClass(isResourcesActive)}>
                Resources
              </Link>
              <Link href="/pricing" prefetch={false} className={navLinkClass(isPricingActive)}>
                Pricing
              </Link>

              {/* Explore Dropdown */}
              <div className="relative h-16 inline-flex items-center" ref={exploreRef}>
                <button
                  type="button"
                  onClick={() => setExploreOpen(!exploreOpen)}
                  aria-expanded={exploreOpen}
                  aria-haspopup="true"
                  className="flex items-center gap-1 px-3 text-[14px] font-medium text-[#475569] hover:text-[#0F172A] cursor-pointer transition-colors duration-200"
                >
                  <span>Explore</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${exploreOpen ? "rotate-180" : ""}`} />
                </button>
                {exploreOpen && (
                  <div className="absolute left-0 top-14 w-52 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-1.5 z-50">
                    <Link
                      href="/radar"
                      prefetch={false}
                      onClick={() => setExploreOpen(false)}
                      className={dropdownItemClass}
                    >
                      <Globe className="w-4 h-4 text-[#2563EB]" />
                      <span>3D Job Radar</span>
                    </Link>
                    <Link
                      href="/worldwide"
                      prefetch={false}
                      onClick={() => setExploreOpen(false)}
                      className={dropdownItemClass}
                    >
                      <Building className="w-4 h-4 text-[#475569]" />
                      <span>Companies Hiring</span>
                    </Link>
                  </div>
                )}
              </div>
            </nav>
          ) : (
            /* Public Guest Nav */
            <nav aria-label="Primary" className="hidden lg:flex flex-1 items-center justify-start ml-6 gap-1 h-full">
              <Link href="/jobs" prefetch={false} className={navLinkClass(isJobsActive)}>
                Jobs
              </Link>
              <Link href="/pricing" prefetch={false} className={navLinkClass(isPricingActive)}>
                Pricing
              </Link>
              <Link href="/remote" prefetch={false} className={navLinkClass(isResourcesActive)}>
                Resources
              </Link>
              <Link href="/worldwide" prefetch={false} className={navLinkClass(isWorldwideActive)}>
                Worldwide
              </Link>
              <Link href="/radar" prefetch={false} className={navLinkClass(isRadarActive)}>
                Radar
              </Link>
            </nav>
          )}

          {/* Right Action Buttons */}
          <div className="hidden lg:flex items-center gap-2 shrink-0">
            {user ? (
              /* User Account Dropdown */
              <div className="relative" ref={accountRef}>
                <button
                  type="button"
                  onClick={() => setAccountOpen(!accountOpen)}
                  aria-expanded={accountOpen}
                  aria-haspopup="true"
                  aria-label="Account menu"
                  className="flex items-center gap-2 pl-1 pr-2.5 h-10 rounded-full border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] transition-colors duration-200 cursor-pointer shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                >
                  <div className="w-8 h-8 rounded-full bg-[#2563EB] text-white font-bold text-xs flex items-center justify-center">
                    {userInitials}
                  </div>
                  {isPro && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#DCFCE7] text-[#16A34A]">
                      Pro
                    </span>
                  )}
                  <ChevronDown className="w-3.5 h-3.5 text-[#475569]" />
                </button>

                {accountOpen && (
                  <div className="absolute right-0 mt-2 w-60 bg-white border border-[#E2E8F0] rounded-[16px] shadow-lg p-2 z-50 divide-y divide-[#E2E8F0]">
                    <div className="px-3 py-2">
                      <p className="text-[11px] text-[#94A3B8] uppercase font-bold tracking-wider">Signed in as</p>
                      <p className="text-sm font-semibold text-[#0F172A] truncate">{user.email}</p>
                    </div>

                    <div className="py-1">
                      <Link
                        href="/settings?tab=preferences"
                        onClick={() => setAccountOpen(false)}
                        className={dropdownItemClass}
                      >
                        <Settings className="w-4 h-4" />
                        <span>Preferences</span>
                      </Link>
                      <Link
                        href="/settings?tab=notifications"
                        onClick={() => setAccountOpen(false)}
                        className={dropdownItemClass}
                      >
                        <Bell className="w-4 h-4" />
                        <span>Notifications</span>
                      </Link>
                      <Link
                        href="/settings?tab=billing"
                        onClick={() => setAccountOpen(false)}
                        className={dropdownItemClass}
                      >
                        <CreditCard className="w-4 h-4" />
                        <span>Billing</span>
                      </Link>
                    </div>

                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={handleSignOut}
                        className="w-full flex items-center gap-2.5 px-3 min-h-[40px] rounded-lg text-sm font-semibold text-[#DC2626] hover:bg-[#FEE2E2] text-left cursor-pointer transition-colors duration-200"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Public Guest Actions: "Log in" as ghost pill, "Get started" as primary blue pill */
              <>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center h-10 px-4 rounded-full text-[14px] font-medium text-[#0F172A] hover:bg-[#F1F5F9] transition-all duration-200 min-h-[44px] sm:min-h-[40px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center h-10 px-5 rounded-full text-[14px] font-medium bg-[#2563EB] text-white hover:bg-[#1D4ED8] active:bg-[#1E40AF] transition-all duration-200 min-h-[44px] sm:min-h-[40px] shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1"
                >
                  Get started
                </Link>
              </>
            )}
          </div>

          {/* Mobile Hamburger Button */}
          <div className="flex items-center lg:hidden">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              className="inline-flex items-center justify-center w-11 h-11 rounded-full text-[#0F172A] hover:bg-[#F1F5F9] transition-colors cursor-pointer"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </div>
      </header>

      {/* =================================================================== */}
      {/* MOBILE FULL-HEIGHT DRAWER (0.3s slide-in from right)                */}
      {/* =================================================================== */}
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={() => setDrawerOpen(false)}
        className={`fixed inset-0 bg-[#0F172A]/60 z-50 transition-opacity duration-300 lg:hidden ${
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Drawer */}
      <div
        id="mobile-nav-drawer"
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-[320px] bg-white h-full shadow-2xl flex flex-col justify-between p-6 transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] lg:hidden ${
          drawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="space-y-6">
          {/* Drawer Header: Logo + Close */}
          <div className="flex items-center justify-between pb-4 border-b border-[#E2E8F0]">
            <Link
              href={user ? "/dashboard" : "/"}
              onClick={() => setDrawerOpen(false)}
              className="flex items-center gap-2"
            >
              <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0]">
                <BrandIcon className="w-6 h-6" />
              </div>
              <span className="text-lg font-bold text-[#2563EB] tracking-tight">CareerMonke</span>
            </Link>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation menu"
              className="inline-flex items-center justify-center w-10 h-10 rounded-full text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Drawer Links */}
          <nav aria-label="Mobile" className="space-y-1">
            {user ? (
              <>
                <Link href="/dashboard" onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isDashboardActive)}>
                  Dashboard
                </Link>
                <Link href="/jobs" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isJobsActive)}>
                  Jobs
                </Link>
                <Link href="/resume" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isResumeActive)}>
                  ATS Resume
                </Link>
                <Link href="/applications" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isApplicationsActive)}>
                  Applications
                </Link>
                <Link href="/remote" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isResourcesActive)}>
                  Resources
                </Link>
                <Link href="/pricing" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isPricingActive)}>
                  Pricing
                </Link>
                <Link href="/radar" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isRadarActive)}>
                  3D Job Radar
                </Link>
                <Link href="/worldwide" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isWorldwideActive)}>
                  Companies Hiring
                </Link>
              </>
            ) : (
              <>
                <Link href="/jobs" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isJobsActive)}>
                  Jobs
                </Link>
                <Link href="/pricing" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isPricingActive)}>
                  Pricing
                </Link>
                <Link href="/remote" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isResourcesActive)}>
                  Resources
                </Link>
                <Link href="/worldwide" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isWorldwideActive)}>
                  Worldwide Remote
                </Link>
                <Link href="/radar" prefetch={false} onClick={() => setDrawerOpen(false)} className={drawerLinkClass(isRadarActive)}>
                  3D Job Radar
                </Link>
              </>
            )}
          </nav>
        </div>

        {/* Drawer Bottom Actions */}
        <div className="pt-6 border-t border-[#E2E8F0] space-y-2">
          {user ? (
            <div className="space-y-2">
              <div className="px-2 py-1 text-xs text-[#94A3B8] truncate">
                Signed in as <span className="font-semibold text-[#0F172A]">{user.email}</span>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full h-11 rounded-full border border-[#CBD5E1] text-[#DC2626] hover:bg-[#FEE2E2] flex items-center justify-center font-medium text-[14px] transition-colors cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <>
              <Link
                href="/login"
                onClick={() => setDrawerOpen(false)}
                className="w-full h-11 rounded-full border border-[#CBD5E1] text-[#0F172A] hover:bg-[#F1F5F9] flex items-center justify-center font-medium text-[14px] transition-colors"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                onClick={() => setDrawerOpen(false)}
                className="w-full h-11 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white flex items-center justify-center font-medium text-[14px] shadow-sm transition-colors"
              >
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}
