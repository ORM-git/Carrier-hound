"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import { useSidebarMode } from "@/lib/sidebar";
import { useCookieNoticeHeight } from "@/components/CookieNotice";
import {
  LayoutDashboard,
  Briefcase,
  FileText,
  User as UserIcon,
  CheckSquare,
  Globe,
  CreditCard,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "jobs",
    label: "Jobs",
    href: "/jobs",
    icon: Briefcase,
    isActive: (p) => p === "/jobs" || p.startsWith("/job-search") || p.startsWith("/job-detail"),
  },
  {
    id: "Tracker",
    label: "Saved/Applied",
    href: "/tracker",
    icon: CheckSquare,
    isActive: (p) => p === "/tracker" || p === "/applications",
  },
  {
    id: "resume",
    label: "Resume",
    href: "/resume",
    icon: FileText,
    isActive: (p) => p === "/resume",
  },
  {
    id: "radar",
    label: "Radar",
    href: "/radar",
    icon: Globe,
    isActive: (p) => p === "/radar",
  },
  {
    id: "pricing",
    label: "Pricing",
    href: "/pricing",
    icon: CreditCard,
    isActive: (p) => p === "/pricing",
  },
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    isActive: (p) => p === "/dashboard",
  },
  {
    id: "profile",
    label: "Profile",
    href: "/profile",
    icon: UserIcon,
    isActive: (p) => p === "/profile",
  },
];

interface AppIconRailProps {
  currentRoute?: string;
}

