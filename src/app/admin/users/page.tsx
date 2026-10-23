"use client";

import { useEffect, useState } from "react";
import {
  Users,
  Search,
  RefreshCw,
  Crown,
  ShieldAlert,
  ShieldCheck,
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  X,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { UserManagementItem, PageViewRecord } from "@/lib/admin/analytics";

const USERS_PER_PAGE = 25;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserManagementItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filter, setFilter] = useState<"all" | "pro" | "free" | "blocked">("all");
  const [page, setPage] = useState<number>(1);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // User activity modal state
  const [selectedUser, setSelectedUser] = useState<UserManagementItem | null>(null);
  const [activity, setActivity] = useState<PageViewRecord[]>([]);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);
  const [activitySummary, setActivitySummary] = useState<{
    views24h: number;
    views7d: number;
    totalRecordedViews: number;
  } | null>(null);

  // Block modal confirmation state
  const [blockingUser, setBlockingUser] = useState<UserManagementItem | null>(null);
  const [blockReason, setBlockReason] = useState<string>("");

  const getAuthHeader = async (): Promise<Record<string, string>> => {
    try {
      if (typeof window !== "undefined") {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("sb-") && key.includes("-auth-token")) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              const token = parsed?.access_token || (Array.isArray(parsed) ? parsed[0] : null);
              if (token) {
                return { Authorization: `Bearer ${token}` };
              }
            }
          }
        }
      }
    } catch (_) {}

    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        return { Authorization: `Bearer ${session.access_token}` };
      }
    } catch (_) {}
    return {};
  };

  const fetchUsers = async (q: string = "") => {
    setLoading(true);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, {
        headers: authHeader,
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.users)) {
        setUsers(data.users);
        setPage(1);
      }
    } catch (_) {
      setFeedbackMsg({ type: "error", text: "Failed to load users list." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q") || "";
      if (q) {
        setSearchQuery(q);
        fetchUsers(q);
        return;
      }
    }
    fetchUsers();
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchUsers(searchQuery);
  };

  const openActivity = async (user: UserManagementItem) => {
    setSelectedUser(user);
    setActivityLoading(true);
    setActivity([]);
    setActivitySummary(null);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(`/api/admin/users/activity?userId=${user.id}`, {
        headers: authHeader,
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.activity)) {
        setActivity(data.activity);
        if (data.summary) {
          setActivitySummary(data.summary);
        }
      }
    } catch (_) {
      //
    } finally {
      setActivityLoading(false);
    }
  };

  const handleBlockAction = async (user: UserManagementItem, action: "block" | "unblock", reason?: string) => {
    setActionLoadingId(user.id);
    setFeedbackMsg(null);
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch("/api/admin/users/block", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          userId: user.id,
          action,
          reason: reason || "Administrative action",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to update user block status");
      }

      setFeedbackMsg({
        type: "success",
        text: data.message || (action === "block" ? "User blocked successfully." : "User unblocked successfully."),
      });

      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, isBlocked: action === "block" } : u))
      );
      if (blockingUser?.id === user.id) {
        setBlockingUser(null);
        setBlockReason("");
      }
    } catch (err: any) {
      setFeedbackMsg({ type: "error", text: err?.message || "Action failed." });
    } finally {
      setActionLoadingId(null);
    }
  };

  const filteredUsers = users.filter((u) => {
    if (filter === "pro") return u.isPro;
    if (filter === "free") return !u.isPro;
    if (filter === "blocked") return u.isBlocked;
    return true;
  });

  // Bounded pagination logic
  const totalFiltered = filteredUsers.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / USERS_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (safePage - 1) * USERS_PER_PAGE;
  const paginatedUsers = filteredUsers.slice(startIdx, startIdx + USERS_PER_PAGE);

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            User Management
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Search registered users, inspect page journeys, and manage access permissions.
          </p>
        </div>

        <button
          onClick={() => fetchUsers(searchQuery)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {feedbackMsg && (
        <div
          className={`p-4 rounded-lg text-sm border flex items-center justify-between ${
            feedbackMsg.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          <span>{feedbackMsg.text}</span>
          <button
            onClick={() => setFeedbackMsg(null)}
            className="text-slate-400 hover:text-slate-600 text-xs ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Controls: Search and Filters */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        {/* Search Bar */}
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            aria-label="Search users by email address"
            placeholder="Search users by email address..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="w-full pl-9 pr-20 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent shadow-sm"
          />
          <button
            type="submit"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800"
          >
            Search
          </button>
        </form>

        {/* Filter Pills */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm self-start">
          <button
            onClick={() => {
              setFilter("all");
              setPage(1);
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "all" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            All ({users.length})
          </button>
          <button
            onClick={() => {
              setFilter("pro");
              setPage(1);
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "pro" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Pro ({users.filter((u) => u.isPro).length})
          </button>
          <button
            onClick={() => {
              setFilter("free");
              setPage(1);
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "free" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Free ({users.filter((u) => !u.isPro).length})
          </button>
          <button
            onClick={() => {
              setFilter("blocked");
              setPage(1);
            }}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "blocked" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Blocked ({users.filter((u) => u.isBlocked).length})
          </button>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
              <tr>
                <th scope="col" className="px-5 py-3.5">User Email</th>
                <th scope="col" className="px-5 py-3.5">Signup Date</th>
                <th scope="col" className="px-5 py-3.5">Plan</th>
                <th scope="col" className="px-5 py-3.5">Last Active</th>
                <th scope="col" className="px-5 py-3.5 text-center">Page Views</th>
                <th scope="col" className="px-5 py-3.5">Status</th>
                <th scope="col" className="px-5 py-3.5 text-right">Moderation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-slate-400 text-sm">
                    Loading users...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-slate-400 text-sm">
                    No users matching criteria.
                  </td>
                </tr>
              ) : (
                paginatedUsers.map((user) => {
                  const isAdminUser = user.email === "xbsuryakant@gmail.com";
                  const isProcessing = actionLoadingId === user.id;

                  return (
                    <tr key={user.id} className="hover:bg-slate-50/75 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-slate-900 flex items-center gap-2">
                          <span>{user.email}</span>
                          {isAdminUser && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 uppercase">
                              Admin
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">{user.id}</div>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600">
                        {user.createdAt ? (
                          new Date(user.createdAt).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        ) : (
                          <span className="text-slate-400 italic">Unavailable</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {user.isPro ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                            <Crown className="w-3 h-3 text-amber-600" />
                            Pro
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                            Free
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600">
                        {user.lastSignInAt ? (
                          new Date(user.lastSignInAt).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        ) : (
                          <span className="text-slate-400 italic">Unavailable</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        <button
                          onClick={() => openActivity(user)}
                          className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors"
                          title="Click to view visited pages"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>{user.totalViews} views</span>
                        </button>
                      </td>
                      <td className="px-5 py-3.5">
                        {user.isBlocked ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                            <Ban className="w-3 h-3" />
                            Blocked
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            Active
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {isAdminUser ? (
                          <span className="text-xs text-slate-400 italic">Protected</span>
                        ) : user.isBlocked ? (
                          <button
                            onClick={() => handleBlockAction(user, "unblock")}
                            disabled={isProcessing}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            <span>{isProcessing ? "Updating..." : "Unblock"}</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => setBlockingUser(user)}
                            disabled={isProcessing}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            <span>{isProcessing ? "Updating..." : "Block"}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Bounded Pagination Controls */}
        {totalFiltered > 0 && (
          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              Showing <span className="font-semibold text-slate-900">{startIdx + 1}</span> to{" "}
              <span className="font-semibold text-slate-900">{Math.min(startIdx + USERS_PER_PAGE, totalFiltered)}</span> of{" "}
              <span className="font-semibold text-slate-900">{totalFiltered}</span> users
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Previous</span>
              </button>
              <span className="font-semibold text-slate-900 px-2">
                Page {safePage} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
                aria-label="Next page"
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* User Activity Modal */}
      {selectedUser && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        >
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">User Usage & Activity Summary</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Page journeys and usage metrics for <span className="font-semibold text-slate-800">{selectedUser.email}</span>
                </p>
              </div>
              <button
                onClick={() => setSelectedUser(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 flex-1 overflow-y-auto space-y-4">
              {/* 24h & 7d Usage Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Past 24h</div>
                  <div className="text-lg font-bold text-slate-900 mt-1">
                    {activitySummary ? activitySummary.views24h : "..."}{" "}
                    <span className="text-xs font-normal text-slate-500">views</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Past 7d</div>
                  <div className="text-lg font-bold text-slate-900 mt-1">
                    {activitySummary ? activitySummary.views7d : "..."}{" "}
                    <span className="text-xs font-normal text-slate-500">views</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">All-Time</div>
                  <div className="text-lg font-bold text-slate-900 mt-1">
                    {selectedUser.totalViews}{" "}
                    <span className="text-xs font-normal text-slate-500">views</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Status</div>
                  <div className="mt-1 flex items-center">
                    {selectedUser.isBlocked ? (
                      <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded">Blocked</span>
                    ) : (
                      <span className="text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">Active</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Telemetry Disclosures */}
              <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  <span className="font-semibold">Telemetry Boundaries Notice:</span> Metrics reflect generic page visits from the <code className="font-mono text-[11px] bg-amber-100 px-1 py-0.5 rounded">page_views</code> table. Granular job searches, application outbound clicks, and individual AI completions are not recorded per account in the database. No synthetic abuse thresholds or automatic suspensions are enforced.
                </div>
              </div>

              {/* Individual Page Hits */}
              <div>
                <h4 className="text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wider">Recent Page Visits</h4>
                {activityLoading ? (
                  <div className="py-8 text-center text-slate-400 text-sm">
                    Loading activity log...
                  </div>
                ) : activity.length === 0 ? (
                  <div className="py-8 text-center text-slate-400 text-sm">
                    No individual page views recorded for this user yet.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                    {activity.map((entry, idx) => (
                      <div
                        key={idx}
                        className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded">
                            {entry.path}
                          </span>
                          {entry.referrer && (
                            <span className="text-slate-400 text-[11px] truncate max-w-xs" title={`Referrer: ${entry.referrer}`}>
                              via {entry.referrer}
                            </span>
                          )}
                        </div>
                        <div className="text-slate-500 font-mono text-[11px] flex items-center gap-1 shrink-0">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{new Date(entry.created_at).toLocaleString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-200 bg-slate-50 rounded-b-xl flex justify-between items-center text-xs text-slate-500">
              <span>Showing {activity.length} recent page hits</span>
              <button
                onClick={() => setSelectedUser(null)}
                className="px-4 py-2 bg-slate-900 text-white font-medium rounded-lg hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Block Confirmation Modal */}
      {blockingUser && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        >
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl border border-red-200">
            <div className="flex items-center gap-3 text-red-600 mb-3">
              <div className="p-2 bg-red-100 rounded-full">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-lg font-bold text-slate-900">Block User Account</h3>
            </div>

            <p className="text-sm text-slate-600 mb-4 leading-relaxed">
              Are you sure you want to block <span className="font-semibold text-slate-900">{blockingUser.email}</span>?
              This will immediately revoke all active sessions and lock them out of CareerMonke.
            </p>

            <div className="mb-4">
              <label htmlFor="block-reason-input" className="block text-xs font-semibold text-slate-700 mb-1.5">
                Reason for suspension (optional)
              </label>
              <textarea
                id="block-reason-input"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder="e.g. Terms violation, scrapers, fraudulent activity..."
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500"
                rows={3}
              />
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setBlockingUser(null);
                  setBlockReason("");
                }}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleBlockAction(blockingUser, "block", blockReason)}
                disabled={actionLoadingId === blockingUser.id}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition-colors disabled:opacity-50"
              >
                {actionLoadingId === blockingUser.id ? "Blocking..." : "Confirm & Block"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
