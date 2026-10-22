"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
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
  LayoutDashboard,
  Briefcase,
  FileText,
  CheckSquare,
  Globe,
  Building,
  User as UserIcon,
  Settings,
  Bell,
  CreditCard,
  HelpCircle,
  LogOut,
  Sparkles,
  BookOpen
} from "lucide-react";
import { cnTokens } from "@/components/ui/cn-tokens";
import { buttonClasses } from "@/components/ui/button";

/* Token-driven class helpers (Redesign PART 1) */
const desktopLinkClass = (active: boolean) =>
  cnTokens(
    "inline-flex items-center h-10 px-2.5 lg:px-3 rounded-tk-lg text-[13px] lg:text-tk-body-sm font-medium",
    "transition-colors duration-tk-fast ease-tk-standard",
    active ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:text-ink hover:bg-surface-muted"
  );

const dropdownItemClass =
  "flex items-center gap-2.5 px-3 min-h-[40px] rounded-tk-md text-tk-body-sm font-medium text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors duration-tk-fast";

const mobileLinkClass = (active: boolean) =>
  cnTokens(
    "flex items-center gap-3 px-3 min-h-[44px] rounded-tk-lg text-tk-body-sm font-semibold",
    "transition-colors duration-tk-fast",
    active ? "bg-brand-50 text-brand-700" : "text-ink hover:bg-surface-muted"
  );

const mobileSectionLabel =
  "px-3 pt-tk-2 pb-tk-half text-[11px] font-bold uppercase tracking-wider text-ink-subtle";

type MenuState = "closed" | "open" | "closing";

