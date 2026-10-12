"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  Users,
  Eye,
  UserCheck,
  Crown,
  RefreshCw,
  ExternalLink,
  ArrowUpRight,
} from "lucide-react";
import type { AnalyticsStats } from "@/lib/admin/analytics";

export default function AdminDashboardPage() {
  const [rangeDays, setRangeDays] = useState<7 | 30>(7);
  const [loading, setLoading] = useState<boolean>(true);
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async (days: 7 | 30) => {
    setLoading(true);
    setError(null);
    try {
      let token: string | undefined;
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          token = session.access_token;
        }
      } catch (_) {}

      const res = await fetch(`/api/admin/stats?days=${days}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Failed to load analytics (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (data.ok && data.stats) {
        setStats(data.stats);
      } else {
        throw new Error(data.error || "Invalid response structure");
      }
    } catch (err: any) {
      setError(err?.message || "Error loading analytics stats");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats(rangeDays);
  }, [rangeDays]);

  return (
    <div className="space-y-8">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Analytics Overview
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time page views, visitor metrics, and platform adoption.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* 7-day / 30-day Toggle */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <button
              onClick={() => setRangeDays(7)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                rangeDays === 7
                  ? "bg-slate-900 text-white shadow"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Last 7 Days
            </button>
            <button
              onClick={() => setRangeDays(30)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                rangeDays === 30
                  ? "bg-slate-900 text-white shadow"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Last 30 Days
            </button>
          </div>

          {/* Refresh Button */}
          <button
            onClick={() => fetchStats(rangeDays)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm"
            title="Refresh analytics data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Views */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Total Page Views
            </span>
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <Eye className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900">
              {loading ? "..." : (stats?.totalViews ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">past {rangeDays}d</span>
          </div>
        </div>

        {/* Card 2: Unique Visitors */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Unique Visitors
            </span>
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900">
              {loading ? "..." : (stats?.uniqueVisitors ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">past {rangeDays}d</span>
          </div>
        </div>

        {/* Card 3: Registered Users */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Total Users
            </span>
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <UserCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900">
              {loading ? "..." : (stats?.totalUsers ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">registered</span>
          </div>
        </div>

        {/* Card 4: Pro Users */}
        <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Pro Subscribers
            </span>
            <div className="p-2 bg-amber-50 text-amber-600 rounded-lg">
              <Crown className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-slate-900">
              {loading ? "..." : (stats?.totalProUsers ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">active</span>
          </div>
        </div>
      </div>

      {/* Main Tables Grid: Top Pages Ranked & Daily Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column (2 Cols): Top Pages Ranked */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">Top Pages Ranked</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Highest trafficked routes ranked by page views ({rangeDays}-day window)
              </p>
            </div>
            <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
              {stats?.topPages?.length || 0} pages tracked
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
                <tr>
                  <th scope="col" className="px-5 py-3 w-12 text-center">#</th>
                  <th scope="col" className="px-5 py-3">Page Path</th>
                  <th scope="col" className="px-5 py-3 text-right">Views</th>
                  <th scope="col" className="px-5 py-3 text-right">Unique</th>
                  <th scope="col" className="px-5 py-3 text-right w-36">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-slate-400 text-sm">
                      Loading page analytics...
                    </td>
                  </tr>
                ) : !stats?.topPages || stats.topPages.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-slate-400 text-sm">
                      No page views recorded in this window yet. Visit a page to record activity.
                    </td>
                  </tr>
                ) : (
                  stats.topPages.map((page, idx) => (
                    <tr key={page.path} className="hover:bg-slate-50/75 transition-colors">
                      <td className="px-5 py-3 text-xs font-mono text-slate-400 text-center">
                        {idx + 1}
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-900 flex items-center gap-1.5">
                        <span className="font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                          {page.path}
                        </span>
                        <a
                          href={page.path}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-400 hover:text-slate-600"
                        >
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </a>
                      </td>
                      <td className="px-5 py-3 text-right font-semibold text-slate-900">
                        {page.views.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-600 text-xs font-mono">
                        {page.uniqueVisitors.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 rounded-full"
                              style={{ width: `${Math.min(100, page.percentage)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-500 w-8 text-right">
                            {page.percentage}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column (1 Col): Daily Timeline breakdown */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-5 border-b border-slate-200">
            <h2 className="text-base font-bold text-slate-900">Daily Activity</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Traffic trends over the past {rangeDays} days
            </p>
          </div>

          <div className="p-5 flex-1 overflow-y-auto max-h-[420px] divide-y divide-slate-100">
            {loading ? (
              <div className="py-8 text-center text-slate-400 text-sm">Loading daily views...</div>
            ) : !stats?.dailyViews || stats.dailyViews.length === 0 ? (
              <div className="py-8 text-center text-slate-400 text-sm">No activity recorded.</div>
            ) : (
              stats.dailyViews.slice().reverse().map((day) => {
                const maxDay = Math.max(...(stats?.dailyViews.map((d) => d.views) || [1]), 1);
                const percent = Math.round((day.views / maxDay) * 100);

                return (
                  <div key={day.date} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-mono text-slate-600">{day.date}</span>
                      <span className="font-semibold text-slate-900">
                        {day.views} views{" "}
                        <span className="text-slate-400 font-normal">({day.uniqueVisitors} unique)</span>
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{ width: `${Math.max(day.views > 0 ? 5 : 0, percent)}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Section: Recent Signups */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900">Recent Signups</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Newly registered accounts on CareerMonke
            </p>
          </div>
          <Link
            href="/admin/users"
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800"
          >
            <span>View All Users</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
              <tr>
                <th scope="col" className="px-5 py-3">User Email</th>
                <th scope="col" className="px-5 py-3">Joined Date</th>
                <th scope="col" className="px-5 py-3">Last Active</th>
                <th scope="col" className="px-5 py-3">Subscription</th>
                <th scope="col" className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-400 text-sm">
                    Loading users...
                  </td>
                </tr>
              ) : !stats?.recentSignups || stats.recentSignups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-400 text-sm">
                    No users found.
                  </td>
                </tr>
              ) : (
                stats.recentSignups.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50/75 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{user.email}</div>
                      <div className="text-xs text-slate-400 font-mono">{user.id}</div>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600">
                      {new Date(user.createdAt).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600">
                      {user.lastSignInAt
                        ? new Date(user.lastSignInAt).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        : "Never"}
                    </td>
                    <td className="px-5 py-3">
                      {user.isBlocked ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
                          Blocked
                        </span>
                      ) : user.isPro ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">
                          <Crown className="w-3 h-3 text-amber-600" />
                          Pro Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                          Free Tier
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/users?q=${encodeURIComponent(user.email)}`}
                        className="text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition-colors"
                      >
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
