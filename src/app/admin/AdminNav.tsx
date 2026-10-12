"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Shield, BarChart3, Users, ExternalLink } from "lucide-react";

export default function AdminNav({ adminEmail }: { adminEmail?: string }) {
  const pathname = usePathname();

  const isAnalytics = pathname === "/admin";
  const isUsers = pathname === "/admin/users";

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-8">
          <div className="flex items-center space-x-3">
            <Link href="/admin" className="font-extrabold text-lg tracking-tight text-slate-900">
              CareerMonke
            </Link>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700 uppercase tracking-wider">
              <Shield className="w-3 h-3 text-red-600" />
              Admin
            </span>
          </div>

          <nav className="flex space-x-1" aria-label="Admin Navigation">
            <Link
              href="/admin"
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isAnalytics
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <BarChart3 className="w-4 h-4 text-slate-500" />
              Analytics
            </Link>
            <Link
              href="/admin/users"
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isUsers
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <Users className="w-4 h-4 text-slate-500" />
              Users
            </Link>
          </nav>
        </div>

        <div className="flex items-center space-x-4">
          <span className="hidden sm:inline-block text-xs text-slate-500 font-mono">
            {adminEmail}
          </span>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 transition-colors"
          >
            <span>Exit to Site</span>
            <ExternalLink className="w-3 h-3 text-slate-400" />
          </Link>
        </div>
      </div>
    </header>
  );
}
