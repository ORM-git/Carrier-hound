"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import {
  Briefcase,
  FileText,
  User as UserIcon,
  CheckSquare,
  Globe,
  Settings,
} from "lucide-react";

interface AppIconRailProps {
  currentRoute?: string;
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "jobs",
    label: "Jobs",
    href: "/jobs",
    icon: Briefcase,
    isActive: (p) => p === "/jobs" || p.startsWith("/job-search"),
  },
  {
    id: "resume",
    label: "Resume",
    href: "/resume",
    icon: FileText,
    isActive: (p) => p === "/resume",
  },
  {
    id: "profile",
    label: "Profile",
    href: "/profile",
    icon: UserIcon,
    isActive: (p) => p === "/profile",
  },
  {
    id: "tracker",
    label: "Tracker",
    href: "/tracker",
    icon: CheckSquare,
    isActive: (p) => p === "/tracker" || p === "/applications",
  },
  {
    id: "radar",
    label: "Radar",
    href: "/radar",
    icon: Globe,
    isActive: (p) => p === "/radar",
  },
];

export default function AppIconRail({ currentRoute }: AppIconRailProps) {
  const pathname = usePathname() || currentRoute || "/jobs";

  return (
    <>
      {/* ========================================================================= */}
      {/* 1. DESKTOP LEFT ICON RAIL (Fixed 72px wide, full height, white, #E2E8F0)   */}
      {/* ========================================================================= */}
      <aside
        data-testid="app-icon-rail"
        className="fixed left-0 top-0 bottom-0 w-[72px] bg-white border-r border-[#E2E8F0] z-40 hidden md:flex flex-col justify-between py-3 items-center select-none"
      >
        <div className="flex flex-col items-center w-full space-y-4">
          {/* Small CareerMonke Logo Mark at the top */}
          <Link
            href="/jobs"
            aria-label="CareerMonke Home"
            className="w-12 h-12 flex items-center justify-center rounded-xl hover:bg-[#F8FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
          >
            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0] shadow-xs shrink-0">
              <BrandIcon className="w-6 h-6" />
            </div>
          </Link>

          {/* Vertical Nav Items */}
          <nav aria-label="Application Rail" className="flex flex-col items-center gap-1.5 w-full">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.isActive(pathname);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={`w-[58px] h-[54px] flex flex-col items-center justify-center rounded-[12px] transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] ${
                    active
                      ? "bg-[#EFF6FF] text-[#2563EB]"
                      : "text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC]"
                  }`}
                >
                  <Icon className="w-6 h-6 stroke-[1.75]" />
                  <span className="text-[11px] font-medium leading-none mt-1 tracking-tight">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom of the rail (fixed): Settings Gear icon-only 20px */}
        <div className="flex flex-col items-center gap-2 pt-2 border-t border-[#E2E8F0] w-full px-2">
          <Link
            href="/settings"
            aria-label="Settings"
            className="w-10 h-10 flex items-center justify-center rounded-xl text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
          >
            <Settings className="w-5 h-5 stroke-[1.75]" />
          </Link>
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* 2. MOBILE BOTTOM TAB BAR (Full-width, 44px tap targets, same icons)        */}
      {/* ========================================================================= */}
      <nav
        aria-label="Mobile Navigation"
        data-testid="app-mobile-nav"
        className="fixed bottom-0 inset-x-0 h-16 bg-white border-t border-[#E2E8F0] z-40 flex md:hidden items-center justify-around px-2 shadow-sm"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.isActive(pathname);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={`flex-1 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center py-1 rounded-[12px] transition-all duration-200 ${
                active
                  ? "bg-[#EFF6FF] text-[#2563EB]"
                  : "text-[#64748B] hover:text-[#0F172A]"
              }`}
            >
              <Icon className="w-6 h-6 stroke-[1.75]" />
              <span className="text-[11px] font-medium leading-none mt-0.5 tracking-tight">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
