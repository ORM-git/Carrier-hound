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

export default function GuideHeader() {
  const pathname = usePathname();
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const exploreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

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
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
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

  return (
    <>
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-gray-100 shadow-2xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Left: Brand */}
        <Link href={user ? "/dashboard" : "/"} className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 shadow-xs border border-gray-100">
            <BrandIcon className="w-7 h-7" />
          </div>
          <span className="text-xl font-black text-blue-600 tracking-tight">CareerMonke</span>
        </Link>

        {/* =================================================================== */}
        {/* DESKTOP NAV: AUTHENTICATED USER                                      */}
        {/* =================================================================== */}
        {user ? (
          <nav className="hidden md:flex items-center gap-1 sm:gap-2">
            <Link
              href="/dashboard"
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold transition ${
                pathname === "/dashboard"
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Dashboard
            </Link>

            <Link
              href="/jobs"
              prefetch={false}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold transition ${
                pathname === "/jobs" || pathname?.startsWith("/job-search")
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Jobs
            </Link>

            <Link
              href="/resume"
              prefetch={false}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold transition ${
                pathname === "/resume"
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              ATS Resume
            </Link>

            <Link
              href="/applications"
              prefetch={false}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold transition ${
                pathname === "/applications" || pathname === "/tracker"
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Applications
            </Link>

            <Link
              href="/remote"
              prefetch={false}
              className={`px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold transition ${
                pathname?.startsWith("/remote")
                  ? "bg-blue-50 text-blue-600"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              Resources
            </Link>

            {/* Explore Dropdown: Radar & Companies */}
            <div className="relative" ref={exploreRef}>
              <button
                type="button"
                onClick={() => setExploreOpen(!exploreOpen)}
                className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition cursor-pointer"
              >
                <span>Explore</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${exploreOpen ? "rotate-180" : ""}`} />
              </button>

              {exploreOpen && (
                <div className="absolute left-0 mt-1 w-48 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-50 animate-fadeIn">
                  <Link
                    href="/radar"
                    prefetch={false}
                    onClick={() => setExploreOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                  >
                    <Globe className="w-4 h-4 text-cyan-600" />
                    <span>3D Job Radar</span>
                  </Link>
                  <Link
                    href="/worldwide"
                    prefetch={false}
                    onClick={() => setExploreOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                  >
                    <Building className="w-4 h-4 text-slate-500" />
                    <span>Companies Hiring</span>
                  </Link>
                </div>
              )}
            </div>

            {/* Account Dropdown */}
            <div className="relative ml-2" ref={accountRef}>
              <button
                type="button"
                onClick={() => setAccountOpen(!accountOpen)}
                className="flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-full border border-slate-200 bg-white hover:bg-slate-50 transition cursor-pointer shadow-2xs"
              >
                <div className="w-7 h-7 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center">
                  {userInitials}
                </div>
                {isPro && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    Pro
                  </span>
                )}
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {accountOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-2xl shadow-xl py-2 z-50 animate-fadeIn divide-y divide-slate-100">
                  <div className="px-4 py-2">
                    <p className="text-[11px] text-slate-400 uppercase font-bold tracking-wider">Signed in as</p>
                    <p className="text-xs font-semibold text-slate-900 truncate">{user.email}</p>
                  </div>

                  <div className="py-1">
                    <Link
                      href="/settings?tab=preferences"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      <span>Preferences</span>
                    </Link>
                    <Link
                      href="/settings?tab=notifications"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>Notifications</span>
                    </Link>
                    <Link
                      href="/settings?tab=billing"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                    >
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>Billing</span>
                    </Link>
                    <a
                      href="mailto:support@careermonke.com"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-blue-600"
                    >
                      <HelpCircle className="w-3.5 h-3.5" />
                      <span>Help & Support</span>
                    </a>
                  </div>

                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 text-left cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </nav>
        ) : (
          /* =================================================================== */
          /* DESKTOP NAV: PUBLIC GUEST                                            */
          /* =================================================================== */
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/remote" className="text-sm font-medium text-slate-600 hover:text-blue-600 transition">
              Resources
            </Link>
            <Link href="/login" className="text-sm font-semibold text-slate-700 hover:text-blue-600 px-3 py-2 transition">
              Sign In
            </Link>
            <Link
              href="/signup"
              className="inline-flex items-center justify-center bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.98] text-white px-4 py-2.5 min-h-[40px] rounded-xl text-sm font-bold transition shadow-xs cursor-pointer"
            >
              <span>Get started</span>
            </Link>
          </nav>
        )}

        {/* Mobile Hamburger Menu button */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-xl border border-slate-200 text-xs font-bold text-slate-700 bg-white shadow-2xs active:bg-slate-100"
          >
            <Menu className="w-4 h-4" />
            <span>Menu</span>
          </button>
        </div>
      </div>
    </header>

    {/* =================================================================== */}
    {/* MOBILE DRAWER: OUTSIDE HEADER TO PREVENT 64PX BACKDROP-FILTER CLIPPING */}
    {/* =================================================================== */}
    {mobileMenuOpen && (
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex justify-end md:hidden animate-fadeIn">
        <div className="w-full max-w-xs bg-white h-dvh min-h-screen shadow-2xl p-6 pb-28 sm:pb-24 flex flex-col justify-between overflow-y-auto">
          <div className="space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-gray-100">
              <Link
                href={user ? "/dashboard" : "/"}
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-2"
              >
                <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-xs p-0.5 border border-gray-100">
                  <BrandIcon className="w-7 h-7" />
                </div>
                <span className="font-bold text-lg text-blue-600">CareerMonke</span>
              </Link>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {user ? (
              <div className="space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-3 pb-1">
                  Main Navigation
                </div>
                <Link
                  href="/dashboard"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <LayoutDashboard className="w-4 h-4 text-blue-600" />
                  <span>Dashboard</span>
                </Link>
                <Link
                  href="/jobs"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <Briefcase className="w-4 h-4 text-blue-600" />
                  <span>Jobs</span>
                </Link>
                <Link
                  href="/resume"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span>ATS Resume</span>
                </Link>
                <Link
                  href="/applications"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <CheckSquare className="w-4 h-4 text-blue-600" />
                  <span>Applications</span>
                </Link>
                <Link
                  href="/remote"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <BookOpen className="w-4 h-4 text-blue-600" />
                  <span>Resources</span>
                </Link>

                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-3 pb-1">
                  Explore
                </div>
                <Link
                  href="/radar"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-semibold text-slate-700"
                >
                  <Globe className="w-4 h-4 text-cyan-600" />
                  <span>3D Job Radar</span>
                </Link>
                <Link
                  href="/worldwide"
                  prefetch={false}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 text-xs font-semibold text-slate-700"
                >
                  <Building className="w-4 h-4 text-slate-500" />
                  <span>Companies Hiring</span>
                </Link>

                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-3 pt-3 pb-1">
                  Account & Settings
                </div>
                <Link
                  href="/settings?tab=preferences"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 text-xs font-medium text-slate-700"
                >
                  <Settings className="w-4 h-4 text-slate-400" />
                  <span>Preferences</span>
                </Link>
                <Link
                  href="/settings?tab=billing"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 text-xs font-medium text-slate-700"
                >
                  <CreditCard className="w-4 h-4 text-slate-400" />
                  <span>Billing</span>
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                <Link
                  href="/remote"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-3 py-2 rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Resources
                </Link>
              </div>
            )}
          </div>

          <div className="pt-4 pb-8 border-t border-gray-100">
            {user ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-slate-100 hover:bg-red-50 text-red-600 font-bold text-xs transition cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            ) : (
              <div className="space-y-2.5 pb-6">
                <Link
                  href="/signup"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white py-3.5 rounded-xl font-bold text-xs shadow-xs transition"
                >
                  Get Started Free
                </Link>
                <Link
                  href="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full flex items-center justify-center border border-slate-300 hover:bg-slate-50 bg-white text-slate-800 py-3 rounded-xl font-bold text-xs shadow-2xs transition"
                >
                  Sign In
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    )}
  </>
  );
}
