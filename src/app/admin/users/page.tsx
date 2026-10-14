"use client";

import { useEffect, useState, useTransition } from "react";
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
} from "lucide-react";
import type { UserManagementItem, PageViewRecord } from "@/lib/admin/analytics";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserManagementItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filter, setFilter] = useState<"all" | "pro" | "free" | "blocked">("all");
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // User activity modal state
  const [selectedUser, setSelectedUser] = useState<UserManagementItem | null>(null);
  const [activity, setActivity] = useState<PageViewRecord[]>([]);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);

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
      }
    } catch (_) {
      setFeedbackMsg({ type: "error", text: "Failed to load users list." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // If URL has search query param
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
    try {
      const authHeader = await getAuthHeader();
      const res = await fetch(`/api/admin/users/activity?userId=${user.id}`, {
        headers: authHeader,
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.activity)) {
        setActivity(data.activity);
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

      // Update state locally
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
            onChange={(e) => setSearchQuery(e.target.value)}
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
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "all" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            All ({users.length})
          </button>
          <button
            onClick={() => setFilter("pro")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "pro" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Pro ({users.filter((u) => u.isPro).length})
          </button>
          <button
            onClick={() => setFilter("free")}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              filter === "free" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Free ({users.filter((u) => !u.isPro).length})
          </button>
          <button
            onClick={() => setFilter("blocked")}
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
                <th scope="col" className="px-5 py-3.5">Pro Status</th>
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
                filteredUsers.map((user) => {
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
                        {new Date(user.createdAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
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
                        {user.lastSignInAt
                          ? new Date(user.lastSignInAt).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })
                          : "Never"}
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
                <h3 className="text-base font-bold text-slate-900">User Activity Timeline</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Page journeys recorded for <span className="font-semibold text-slate-800">{selectedUser.email}</span>
                </p>
              </div>
              <button
                onClick={() => setSelectedUser(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 flex-1 overflow-y-auto">
              {activityLoading ? (
                <div className="py-12 text-center text-slate-400 text-sm">
                  Loading activity log...
                </div>
              ) : activity.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-sm">
                  No individual page views recorded for this user yet.
                </div>
              ) : (
                <div className="space-y-3">
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
                      <div className="text-slate-500 font-mono text-[11px] flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-400" />
                        <span>{new Date(entry.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Reason for suspension (optional)
              </label>
              <input
                type="text"
                aria-label="Reason for suspension (optional)"
                placeholder="e.g. Terms violation, scraping, suspicious activity"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setBlockingUser(null);
                  setBlockReason("");
                }}
                className="px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBlockAction(blockingUser, "block", blockReason)}
                disabled={actionLoadingId === blockingUser.id}
                className="px-4 py-2 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50"
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
