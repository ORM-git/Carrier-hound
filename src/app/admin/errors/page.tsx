"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";
import type { ErrorEventGroup } from "@/lib/monitoring/errorEvents";

async function getAuthHeader(): Promise<Record<string, string>> {
  try {
    const { createClient } = await import("@/lib/supabase/client");
    const { data: { session } } = await createClient().auth.getSession();
    if (session?.access_token) return { Authorization: `Bearer ${session.access_token}` };
  } catch (_) {}
  return {};
}

export default function AdminErrorsPage() {
  const [groups, setGroups] = useState<ErrorEventGroup[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/errors", { headers: await getAuthHeader() });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setGroups(data.groups);
      setTruncated(Boolean(data.truncated));
    } catch (e: any) {
      setError(e?.message || "Failed to load error events.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Errors</h1>
          <p className="text-sm text-slate-500">
            Server request errors in the last 7 days, grouped by route and stack.
            {!loading && !error && ` ${total} events in ${groups.length} groups.`}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {truncated && (
        <p className="text-xs text-amber-700">Showing the most recent 5,000 events only; older ones in the window are not counted.</p>
      )}

      <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg shadow-sm">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Error groups for the last 7 days</caption>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">Count</th>
              <th scope="col" className="px-4 py-3">Route</th>
              <th scope="col" className="px-4 py-3">Latest message</th>
              <th scope="col" className="px-4 py-3">Stack</th>
              <th scope="col" className="px-4 py-3">Last seen</th>
              <th scope="col" className="px-4 py-3">First seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && !error && groups.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">No errors in the last 7 days.</td>
              </tr>
            )}
            {groups.map((g) => (
              <tr key={`${g.route}:${g.stack_hash}`} className="align-top">
                <td className="px-4 py-3 font-semibold tabular-nums text-slate-900">{g.count}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-700 break-all">{g.route}</td>
                <td className="px-4 py-3 text-slate-700 break-words max-w-md">{g.error_message}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{g.stack_hash}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">{new Date(g.last_seen).toLocaleString()}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">{new Date(g.first_seen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