export default function AppIconRail({ currentRoute }: AppIconRailProps) {
  const pathname = usePathname() || currentRoute || "/jobs";
  const { isExpanded, toggle } = useSidebarMode();
  const cookieNoticeHeight = useCookieNoticeHeight();
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);

  React.useEffect(() => {
    const handleDetailToggle = (e: any) => {
      setIsDetailOpen(Boolean(e.detail?.isOpen));
    };
    window.addEventListener("careermonke_detail_open", handleDetailToggle);
    return () => window.removeEventListener("careermonke_detail_open", handleDetailToggle);
  }, []);

  return (
    <>
      {/* ========================================================================= */}
      {/* DESKTOP SIDEBAR (DUAL-MODE: 72px NARROW RAIL vs 240px EXPANDED SIDEBAR)  */}
      {/* Smooth 300ms cubic-bezier transition, hidden on mobile (hidden md:flex)   */}
      {/* User-selected mode persisted via localStorage and reactive custom event   */}
      {/* ========================================================================= */}
      <aside
        data-testid="app-icon-rail"
        data-sidebar-mode={isExpanded ? "expanded" : "narrow"}
        className={`fixed left-0 top-0 bottom-0 bg-white border-r border-[#E2E8F0] z-40 hidden md:flex flex-col justify-between select-none transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)] ${
          isExpanded ? "w-[240px] py-3 px-3" : "w-[72px] py-3 items-center"
        }`}
      >
        <div className="flex flex-col items-center w-full">
          {/* =================================================================== */}
          {/* SIDEBAR HEADER: LOGO + ACCESSIBLE EXPAND / COLLAPSE TOGGLE         */}
          {/* =================================================================== */}
          {isExpanded ? (
            /* Expanded Mode Header: Brand Mark + CareerMonke Text + Collapse Button */
            <div className="flex items-center justify-between w-full pb-3 border-b border-[#E2E8F0] px-1">
              <Link
                href="/dashboard"
                aria-label="CareerMonke Dashboard"
                className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0] shadow-xs shrink-0">
                  <BrandIcon className="w-6 h-6" />
                </div>
                <span className="text-[17px] font-bold text-[#090E34] tracking-tight truncate">
                  Career<span className="text-[#2563EB]">Monke</span>
                </span>
              </Link>

              <button
                type="button"
                onClick={toggle}
                aria-label="Collapse sidebar"
                aria-expanded={true}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#090E34] hover:text-[#2563EB] hover:bg-[#EFF6FF] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <ChevronLeft className="w-5 h-5 stroke-[2]" />
              </button>
            </div>
          ) : (
            /* Narrow Mode Header: Logo Mark + Expand Button */
            <div className="flex flex-col items-center gap-2 w-full">
              <Link
                href="/dashboard"
                aria-label="CareerMonke Dashboard"
                className="w-12 h-12 flex items-center justify-center rounded-xl hover:bg-[#F8FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center p-0.5 border border-[#E2E8F0] shadow-xs shrink-0">
                  <BrandIcon className="w-6 h-6" />
                </div>
              </Link>

              <button
                type="button"
                onClick={toggle}
                aria-label="Expand sidebar"
                aria-expanded={false}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[#090E34] hover:text-[#2563EB] hover:bg-[#EFF6FF] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <ChevronRight className="w-4 h-4 stroke-[2]" />
              </button>
            </div>
          )}

          {/* =================================================================== */}
          {/* PRIMARY NAVIGATION ITEMS (Jobs, Saved/Applied, Resume, Radar, etc.) */}
          {/* =================================================================== */}
          <nav
            aria-label="Application Rail"
            className={
              isExpanded
                ? "flex flex-col gap-1.5 w-full mt-3"
                : "flex flex-col items-center gap-2 w-full px-2 mt-2"
            }
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.isActive(pathname);

              if (isExpanded) {
                /* Expanded Mode: Full-width row, 20px icon + 14px label, hover highlight */
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    className={`w-full h-[46px] flex items-center gap-3 px-3 rounded-[12px] transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 relative group ${
                      active
                        ? "bg-[#EFF6FF] text-[#2563EB] font-bold border-l-[3px] border-[#2563EB] shadow-xs hover:bg-[#DBEAFE]"
                        : "text-[#090E34] font-medium border-l-[3px] border-transparent hover:text-[#2563EB] hover:bg-[#F0F7FF] hover:border-[#93C5FD] hover:ring-1 hover:ring-[#BFDBFE]/50"
                    }`}
                  >
                    <Icon className={`w-5 h-5 stroke-[1.75] shrink-0 transition-colors ${
                      active ? "text-[#2563EB]" : "text-[#090E34] group-hover:text-[#2563EB]"
                    }`} />
                    <span className="text-[14px] leading-none tracking-tight">
                      {item.label}
                    </span>
                  </Link>
                );
              }

              /* Narrow Mode: 56x56px icon-over-label, 8px side inset (px-2), 64px pitch (gap-2) */
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={`w-[56px] h-[56px] flex flex-col items-center justify-center rounded-[12px] transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 relative group ${
                    active
                      ? "bg-[#EFF6FF] text-[#2563EB] font-bold shadow-xs hover:bg-[#DBEAFE] ring-1 ring-[#93C5FD] border border-[#BFDBFE]"
                      : "text-[#090E34] font-medium hover:text-[#2563EB] hover:bg-[#F0F7FF] hover:ring-1 hover:ring-[#BFDBFE]/60"
                  }`}
                >
                  <Icon className={`w-6 h-6 stroke-[1.75] transition-colors ${
                    active ? "text-[#2563EB]" : "text-[#090E34] group-hover:text-[#2563EB]"
                  }`} />
                  <span className={`text-[11px] leading-none mt-1 tracking-tight ${
                    active ? "font-bold text-[#1D4ED8]" : "font-medium text-[#090E34]"
                  }`}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* =================================================================== */}
        {/* BOTTOM OF SIDEBAR: FIXED SETTINGS LINK                              */}
        {/* =================================================================== */}
        <div
          className={
            isExpanded
              ? "flex flex-col gap-2 pt-2 border-t border-[#E2E8F0] w-full"
              : "flex flex-col items-center gap-2 pt-2 border-t border-[#E2E8F0] w-full px-2"
          }
        >
          {isExpanded ? (
            <Link
              href="/settings"
              aria-label="Settings"
              aria-current={pathname === "/settings" ? "page" : undefined}
              className={`w-full h-[46px] flex items-center gap-3 px-3 rounded-[12px] transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 relative group ${
                pathname === "/settings"
                  ? "bg-[#EFF6FF] text-[#2563EB] font-bold border-l-[3px] border-[#2563EB] shadow-xs hover:bg-[#DBEAFE]"
                  : "text-[#090E34] font-medium border-l-[3px] border-transparent hover:text-[#2563EB] hover:bg-[#F0F7FF] hover:border-[#93C5FD] hover:ring-1 hover:ring-[#BFDBFE]/50"
              }`}
            >
              <Settings className={`w-5 h-5 stroke-[1.75] shrink-0 transition-colors ${
                pathname === "/settings" ? "text-[#2563EB]" : "text-[#090E34] group-hover:text-[#2563EB]"
              }`} />
              <span className="text-[14px] leading-none tracking-tight">Settings</span>
            </Link>
          ) : (
            <Link
              href="/settings"
              aria-label="Settings"
              aria-current={pathname === "/settings" ? "page" : undefined}
              className={`w-[56px] h-[56px] flex items-center justify-center rounded-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 group ${
                pathname === "/settings"
                  ? "bg-[#EFF6FF] text-[#2563EB] shadow-xs hover:bg-[#DBEAFE] ring-1 ring-[#93C5FD] border border-[#BFDBFE]"
                  : "text-[#090E34] hover:text-[#2563EB] hover:bg-[#F0F7FF] hover:ring-1 hover:ring-[#BFDBFE]/60"
              }`}
            >
              <Settings className="w-5 h-5 stroke-[1.75] text-[#090E34] group-hover:text-[#2563EB] transition-colors" />
            </Link>
          )}
        </div>
      </aside>

      {/* ========================================================================= */}
      {/* MOBILE BOTTOM NAVIGATION BAR (Full-width, >=44px tap targets, offset by   */}
      {/* CookieNotice actual height and safe-area-inset-bottom, hidden on desktop) */}
      {/* ========================================================================= */}
      <nav
        aria-label="Mobile Navigation"
        data-testid="app-mobile-nav"
        style={{
          bottom: `${cookieNoticeHeight}px`,
        }}
        className={`fixed inset-x-0 h-16 bg-white border-t border-[#E2E8F0] z-40 items-center justify-around px-2 shadow-sm transition-[bottom] duration-200 ${
          isDetailOpen ? "hidden" : "flex md:hidden"
        }`}
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
                  ? "bg-[#EFF6FF] text-[#2563EB] font-bold ring-1 ring-[#93C5FD]/60"
                  : "text-[#090E34] hover:text-[#2563EB]"
              }`}
            >
              <Icon className="w-6 h-6 stroke-[1.75]" />
              <span className={`text-[11px] font-medium leading-none mt-1 tracking-tight ${
                active ? "font-bold text-[#1D4ED8]" : "font-medium text-[#090E34]"
              }`}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
