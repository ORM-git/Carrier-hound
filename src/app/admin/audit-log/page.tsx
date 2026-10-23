"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  Shield,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Clock,
  ChevronLeft,
  ChevronRight,
  Filter,
  Lock,
} from "lucide-react";
import type { AdminAuditLogEntry } from "@/lib/admin/auditLog";

const PAGE_SIZE = 20;

export default function AdminAuditLogPage() {
  const [entries, setEntries] = useState<AdminAuditLogEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

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

  const fetchAuditLogs = async (currentPage: number, currentAction: string) => {
    setLoading(true);
    setError(null);
    try {
      const authHeader = await getAuthHeader();
      const actionQuery = currentAction !== "all" ? `&action=${encodeURIComponent(currentAction)}` : "";
      const res = await fetch(`/api/admin/audit-log?page=${currentPage}&pageSize=${PAGE_SIZE}${actionQuery}`, {
        headers: authHeader,
      });

      if (!res.ok) {
        throw new Error(`Failed to load audit logs (HTTP ${res.status})`);
      }

      const data = await res.json();
      if (data.ok && Array.isArray(data.entries)) {
        setEntries(data.entries);
        setTotal(data.total ?? data.entries.length);
        setTotalPages(data.totalPages ?? Math.max(1, Math.ceil((data.total ?? data.entries.length) / PAGE_SIZE)));
      } else {
        throw new Error(data.error || "Invalid response from audit log service");
      }
    } catch (err: any) {
      setError(err?.message || "Error loading audit records");
      setEntries([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs(page, actionFilter);
  }, [page, actionFilter]);

  const handleActionFilterChange = (newAction: string) => {
    setActionFilter(newAction);
    setPage(1);
  };

  const startIdx = (page - 1) * PAGE_SIZE;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              Administrative Audit Log
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
              <Lock className="w-3 h-3 text-slate-500" />
              Append-Only
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Chronological log of administrative actions, user moderations, and privileged operations.
          </p>
        </div>

        <button
          onClick={() => fetchAuditLogs(page, actionFilter)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm self-start sm:self-auto"
          aria-label="Refresh audit logs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Database Immutability & Protection Disclosure */}
      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 shadow-sm flex items-start gap-3">
        <div className="p-2 bg-blue-100 text-blue-700 rounded-lg shrink-0 mt-0.5">
          <Shield className="w-5 h-5" />
        </div>
        <div className="text-xs text-slate-600 space-y-1">
          <div className="font-semibold text-slate-900">Database-Level Immutability Protection</div>
          <p className="leading-relaxed">
            Audit entries are designed as append-only via the PostgreSQL database trigger{" "}
            <code className="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">
              tr_prevent_admin_audit_log_mutation
            </code>{" "}
            defined in migration scripts to block <code className="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">UPDATE</code> and{" "}
            <code className="font-mono text-[11px] bg-slate-200/80 px-1 py-0.5 rounded text-slate-800">DELETE</code> operations. Live enforcement in production is pending database verification. This viewer provides read-only inspection with zero mutation controls.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-4 border border-red-200 text-sm text-red-700 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => fetchAuditLogs(page, actionFilter)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors shadow-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <button
              onClick={() => handleActionFilterChange("all")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                actionFilter === "all" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              All Actions
            </button>
            <button
              onClick={() => handleActionFilterChange("user.block")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                actionFilter === "user.block" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Blocks
            </button>
            <button
              onClick={() => handleActionFilterChange("user.unblock")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                actionFilter === "user.unblock" ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Unblocks
            </button>
          </div>
        </div>

        <div className="text-xs text-slate-500 font-medium">
          {total > 0 ? `${total.toLocaleString()} total logged events` : "0 logged events"}
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase border-b border-slate-200">
              <tr>
                <th scope="col" className="px-5 py-3.5">Timestamp</th>
                <th scope="col" className="px-5 py-3.5">Actor</th>
                <th scope="col" className="px-5 py-3.5">Action</th>
                <th scope="col" className="px-5 py-3.5">Target</th>
                <th scope="col" className="px-5 py-3.5">Reason / Details</th>
                <th scope="col" className="px-5 py-3.5 font-mono text-[11px]">Client IP Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-400 text-sm">
                    Loading audit trail...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-500 text-sm">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <p className="text-red-600 font-medium">{error}</p>
                      <button
                        onClick={() => fetchAuditLogs(page, actionFilter)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors shadow-sm"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Retry</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-400 text-sm">
                    No audit records found matching criteria.
                  </td>
                </tr>
              ) : (
                entries.map((entry) => {
                  const isBlock = entry.action === "user.block";
                  const isUnblock = entry.action === "user.unblock";
                  const reason = entry.metadata?.reason || null;

                  return (
                    <tr key={entry.id} className="hover:bg-slate-50/75 transition-colors">
                      <td className="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 font-mono">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          <span>{new Date(entry.created_at).toLocaleString()}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs font-mono text-slate-900">
                        <span className="truncate max-w-[140px] inline-block" title={entry.admin_user_id}>
                          {entry.admin_user_id}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {isBlock ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                            <ShieldAlert className="w-3 h-3 text-red-600" />
                            user.block
                          </span>
                        ) : isUnblock ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                            <ShieldCheck className="w-3 h-3 text-emerald-600" />
                            user.unblock
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                            {entry.action}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        {entry.target_id ? (
                          <div>
                            <span className="font-semibold text-slate-800">{entry.target_type || "entity"}</span>
                            <div className="text-[11px] font-mono text-slate-400 truncate max-w-[160px]" title={entry.target_id}>
                              {entry.target_id}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">N/A</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-700 max-w-xs">
                        {reason ? (
                          <span className="line-clamp-2">{reason}</span>
                        ) : entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                          <span className="font-mono text-[11px] text-slate-500 line-clamp-1">
                            {JSON.stringify(entry.metadata)}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">None recorded</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-[11px] font-mono text-slate-400 whitespace-nowrap">
                        {entry.ip_hash ? (
                          <span title={entry.ip_hash}>{entry.ip_hash.slice(0, 16)}...</span>
                        ) : (
                          <span className="italic">N/A</span>
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
        {total > 0 && (
          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              Showing <span className="font-semibold text-slate-900">{startIdx + 1}</span> to{" "}
              <span className="font-semibold text-slate-900">{Math.min(startIdx + PAGE_SIZE, total)}</span> of{" "}
              <span className="font-semibold text-slate-900">{total}</span> audit records
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
                aria-label="Previous audit log page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Previous</span>
              </button>
              <span className="font-semibold text-slate-900 px-2">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
                aria-label="Next audit log page"
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
