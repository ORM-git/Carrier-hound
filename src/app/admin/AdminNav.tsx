"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Shield, BarChart3, Users, FileText, ExternalLink } from "lucide-react";

export default function AdminNav({ adminEmail }: { adminEmail?: string }) {
  const pathname = usePathname();

  const isAnalytics = pathname === "/admin";
  const isUsers = pathname === "/admin/users";
  const isAuditLog = pathname === "/admin/audit-log";

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm w-full overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
        <div className="flex items-center space-x-2 sm:space-x-6 min-w-0">
          <div className="flex items-center space-x-1.5 sm:space-x-3 shrink-0">
            <Link href="/admin" className="font-extrabold text-base sm:text-lg tracking-tight text-slate-900">
              CareerMonke
            </Link>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-semibold bg-red-100 text-red-700 uppercase tracking-wider">
              <Shield className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-red-600" />
              Admin
            </span>
          </div>

          <nav className="flex space-x-0.5 sm:space-x-1 overflow-x-auto scrollbar-none" aria-label="Admin Navigation">
            <Link
              href="/admin"
              className={`inline-flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-colors shrink-0 ${
                isAnalytics
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500" />
              <span>Analytics</span>
            </Link>
            <Link
              href="/admin/users"
              className={`inline-flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-colors shrink-0 ${
                isUsers
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500" />
              <span>Users</span>
            </Link>
            <Link
              href="/admin/audit-log"
              className={`inline-flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-colors shrink-0 ${
                isAuditLog
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500" />
              <span className="hidden xs:inline">Audit Log</span>
              <span className="xs:hidden">Audit</span>
            </Link>
          </nav>
        </div>

        <div className="flex items-center space-x-2 sm:space-x-4 shrink-0">
          <span className="hidden md:inline-block text-xs text-slate-500 font-mono">
            {adminEmail}
          </span>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 px-2 py-1 sm:px-3 sm:py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 transition-colors"
          >
            <span className="hidden sm:inline">Exit to Site</span>
            <span className="sm:hidden">Exit</span>
            <ExternalLink className="w-3 h-3 text-slate-400" />
          </Link>
        </div>
      </div>
    </header>
  );
}
