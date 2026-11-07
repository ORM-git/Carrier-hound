/**
 * Backend sheet rank 83 (search alerts): dispatcher core.
 *
 * Gated: SEARCH_ALERTS_DISPATCH_ENABLED must be "1" or "true". When it is not,
 * dispatchSearchAlerts returns { status: "disabled" } BEFORE touching the
 * repository or the sender, so no query runs and no email or provider call
 * happens. Nothing in the repo calls this yet; wiring it to a cron route and
 * to a real mail sender is an owner step after review.
 *
 * What it does when enabled (all collaborators injected, so it is testable
 * offline):
 *   1. Requires a throttle interval (minIntervalMs). There is no default on
 *      purpose: the number is a product decision (owner to confirm). Without
 *      it the dispatcher refuses to run.
 *   2. Skips an alert whose lastSentAt is inside the throttle window.
 *   3. Skips suppressed recipients (email_suppressions).
 *   4. Dedupes per (alert, job): claims the job ids in
 *      public.search_alert_dispatches (primary key alert_id + job_id) and only
 *      sends jobs it newly claimed, so a re-run or a parallel run cannot send
 *      the same job twice for the same alert.
 *   5. If the sender throws or returns false, the claims for that send are
 *      released so the jobs are retried on the next run.
 *   6. One alert failing never stops the others (fail open per alert).
 *
 * Column mapping for public.search_alerts is NOT assumed here: the table DDL is
 * not in this repo (only the soft-delete column in 20261106h). The caller's
 * repository maps its rows to SearchAlertRecord. Owner to confirm the columns.
 */
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "alerts/searchAlertDispatcher" } });

export interface SearchAlertRecord {
  id: string;
  userId: string;
  email: string;
  lastSentAt: string | null;
}

export interface AlertJobMatch {
  id: string;
  title?: string;
  company?: string;
  url?: string;
}

export interface DispatchRepository {
  listActiveAlerts(): Promise<SearchAlertRecord[]>;
  findNewMatches(alert: SearchAlertRecord): Promise<AlertJobMatch[]>;
  isSuppressed(email: string): Promise<boolean>;
  /** Returns the subset of jobIds newly claimed for this alert (insert, ignore duplicates). */
  claimJobs(alertId: string, jobIds: string[]): Promise<string[]>;
  releaseJobs(alertId: string, jobIds: string[]): Promise<void>;
  markSent(alertId: string, sentAtIso: string): Promise<void>;
}

export type AlertSender = (alert: SearchAlertRecord, jobs: AlertJobMatch[]) => Promise<boolean>;

export interface DispatchOptions {
  env?: Record<string, string | undefined>;
  repo: DispatchRepository;
  sender: AlertSender;
  /** Minimum gap between sends for one alert. Required, no default. */
  minIntervalMs?: number;
  now?: () => number;
}

export interface DispatchSummary {
  status: "disabled" | "no-throttle-configured" | "ran";
  scanned: number;
  sent: number;
  throttled: number;
  suppressed: number;
  noNewJobs: number;
  failed: number;
}

export function isSearchAlertDispatchEnabled(env?: Record<string, string | undefined>): boolean {
  const v = env ? env.SEARCH_ALERTS_DISPATCH_ENABLED : undefined;
  return v === "1" || v === "true";
}

function emptySummary(status: DispatchSummary["status"]): DispatchSummary {
  return { status, scanned: 0, sent: 0, throttled: 0, suppressed: 0, noNewJobs: 0, failed: 0 };
}

export async function dispatchSearchAlerts(opts: DispatchOptions): Promise<DispatchSummary> {
  if (!isSearchAlertDispatchEnabled(opts.env)) return emptySummary("disabled");
  const interval = opts.minIntervalMs;
  if (typeof interval !== "number" || !isFinite(interval) || interval <= 0) {
    return emptySummary("no-throttle-configured");
  }
  const now = opts.now ? opts.now : Date.now;
  const summary = emptySummary("ran");
  let alerts: SearchAlertRecord[] = [];
  try {
    alerts = await opts.repo.listActiveAlerts();
  } catch (err) {
    log.warn("search alert list failed", { error: err });
    return summary;
  }
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    summary.scanned++;
    let claimed: string[] = [];
    try {
      if (alert.lastSentAt) {
        const last = Date.parse(alert.lastSentAt);
        if (isFinite(last) && now() - last < interval) { summary.throttled++; continue; }
      }
      if (await opts.repo.isSuppressed(alert.email)) { summary.suppressed++; continue; }
      const matches = await opts.repo.findNewMatches(alert);
      const byId: Record<string, AlertJobMatch> = {};
      const ids: string[] = [];
      for (let m = 0; m < matches.length; m++) {
        if (!byId[matches[m].id]) { byId[matches[m].id] = matches[m]; ids.push(matches[m].id); }
      }
      if (ids.length === 0) { summary.noNewJobs++; continue; }
      claimed = await opts.repo.claimJobs(alert.id, ids);
      if (claimed.length === 0) { summary.noNewJobs++; continue; }
      const jobs: AlertJobMatch[] = [];
      for (let c = 0; c < claimed.length; c++) { if (byId[claimed[c]]) jobs.push(byId[claimed[c]]); }
      const ok = await opts.sender(alert, jobs);
      if (!ok) throw new Error("sender returned false");
      summary.sent++;
      try { await opts.repo.markSent(alert.id, new Date(now()).toISOString()); }
      catch (err) { log.warn("search alert markSent failed", { alertId: alert.id, error: err }); }
    } catch (err) {
      summary.failed++;
      log.warn("search alert dispatch failed", { alertId: alert.id, error: err });
      if (claimed.length > 0) {
        try { await opts.repo.releaseJobs(alert.id, claimed); }
        catch (e2) { log.warn("search alert claim release failed", { alertId: alert.id, error: e2 }); }
      }
    }
  }
  return summary;
}

/** Supabase-backed claim/release against public.search_alert_dispatches (new table, migration 20261107b). */
export async function claimJobsInDb(supabase: any, alertId: string, jobIds: string[]): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const rows = jobIds.map((jobId) => ({ alert_id: alertId, job_id: jobId }));
  const { data, error } = await supabase
    .from("search_alert_dispatches")
    .upsert(rows, { onConflict: "alert_id,job_id", ignoreDuplicates: true })
    .select("job_id");
  if (error) throw new Error(error.message || "claim failed");
  const out: string[] = [];
  const list: any[] = data || [];
  for (let i = 0; i < list.length; i++) out.push(String(list[i].job_id));
  return out;
}

export async function releaseJobsInDb(supabase: any, alertId: string, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const { error } = await supabase
    .from("search_alert_dispatches")
    .delete()
    .eq("alert_id", alertId)
    .in("job_id", jobIds);
  if (error) throw new Error(error.message || "release failed");
}