export default function GuideHeader() {
  const pathname = usePathname();
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [menuState, setMenuState] = useState<MenuState>("closed");
  const [exploreOpen, setExploreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const exploreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const mobileMenuOpen = menuState === "open";
  const mobileMenuMounted = menuState !== "closed";

  // Open/close the mobile panel. Closing plays a short ease-in exit before unmount.
  const setMobileMenuOpen = useCallback((open: boolean) => {
    setMenuState((prev) => (open ? "open" : prev === "open" ? "closing" : prev));
  }, []);

  useEffect(() => {
    if (menuState !== "closing") return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => setMenuState("closed"), reduceMotion ? 0 : 150);
    return () => window.clearTimeout(t);
  }, [menuState]);

  // Lock page scroll + Escape to close while the mobile panel is open.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileMenuOpen, setMobileMenuOpen]);

  // Subtle blur/elevation only once the page has scrolled.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
    setMobileMenuOpen(false);
    router.push("/");
  };

  const userInitials = (user?.email ? user.email.slice(0, 2).toUpperCase() : "CM");

  const isJobsActive = pathname === "/jobs" || Boolean(pathname?.startsWith("/job-search"));
  const isApplicationsActive = pathname === "/applications" || pathname === "/tracker";
  const isRemoteActive = Boolean(pathname?.startsWith("/remote"));
  const closeMobile = () => setMobileMenuOpen(false);

  return (
    <>
      <header
        className={cnTokens(
          "sticky top-0 z-tk-header border-b",
          "transition-[background-color,border-color,box-shadow] duration-tk-base ease-tk-standard",
          scrolled
            ? "bg-surface/80 backdrop-blur-md border-line shadow-tk-sm"
            : "bg-surface border-line/70"
        )}
      >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-tk-2">
        {/* Left: Brand */}
        <Link
          href={user ? "/dashboard" : "/"}
          className="flex items-center gap-2.5 shrink-0 min-h-[44px] rounded-tk-lg"
        >
          <div className="w-8 h-8 rounded-tk-full bg-surface flex items-center justify-center p-0.5 shadow-tk-xs border border-line">
            <BrandIcon className="w-7 h-7" />
          </div>
          <span className="text-xl font-black text-brand-600 tracking-tight">CareerMonke</span>
        </Link>

        {/* =================================================================== */}
        {/* DESKTOP NAV: AUTHENTICATED USER                                      */}
        {/* =================================================================== */}
        {user ? (
          <>
          <nav aria-label="Primary" className="hidden md:flex flex-1 items-center justify-center gap-0.5 lg:gap-1">
            <Link href="/dashboard" className={desktopLinkClass(pathname === "/dashboard")}>
              Dashboard
            </Link>

            <Link href="/jobs" prefetch={false} className={desktopLinkClass(isJobsActive)}>
              Jobs
            </Link>

            <Link href="/resume" prefetch={false} className={desktopLinkClass(pathname === "/resume")}>
              ATS Resume
            </Link>

            <Link href="/applications" prefetch={false} className={desktopLinkClass(isApplicationsActive)}>
              Applications
            </Link>

            <Link href="/remote" prefetch={false} className={desktopLinkClass(isRemoteActive)}>
              Resources
            </Link>

            <Link href="/pricing" prefetch={false} className={desktopLinkClass(pathname === "/pricing")}>
              Pricing
            </Link>

            {/* Explore Dropdown: Radar & Companies */}
            <div className="relative" ref={exploreRef}>
              <button
                type="button"
                onClick={() => setExploreOpen(!exploreOpen)}
                aria-expanded={exploreOpen}
                aria-haspopup="true"
                className={cnTokens(desktopLinkClass(false), "gap-1 cursor-pointer")}
              >
                <span>Explore</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-tk-fast ${exploreOpen ? "rotate-180" : ""}`}
                />
              </button>

              {exploreOpen && (
                <div className="absolute left-0 mt-2 w-52 bg-surface border border-line rounded-tk-xl shadow-tk-lg p-1.5 z-tk-dropdown motion-safe:animate-tk-slide-down-in">
                  <Link
                    href="/radar"
                    prefetch={false}
                    onClick={() => setExploreOpen(false)}
                    className={dropdownItemClass}
                  >
                    <Globe className="w-4 h-4 text-brand-600" />
                    <span>3D Job Radar</span>
                  </Link>
                  <Link
                    href="/worldwide"
                    prefetch={false}
                    onClick={() => setExploreOpen(false)}
                    className={dropdownItemClass}
                  >
                    <Building className="w-4 h-4 text-ink-subtle" />
                    <span>Companies Hiring</span>
                  </Link>
                </div>
              )}
            </div>
          </nav>

            {/* Account Dropdown */}
            <div className="relative hidden md:block shrink-0" ref={accountRef}>
              <button
                type="button"
                onClick={() => setAccountOpen(!accountOpen)}
                aria-expanded={accountOpen}
                aria-haspopup="true"
                aria-label="Account menu"
                className="flex items-center gap-2 pl-1 pr-2 h-10 rounded-tk-full border border-line bg-surface hover:bg-surface-muted transition-colors duration-tk-fast cursor-pointer shadow-tk-xs"
              >
                <div className="w-8 h-8 rounded-tk-full bg-brand-600 text-ink-inverse font-bold text-xs flex items-center justify-center">
                  {userInitials}
                </div>
                {isPro && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-tk-xs bg-success-100 text-success-700">
                    Pro
                  </span>
                )}
                <ChevronDown className="w-3.5 h-3.5 text-ink-subtle" />
              </button>

              {accountOpen && (
                <div className="absolute right-0 mt-2 w-60 bg-surface border border-line rounded-tk-xl shadow-tk-xl p-1.5 z-tk-dropdown motion-safe:animate-tk-slide-down-in divide-y divide-line">
                  <div className="px-3 py-2">
                    <p className="text-[11px] text-ink-subtle uppercase font-bold tracking-wider">Signed in as</p>
                    <p className="text-tk-body-sm font-semibold text-ink truncate">{user.email}</p>
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
                    <a
                      href="mailto:support@careermonke.com"
                      onClick={() => setAccountOpen(false)}
                      className={dropdownItemClass}
                    >
                      <HelpCircle className="w-4 h-4" />
                      <span>Help & Support</span>
                    </a>
                  </div>

                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2.5 px-3 min-h-[40px] rounded-tk-md text-tk-body-sm font-semibold text-danger-700 hover:bg-danger-50 text-left cursor-pointer transition-colors duration-tk-fast"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* =================================================================== */
          /* DESKTOP NAV: PUBLIC GUEST                                            */
          /* =================================================================== */
          <nav aria-label="Primary" className="hidden md:flex items-center gap-tk-1">
            <Link href="/pricing" className={desktopLinkClass(pathname === "/pricing")}>
              Pricing
            </Link>
            <Link href="/remote" className={desktopLinkClass(isRemoteActive)}>
              Resources
            </Link>
            <Link href="/login" className={buttonClasses({ variant: "ghost", size: "sm" })}>
              Sign In
            </Link>
            <Link href="/signup" className={buttonClasses({ variant: "primary", size: "sm", className: "px-tk-2" })}>
              <span>Get started</span>
            </Link>
          </nav>
        )}

        {/* Mobile Hamburger Menu button */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-nav-panel"
            className="inline-flex items-center justify-center w-11 h-11 rounded-tk-lg border border-line text-ink bg-surface shadow-tk-xs hover:bg-surface-muted active:bg-surface-sunken transition-colors duration-tk-fast cursor-pointer"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </header>

    {/* =================================================================== */}
    {/* MOBILE PANEL: OUTSIDE HEADER TO PREVENT 64PX BACKDROP-FILTER CLIPPING */}
    {/* Slides down beneath the 64px header; ease-in exit before unmount.     */}
    {/* =================================================================== */}
    {mobileMenuMounted && (
      <div className="fixed inset-x-0 top-16 bottom-0 z-tk-overlay md:hidden">
        {/* Backdrop */}
        <div
          role="presentation"
          onClick={closeMobile}
          className={cnTokens(
            "absolute inset-0 bg-ink/40",
            mobileMenuOpen ? "motion-safe:animate-tk-fade-in" : "motion-safe:animate-tk-fade-out opacity-0"
          )}
        />

        <div
          id="mobile-nav-panel"
          className={cnTokens(
            "relative bg-surface border-b border-line shadow-tk-xl rounded-b-tk-2xl",
            "max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain px-4 pt-tk-1 pb-tk-3",
            mobileMenuOpen ? "motion-safe:animate-tk-slide-down-in" : "motion-safe:animate-tk-slide-up-out opacity-0"
          )}
        >
          {user ? (
            <nav aria-label="Mobile" className="space-y-0.5">
              <div className={mobileSectionLabel}>Main Navigation</div>
              <Link href="/dashboard" onClick={closeMobile} className={mobileLinkClass(pathname === "/dashboard")}>
                <LayoutDashboard className="w-4 h-4 text-brand-600" />
                <span>Dashboard</span>
              </Link>
              <Link href="/jobs" prefetch={false} onClick={closeMobile} className={mobileLinkClass(isJobsActive)}>
                <Briefcase className="w-4 h-4 text-brand-600" />
                <span>Jobs</span>
              </Link>
              <Link href="/resume" prefetch={false} onClick={closeMobile} className={mobileLinkClass(pathname === "/resume")}>
                <FileText className="w-4 h-4 text-brand-600" />
                <span>ATS Resume</span>
              </Link>
              <Link href="/applications" prefetch={false} onClick={closeMobile} className={mobileLinkClass(isApplicationsActive)}>
                <CheckSquare className="w-4 h-4 text-brand-600" />
                <span>Applications</span>
              </Link>
              <Link href="/remote" prefetch={false} onClick={closeMobile} className={mobileLinkClass(isRemoteActive)}>
                <BookOpen className="w-4 h-4 text-brand-600" />
                <span>Resources</span>
              </Link>
              <Link href="/pricing" prefetch={false} onClick={closeMobile} className={mobileLinkClass(pathname === "/pricing")}>
                <CreditCard className="w-4 h-4 text-brand-600" />
                <span>Pricing</span>
              </Link>

              <div className={mobileSectionLabel}>Explore</div>
              <Link href="/radar" prefetch={false} onClick={closeMobile} className={mobileLinkClass(pathname === "/radar")}>
                <Globe className="w-4 h-4 text-brand-600" />
                <span>3D Job Radar</span>
              </Link>
              <Link href="/worldwide" prefetch={false} onClick={closeMobile} className={mobileLinkClass(pathname === "/worldwide")}>
                <Building className="w-4 h-4 text-ink-subtle" />
                <span>Companies Hiring</span>
              </Link>

              <div className={mobileSectionLabel}>Account & Settings</div>
              <Link href="/settings?tab=preferences" onClick={closeMobile} className={mobileLinkClass(false)}>
                <Settings className="w-4 h-4 text-ink-subtle" />
                <span>Preferences</span>
              </Link>
              <Link href="/settings?tab=billing" onClick={closeMobile} className={mobileLinkClass(false)}>
                <CreditCard className="w-4 h-4 text-ink-subtle" />
                <span>Billing</span>
              </Link>

              <div className="pt-tk-2 mt-tk-1 border-t border-line">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className={buttonClasses({
                    variant: "ghost",
                    size: "md",
                    fullWidth: true,
                    className: "text-danger-700 hover:bg-danger-50 hover:text-danger-700",
                  })}
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            </nav>
          ) : (
            <nav aria-label="Mobile" className="space-y-0.5 pt-tk-1">
              <Link href="/pricing" onClick={closeMobile} className={mobileLinkClass(pathname === "/pricing")}>
                Pricing
              </Link>
              <Link href="/remote" onClick={closeMobile} className={mobileLinkClass(isRemoteActive)}>
                Resources
              </Link>

              <div className="pt-tk-2 mt-tk-1 border-t border-line space-y-tk-1">
                <Link
                  href="/signup"
                  onClick={closeMobile}
                  className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
                >
                  Get Started Free
                </Link>
                <Link
                  href="/login"
                  onClick={closeMobile}
                  className={buttonClasses({
                    variant: "ghost",
                    size: "lg",
                    fullWidth: true,
                    className: "border border-line text-ink",
                  })}
                >
                  Sign In
                </Link>
              </div>
            </nav>
          )}
        </div>
      </div>
    )}
  </>
  );
}
