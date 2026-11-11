"use client";

import { useEffect, useState, useCallback } from "react";
import { formatCalendarDate } from "@/lib/date/format";
import {
  Clock,
  CheckCircle2,
  Ban,
  RefreshCw,
  Mail,
  AlertCircle,
  X,
} from "lucide-react";

export interface EarlyAccessRequestItem {
  email: string;
  created_at: string;
  status: "pending" | "approved" | "rejected";
  approved_at?: string | null;
  approved_by?: string | null;
}

interface ActionFeedback {
  type: "success" | "error";
  message: string;
  email?: string;
  notifySkipped?: boolean;
}

/**
 * Retrieves the admin Authorization header from Supabase session or local storage auth tokens.
 */
async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      return { Authorization: `Bearer ${session.access_token}` };
    }
  } catch (_) {}

  try {
    if (typeof window !== "undefined") {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("sb-") && key.includes("-auth-token")) {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            const token =
              parsed?.access_token ||
              (Array.isArray(parsed) ? parsed[0] : null);
            if (token) {
              return { Authorization: `Bearer ${token}` };
            }
          }
        }
      }
    }
  } catch (_) {}

  return {};
}

/**
 * Formats a requested timestamp into a human-readable string.
 */
function formatRequestedDate(dateStr?: string | null): string {
  if (!dateStr) return "—";
  return formatCalendarDate(dateStr, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EarlyAccessRequestsSection() {
  const [requests, setRequests] = useState<EarlyAccessRequestItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"pending" | "all">("pending");
  const [actionLoading, setActionLoading] = useState<{
    email: string;
    action: "approve" | "reject";
  } | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [notifySkippedEmails, setNotifySkippedEmails] = useState<Set<string>>(
    new Set()
  );

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const authHeaders = await getAuthHeader();
      const queryParam = statusFilter === "all" ? "all" : statusFilter;
      const res = await fetch(
        `/api/admin/early-access?status=${encodeURIComponent(queryParam)}&limit=100`,
        {
          headers: authHeaders,
        }
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(
          errJson?.error ||
            `Failed to load early access requests (HTTP ${res.status})`
        );
      }

      const json = await res.json();

      // Adapt to diverse response shapes from backend endpoints:
      // { requests: [...] }, { data: [...] }, { items: [...] }, or raw array [...]
      let rawList: any[] = [];
      if (Array.isArray(json)) {
        rawList = json;
      } else if (Array.isArray(json?.requests)) {
        rawList = json.requests;
      } else if (Array.isArray(json?.data)) {
        rawList = json.data;
      } else if (Array.isArray(json?.items)) {
        rawList = json.items;
      } else if (Array.isArray(json?.earlyAccessRequests)) {
        rawList = json.earlyAccessRequests;
      } else if (Array.isArray(json?.result)) {
        rawList = json.result;
      }

      const normalized: EarlyAccessRequestItem[] = rawList.map((item: any) => {
        const email = String(
          item.email || item.user_email || item.userEmail || item.address || ""
        ).trim();
        const created_at =
          item.created_at ||
          item.createdAt ||
          item.requested_at ||
          item.requestedAt ||
          item.date ||
          "";
        const rawStatus = String(item.status || "").toLowerCase();
        let status: "pending" | "approved" | "rejected" = "pending";
        if (rawStatus === "approved" || item.approved === true) {
          status = "approved";
        } else if (rawStatus === "rejected" || item.approved === false) {
          status = "rejected";
        }

        return {
          email,
          created_at,
          status,
          approved_at: item.approved_at || item.approvedAt || null,
          approved_by: item.approved_by || item.approvedBy || null,
        };
      });

      setRequests(normalized);
    } catch (err: any) {
      setError(err?.message || "Failed to load early access requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleAction = async (
    email: string,
    action: "approve" | "reject"
  ) => {
    setActionLoading({ email, action });
    setFeedback(null);

    try {
      const authHeaders = await getAuthHeader();
      let res: Response | null = null;
      let data: any = null;

      // 1. Primary endpoint: /api/admin/early-access/approve or /reject
      try {
        res = await fetch(`/api/admin/early-access/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({ email }),
        });
        data = await res.json().catch(() => null);
      } catch (_) {}

      // 2. Fallback endpoint: /api/admin/early-access with { action, email }
      if (!res || !res.ok) {
        const fallbackRes = await fetch("/api/admin/early-access", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({ action, email }),
        });
        const fallbackData = await fallbackRes.json().catch(() => null);
        if (fallbackRes.ok) {
          res = fallbackRes;
          data = fallbackData;
        } else if (!res) {
          res = fallbackRes;
          data = fallbackData;
        }
      }

      if (!res || !res.ok || (data && data.ok === false)) {
        const errMsg =
          data?.error ||
          data?.message ||
          `Failed to ${action} request (HTTP ${res?.status || "unknown"}).`;
        throw new Error(errMsg);
      }

      // Check whether notification was skipped (notify_skipped: true)
      const notifySkipped = Boolean(
        data?.notify_skipped === true ||
          data?.notifySkipped === true ||
          data?.metadata?.notify_skipped === true
      );

      if (notifySkipped) {
        setNotifySkippedEmails((prev) => new Set(prev).add(email.toLowerCase()));
      }

      setFeedback({
        type: "success",
        message:
          action === "approve"
            ? `Successfully approved ${email}.`
            : `Successfully rejected ${email}.`,
        email,
        notifySkipped,
      });

      // Refresh after action
      await fetchRequests();
    } catch (err: any) {
      setFeedback({
        type: "error",
        message: err?.message || `Failed to ${action} early access request.`,
        email,
      });
    } finally {
      setActionLoading(null);
    }
  };

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Card Header */}
      <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900">
              Early access requests
            </h2>
            {pendingCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                {pendingCount} pending
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Review and manage pending early access waitlist requests.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Status Filter Toggle */}
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <button
              onClick={() => setStatusFilter("pending")}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                statusFilter === "pending"
                  ? "bg-slate-900 text-white shadow"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Pending
            </button>
            <button
              onClick={() => setStatusFilter("all")}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                statusFilter === "all"
                  ? "bg-slate-900 text-white shadow"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              All
            </button>
          </div>

          {/* Refresh Button */}
          <button
            onClick={fetchRequests}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm"
            title="Refresh early access requests"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Action Feedback Banner */}
      {feedback && (
        <div
          className={`px-5 py-3 border-b text-xs flex items-center justify-between ${
            feedback.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span>{feedback.message}</span>
            {feedback.notifySkipped && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                email not sent
              </span>
            )}
          </div>
          <button
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
            aria-label="Dismiss feedback"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="m-5 rounded-lg bg-red-50 p-4 border border-red-200 text-xs text-red-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={fetchRequests}
            className="text-xs font-semibold text-red-700 hover:text-red-900 underline ml-3"
          >
            Retry
          </button>
        </div>
      )}

      {/* Requests Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
            <tr>
              <th scope="col" className="px-5 py-3">
                User Email
              </th>
              <th scope="col" className="px-5 py-3">
                Requested Date
              </th>
              <th scope="col" className="px-5 py-3">
                Status
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-5 py-8 text-center text-slate-400 text-sm"
                >
                  <div className="flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-slate-400" />
                    <span>Loading early access requests...</span>
                  </div>
                </td>
              </tr>
            ) : requests.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-5 py-8 text-center text-slate-400 text-sm"
                >
                  {statusFilter === "pending"
                    ? "No pending early access requests."
                    : "No early access requests found."}
                </td>
              </tr>
            ) : (
              requests.map((item) => {
                const isProcessing = actionLoading?.email === item.email;
                const isApproving =
                  isProcessing && actionLoading?.action === "approve";
                const isRejecting =
                  isProcessing && actionLoading?.action === "reject";
                const hasNotifySkipped = notifySkippedEmails.has(
                  item.email.toLowerCase()
                );

                return (
                  <tr
                    key={item.email}
                    className="hover:bg-slate-50/75 transition-colors"
                  >
                    {/* User Email */}
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-900 flex items-center gap-1.5 flex-wrap">
                        <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span>{item.email}</span>
                        {hasNotifySkipped && (
                          <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                            email not sent
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Requested Date */}
                    <td className="px-5 py-3.5 text-xs text-slate-600 font-mono">
                      {formatRequestedDate(item.created_at)}
                    </td>

                    {/* Status */}
                    <td className="px-5 py-3.5">
                      {item.status === "approved" ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                          Approved
                        </span>
                      ) : item.status === "rejected" ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                          <Ban className="w-3 h-3 text-red-600" />
                          Rejected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          <Clock className="w-3 h-3 text-amber-500" />
                          Pending
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {item.status !== "approved" && (
                          <button
                            onClick={() => handleAction(item.email, "approve")}
                            disabled={isProcessing}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                            title={`Approve early access for ${item.email}`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>
                              {isApproving ? "Approving..." : "Approve"}
                            </span>
                          </button>
                        )}
                        {item.status !== "rejected" && (
                          <button
                            onClick={() => handleAction(item.email, "reject")}
                            disabled={isProcessing}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                            title={`Reject early access for ${item.email}`}
                          >
                            <Ban className="w-3.5 h-3.5" />
                            <span>
                              {isRejecting ? "Rejecting..." : "Reject"}
                            </span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
